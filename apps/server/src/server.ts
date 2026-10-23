// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ComfySdkEngine, type Engine } from '@hildegard/comfy';
import { type FakeProxy, startFakeProxy } from '@hildegard/comfy/fake';
import { type EngineState, type LoadedCatalog, loadCatalog, type ModelState } from '@hildegard/presets';
import { ComfyRuntime, detectGpu } from '@hildegard/runtime';
import { serve } from '@hono/node-server';
import { createApp, SOURCE, VERSION } from './app.ts';
import { Choir, ChoirError, tailscaleSelf } from './choir.ts';
import { type Config, portFile } from './config.ts';
import { Exporter, makePoster } from './export.ts';
import { fileStore, HfLink, keychainStore, type SecretStore, secretStores } from './hf.ts';
import { type Exec, Host } from './host.ts';
import { ModelManager } from './models.ts';
import { nodeOnlyApp, nodeRoutes } from './node-api.ts';
import { People } from './people.ts';
import { Scheduler } from './scheduler.ts';
import { Store } from './store.ts';

type HttpServer = ReturnType<typeof serve>;

// biome-ignore lint/suspicious/noExplicitAny: the node server hands each request its bindings, typed by Hono.
type Fetch = (r: Request, env?: any) => Response | Promise<Response>;
const listen = (fetch: Fetch, hostname: string, port: number) =>
  new Promise<HttpServer>((resolve, reject) => {
    const s = serve({ fetch, hostname, port }, () => resolve(s));
    s.once('error', reject);
  });

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const WILDCARD = new Set(['0.0.0.0', '::']);

export interface Running {
  url: string;
  config: Config;
  store: Store;
  scheduler: Scheduler;
  models: ModelManager;
  choir: Choir;
  hf: HfLink;
  people: People;
  host: Host;
  /** Where Tailscale Serve and Funnel forward to, while that listener is open. */
  hostedUrl: () => string | null;
  /** The ComfyUI Hildegard runs itself, when it does. */
  runtime: ComfyRuntime | null;
  close(): Promise<void>;
}

/** Start everything: the store, the render queue, model installs, the Hugging Face link and the HTTP server. */
/** The engine problem while the managed ComfyUI is still loading: a wait, not a fault. */
export const COMFY_STARTING = 'ComfyUI is starting.';

