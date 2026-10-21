// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { ComfySdkEngine, type Engine } from '@hildegard/comfy';
import { type FakeProxy, startFakeProxy } from '@hildegard/comfy/fake';
import { type EngineState, type LoadedCatalog, loadCatalog, type ModelState } from '@hildegard/presets';
import { ComfyRuntime, detectGpu } from '@hildegard/runtime';
import { serve } from '@hono/node-server';
import { createApp, SOURCE, VERSION } from './app.ts';
import { Choir, ChoirError, tailscaleSelf } from './choir.ts';
import type { Config } from './config.ts';
import { Exporter } from './export.ts';
import { fileStore, HfLink, keychainStore, type SecretStore, secretStores } from './hf.ts';
import { ModelManager } from './models.ts';
import { nodeOnlyApp, nodeRoutes } from './node-api.ts';
import { Scheduler } from './scheduler.ts';
import { Store } from './store.ts';

type HttpServer = ReturnType<typeof serve>;

const listen = (fetch: (r: Request) => Response | Promise<Response>, hostname: string, port: number) =>
  new Promise<HttpServer>((resolve, reject) => {
    const s = serve({ fetch, hostname, port }, () => resolve(s));
    s.once('error', reject);
  });

/** Stop listening and drop open connections, so a render stream or event stream can't hold shutdown up. */
const shut = (s: HttpServer) =>
  new Promise<void>((r) => {
    s.close(() => r());
    (s as { closeAllConnections?: () => void }).closeAllConnections?.();
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
  /** The ComfyUI Hildegard runs itself, when it does. */
  runtime: ComfyRuntime | null;
  close(): Promise<void>;
}

/** Start everything: the store, the render queue, model installs, the Hugging Face link and the HTTP server. */
export async function startServer(
  config: Config,
  opts: {
    loaded?: LoadedCatalog;
    fakeTickMs?: number;
    secrets?: SecretStore;
    /** Where joined devices' keys go; the keychain by default. */
    choirSecrets?: (account: string) => SecretStore;
    onStop?: () => void;
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
              ? 'ComfyUI is starting.'
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
  const models = new ModelManager({
    comfyDir: config.comfyDir ?? join(config.dataDir, 'comfyui'),
    dataDir: config.dataDir,
    catalog,
    lock,
    tokens: hf,
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
  let gpuInfo: { name: string; vramGb: number | null } | null | undefined;
  const gpu = () => {
    if (config.fake) return { name: 'Stand-in GPU', vramGb: null };
    if (gpuInfo === undefined) {
      const g = detectGpu();
      gpuInfo = g.backend === 'cpu' ? null : { name: g.name, vramGb: g.vramGb };
    }
    return gpuInfo;
  };
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
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
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
    p === port && (WILDCARD.has(config.host) || h === config.host || (LOOPBACK_HOSTS.has(h) && !!loopback));
  const syncSharing = async (): Promise<void> => {
    const want = choir.listen();
    const h = want?.hostname.replace(/^\[|\]$/g, '') ?? '';
    const p = want ? Number(want.port || 80) : 0;
    // An https address means something in front (tailscale serve, say) forwards to this server's own port.
    const key = want && want.protocol === 'http:' && !covered(h, p) ? `${h}:${p}` : '';
    if (share?.key === key) return;
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
  await syncSharing();
  scheduler.start();

  return {
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    config,
    store,
    scheduler,
    models,
    choir,
    hf,
    runtime,
    async close() {
      closing = true;
      if (shareRetry) clearTimeout(shareRetry);
      scheduler.stop();
      await runtime?.stop();
      store.flush();
      await shut(server);
      if (loopback) await shut(loopback);
      if (share) await shut(share.server);
      await fake?.close();
    },
  };
}

export { VERSION };