export async function startServer(
  config: Config,
  opts: {
    loaded?: LoadedCatalog;
    fakeTickMs?: number;
    secrets?: SecretStore;
    /** Where joined devices' keys go; the keychain by default. */
    choirSecrets?: (account: string) => SecretStore;
    onStop?: () => void;
    /** Runs `tailscale`: tests give a stand-in. */
    exec?: Exec;
    /** Sign-in attempts allowed in 15 minutes, per account and per address. */
    limits?: { perName: number; perClient: number };
  } = {},
): Promise<Running> {
  const { catalog, lock } = opts.loaded ?? loadCatalog();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const mediaDir = join(config.dataDir, 'media');
  mkdirSync(mediaDir, { recursive: true });

  let fake: FakeProxy | null = null;
  let comfyUrl = config.comfyUrl;
  if (config.fake) {
    fake = await startFakeProxy({
      tickMs: opts.fakeTickMs ?? (Number(process.env.HILDEGARD_FAKE_TICK_MS) || 120),
    });
    comfyUrl = fake.url;
  }

  const store = new Store(config.dataDir);
  const comfy: EngineState['comfy'] = config.fake
    ? 'fake'
    : config.comfyExternal
      ? 'external'
      : ComfyRuntime.installed(config.dataDir)
        ? 'managed'
        : 'not-installed';
  // The managed ComfyUI starts in the background; the engine follows it to whatever ports it gets.
  let runtime: ComfyRuntime | null = null;
  if (comfy === 'managed') {
    runtime = new ComfyRuntime({
      dataDir: config.dataDir,
      onChange: (s) => {
        if (s.url) localEngine = new ComfySdkEngine(s.url);
        localProblem =
          s.status === 'failed' || s.status === 'restarting'
            ? s.error
            : s.status === 'starting'
              ? COMFY_STARTING
              : null;
        route();
      },
    });
  }
  let localEngine: Engine = new ComfySdkEngine(comfyUrl);
  let localProblem: string | null =
    comfy === 'not-installed' ? 'ComfyUI isn’t installed yet. Run `hildegard install`.' : null;

  // Choir: the devices this one joined (one of which may render), and sharing this GPU with them.
  const choir = new Choir({
    dataDir: config.dataDir,
    secrets: opts.choirSecrets ?? (await secretStores(join(config.dataDir, 'secrets'))),
    onChange: (s) => {
      store.emit({ type: 'choir', choir: s });
      route();
      store.emit({ type: 'models', models: modelStates() });
      store.emit({ type: 'engine', engine: scheduler.engineState() });
      void syncSharing();
    },
  });
  /** Send takes to the device in use: a joined one, or this computer's own ComfyUI. */
  const route = () => {
    const remote = choir.activeEngine();
    if (remote) {
      scheduler.setEngine(remote, 'remote');
      scheduler.setProblem(choir.active()?.problem ?? null);
    } else {
      scheduler.setEngine(localEngine, comfy);
      scheduler.setProblem(localProblem);
    }
  };
  const scheduler = new Scheduler({
    store,
    engine: choir.activeEngine() ?? localEngine,
    catalog,
    mediaDir,
    fake: config.fake,
    comfy: choir.activeEngine() ? 'remote' : comfy,
    onEngine: (engineState) => store.emit({ type: 'engine', engine: engineState }),
    poster: (video, out) => makePoster(config.dataDir, video, out),
  });
  route();
  await runtime?.start();
  const secrets =
    opts.secrets ?? (await keychainStore()) ?? fileStore(join(config.dataDir, 'secrets', 'huggingface.json'));
  const hf = new HfLink({
    store: secrets,
    clientId: config.hfClientId,
    onChange: (s) => store.emit({ type: 'hf', hf: s }),
  });
  const localGpu = config.fake ? null : detectGpu();
  const models = new ModelManager({
    comfyDir: config.comfyDir ?? join(config.dataDir, 'comfyui'),
    dataDir: config.dataDir,
    catalog,
    lock,
    tokens: hf,
    gpu: localGpu,
    onChange: () => store.emit({ type: 'models', models: modelStates() }),
  });
  /** Rendering on a joined device, its models are the ones that count, so nothing asks to download them here. */
  const modelStates = (): ModelState[] => {
    const d = choir.active();
    if (!d) return models.states();
    return catalog.models.map((m) => {
      const there = d.models.includes(m.id);
      return {
        id: m.id,
        installed: there,
        missingBytes: there ? 0 : [...m.files, ...Object.values(m.loras)].reduce((n, f) => n + f.size, 0),
        downloading: null,
        gated: m.gated,
        licenseAccepted: there,
        // How it fits the GPU it would render on.
        fit: d.fit[m.id] ?? null,
        error: there || !d.version ? null : `Not installed on ${d.name}. Install it there.`,
      };
    });
  };

  // This computer on its tailnet: asking Tailscale takes a moment, so the answer is kept briefly.
  let tailnetAt = 0;
  let tailnetSelf: ReturnType<typeof tailscaleSelf> = null;
  const tailnet = () => {
    if (Date.now() - tailnetAt > 15_000) {
      tailnetSelf = tailscaleSelf();
      tailnetAt = Date.now();
    }
    return tailnetSelf;
  };

  // What this computer tells devices paired with it.
  const gpu = () =>
    config.fake
      ? { name: 'Stand-in GPU', vramGb: null }
      : localGpu && localGpu.backend !== 'cpu'
        ? { name: localGpu.name, vramGb: localGpu.vramGb }
        : null;
  const node = nodeRoutes({
    choir,
    scheduler,
    catalog,
    dataDir: config.dataDir,
    version: VERSION,
    gpu,
    models: () => models.states(),
    fake: config.fake,
  });

  // People who sign in from other devices, and the link they reach this Hildegard at.
  const people = new People({ dataDir: config.dataDir });
  const host = new Host({
    dataDir: config.dataDir,
    port: () => port,
    hostPort: () => hostedPort,
    run: opts.exec,
    owner: () => people.hasOwner(),
    onChange: (h) => {
      store.emit({ type: 'host', host: h });
      void syncHost();
    },
  });

  const exporter = new Exporter({
    store,
    catalog,
    mediaDir,
    dataDir: config.dataDir,
    credit: `Made with Hildegard ${VERSION} (${SOURCE.url}).`,
    onChange: (e) => store.emit({ type: 'export', export: e }),
  });
  const app = createApp({
    exporter,
    config,
    store,
    scheduler,
    catalog,
    models,
    hf,
    mediaDir,
    onStop: opts.onStop,
    url: `http://127.0.0.1:${config.port}`,
    people,
    host,
    limits: opts.limits,
    choir,
    modelStates,
    node,
    tailnet: () => {
      const ts = tailnet();
      return ts ? `http://${ts.ip.includes(':') ? `[${ts.ip}]` : ts.ip}:${port}` : null;
    },
    invite: async (url) => {
      const ts = tailnet();
      const target = url ?? (ts ? `http://${ts.ip.includes(':') ? `[${ts.ip}]` : ts.ip}:${port}` : null);
      if (!target)
        throw new ChoirError(
          409,
          'Tailscale isn’t running on this computer, so other devices can’t reach it. Start Tailscale, or give the address they reach it at: `hildegard choir invite --url http://<address>:<port>`.',
        );
      const r = choir.invite(target, ts?.name ?? hostname());
      await syncSharing();
      return r;
    },
  });
  const server = await listen(app.fetch, config.host, config.port);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const hostedPort = config.hostPort ?? port + 1;
  writeFileSync(portFile(config.dataDir), `${JSON.stringify({ port })}\n`);
  const bracketed = config.host.includes(':') ? `[${config.host}]` : config.host;
  // Bound to one address (a Tailscale IP, say), it still answers on loopback: the CLI and linked AI apps use that.
  const loopback = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(config.host)
    ? null
    : await listen(app.fetch, '127.0.0.1', port);

  // Sharing this GPU: listen on the address paired devices reach (the Tailscale IP) with /api/node/* only, unless
  // the main listener already covers it. Keep trying while that address isn't up yet, such as before Tailscale is.
  let share: { server: HttpServer; key: string } | null = null;
  let shareRetry: NodeJS.Timeout | null = null;
  let closing = false;
  const covered = (h: string, p: number) =>
    p === port &&
    (WILDCARD.has(config.host) ||
      h === config.host ||
      (LOOPBACK_HOSTS.has(h) && !!loopback) ||
      (!!bound && bound.key === `${h}:${p}`));
  // One at a time: an invite both fires onChange and syncs itself, and two listens racing on one port would leave
  // the loser's EADDRINUSE standing as the sharing problem.
  let syncingSharing: Promise<void> = Promise.resolve();
  const syncSharing = (): Promise<void> => {
    syncingSharing = syncingSharing.then(syncSharingNow, syncSharingNow);
    return syncingSharing;
  };
  const syncSharingNow = async (): Promise<void> => {
    const want = choir.listen();
    const h = want?.hostname.replace(/^\[|\]$/g, '') ?? '';
    const p = want ? Number(want.port || 80) : 0;
    // An https address means something in front (tailscale serve, say) forwards to this server's own port.
    const key = want && want.protocol === 'http:' && !covered(h, p) ? `${h}:${p}` : '';
    if (share?.key === key) {
      if (share && choir.sharingProblem) {
        choir.sharingProblem = null;
        choir.emit();
      }
      return;
    }
    if (share) {
      const old = share.server;
      share = null;
      await shut(old);
    }
    if (shareRetry) clearTimeout(shareRetry);
    shareRetry = null;
    if (!key || closing) {
      if (choir.sharingProblem) {
        choir.sharingProblem = null;
        choir.emit();
      }
      return;
    }
    const hostHeader = h.includes(':') ? `[${h}]` : h;
    try {
      share = { key, server: await listen(nodeOnlyApp(node, () => [hostHeader]).fetch, h, p) };
      if (choir.sharingProblem) {
        choir.sharingProblem = null;
        choir.emit();
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const problem =
        code === 'EADDRINUSE'
          ? `Something else is using port ${p} on ${h}.`
          : `This computer doesn’t have the address ${h} right now. Is Tailscale up? Hildegard keeps trying.`;
      if (choir.sharingProblem !== problem) {
        choir.sharingProblem = problem;
        choir.emit();
      }
      shareRetry = setTimeout(() => void syncSharing(), 15_000);
      shareRetry.unref();
    }
  };
  // Host mode: the listener Tailscale forwards to, where every request signs in, and, for an `address` host, the
  // full Studio on this computer's Tailscale address. Both follow the host state as it changes.
  let hosted: HttpServer | null = null;
  let bound: { server: HttpServer; key: string } | null = null;
  let syncingHost: Promise<void> = Promise.resolve();
  const syncHost = (): Promise<void> => {
    syncingHost = syncingHost.then(async () => {
      const cur = host.current();
      const wantHosted = !closing && (config.hostPort !== null || (cur.on && cur.via !== 'address'));
      if (wantHosted && !hosted) {
        try {
          hosted = await listen((r, env) => app.fetch(r, { ...env, hosted: true }), '127.0.0.1', hostedPort);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          host.setProblem(
            code === 'EADDRINUSE'
              ? `Something else is using port ${hostedPort}, where the link leads. Start Hildegard with --host-port and another port.`
              : (e as Error).message,
          );
        }
      } else if (!wantHosted && hosted) {
        const old = hosted;
        hosted = null;
        await shut(old);
      }
      const a = cur.on && cur.via === 'address' && !closing ? cur.address : null;
      const key = a && !covered(a, port) ? `${a}:${port}` : '';
      if (bound?.key === key) return;
      if (bound) {
        const old = bound.server;
        bound = null;
        await shut(old);
      }
      if (key && a) {
        try {
          bound = { key, server: await listen(app.fetch, a, port) };
          host.setProblem(null);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          host.setProblem(
            code === 'EADDRINUSE'
              ? `Something else is using port ${port} on ${a}.`
              : `This computer doesn’t have the address ${a} right now. Is Tailscale up?`,
            'tailscale up',
          );
        }
      }
      // The paired-device listener may now be covered by this one, or no longer.
      await syncSharing();
    });
    return syncingHost;
  };
  await syncSharing();
  await syncHost();
  // Tailscale is asked in the background: it can take a few seconds, and nothing here waits on it.
  void host.resume();
  scheduler.start();

  return {
    url: `http://${bracketed === '0.0.0.0' ? '127.0.0.1' : bracketed}:${port}`,
    config,
    store,
    scheduler,
    models,
    choir,
    hf,
    people,
    host,
    hostedUrl: () => (hosted ? `http://127.0.0.1:${hostedPort}` : null),
    runtime,
    async close() {
      closing = true;
      await syncingHost;
      if (shareRetry) clearTimeout(shareRetry);
      scheduler.stop();
      await runtime?.stop();
      store.flush();
      await Promise.all(
        [server, loopback, share?.server, hosted, bound?.server].map((s) => (s ? shut(s) : null)),
      );
      await fake?.close();
    },
  };
}

/** Stops listening and ends every live connection, so an open Studio tab's event stream can't keep the process up. */
function shut(s: ReturnType<typeof serve>): Promise<void> {
  const done = new Promise<void>((r) => s.close(() => r()));
  if ('closeAllConnections' in s) s.closeAllConnections();
  return done;
}

export { VERSION };
