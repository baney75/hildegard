// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ComfySdkEngine, type Engine } from '@hildegard/comfy';
import { type FakeProxy, startFakeProxy } from '@hildegard/comfy/fake';
import {
  type ChoirInvite,
  type EngineState,
  type LoadedCatalog,
  loadCatalog,
  loadSafety,
  loadVoiceCatalog,
  type ModelState,
  type VoiceCatalog,
} from '@hildegard/presets';
import { ComfyRuntime, detectGpu } from '@hildegard/runtime';
import { serve } from '@hono/node-server';
import { createApp, SOURCE, VERSION } from './app.ts';
import { findChrome } from './browser.ts';
import { busyCheck, hostBusy } from './busy.ts';
import { localCapabilities, STUB_LLM } from './capabilities.ts';
import {
  type Candidate,
  Choir,
  ChoirError,
  deviceName,
  type Job,
  place,
  tailscaleSelf,
  withRemoteFit,
} from './choir.ts';
import { redeemRoutes } from './choir-redeem.ts';
import { type Config, homeId, portFile } from './config.ts';
import { ConsentSigner } from './consent.ts';
import { Exporter, makePoster, meshReviewer, reviewer } from './export.ts';
import type { FigmaFetch } from './figma.ts';
import { Grants } from './grants.ts';
import { fileStore, HfLink, keychainStore, type SecretStore, secretStores } from './hf.ts';
import { type Exec, Host, hostKey, savedDoor } from './host.ts';
import { Likeness } from './likeness.ts';
import { jsonFrom, LocalModels, type LocalModelsDeps } from './llm.ts';
import { Loops } from './loop.ts';
import { ModelManager } from './models.ts';
import { nodeOnlyApp, nodeRoutes } from './node-api.ts';
import type { FetchMetadata } from './oauth.ts';
import {
  canSandbox,
  findOpenScad,
  libraryDirs,
  listLibraries,
  type OpenScad,
  renderScad,
  sandboxKind,
} from './openscad.ts';
import { People } from './people.ts';
import { type GpuSource, gpuSourceFor, type IdleSource, Presence, systemIdle } from './presence.ts';
import { findSlicer, type Printer, PrinterProfile, type Slicer, slice } from './printer.ts';
import { MediaSigner } from './remote-mcp.ts';
import type { Reports } from './report.ts';
import { Scheduler } from './scheduler.ts';
import { importUrl } from './site-import.ts';
import { Sites } from './sites.ts';
import { Store } from './store.ts';
import {
  localLlm,
  localStt,
  localTts,
  pickTalkModel,
  stubLlm,
  TALK_VOICE,
  TalkError,
  talkReadiness,
} from './talk.ts';
import { type NodeTalkDeps, remoteLlm, remoteStt, remoteTts } from './talk-remote.ts';
import type { TalkStatus } from './talk-routes.ts';
import { runUpdate, Updates } from './update.ts';
import { llmTranslator, sniffAudio, VoiceError, VoiceStudio } from './voice.ts';
import { FakeVoiceEngine, LocalVoiceEngine, type VoiceEngine } from './voice-engine.ts';
import { VoiceModels } from './voice-models.ts';
import { webReviewer } from './web-review.ts';

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
  updates: Updates;
  choir: Choir;
  hf: HfLink;
  people: People;
  host: Host;
  /** Keys and chatbots that use the MCP from other devices. */
  grants: Grants;
  /** The language models running on this computer. */
  llm: LocalModels;
  /** Where Tailscale Serve and Funnel forward to, while that listener is open. */
  hostedUrl: () => string | null;
  /** The ComfyUI Hildegard runs itself, when it does. */
  runtime: ComfyRuntime | null;
  voice: VoiceStudio;
  voiceModels: VoiceModels;
  close(): Promise<void>;
}

/** Start everything: the store, the render queue, model installs, the Hugging Face link and the HTTP server. */
/** The engine problem while the managed ComfyUI is still loading: a wait, not a fault. */
export const COMFY_STARTING = 'ComfyUI is starting.';

/**
 * Starts Hildegard's server. When a step fails after the managed ComfyUI has started, ComfyUI is stopped again before
 * the error goes on, so nothing keeps running for a server that never came up.
 */
export async function startServer(config: Config, opts: ServeOptions = {}): Promise<Running> {
  // A front door that is on can't also be a name the Studio's own listener answers to: say so before opening anything.
  const door = savedDoor(config.dataDir);
  if (door?.on && config.allowedHosts.some((h) => hostKey(h) === hostKey(door.host)))
    throw new Error(
      `${door.host} is your front door (hildegard host --public-url), and it is also in --allow-host or HILDEGARD_ALLOWED_HOSTS, which would let this computer’s own Studio answer to it. Take it out of that list, then start Hildegard again.`,
    );
  const made: { runtime?: ComfyRuntime } = {};
  try {
    return await serveStudio(config, opts, made);
  } catch (e) {
    await made.runtime?.stop().catch(() => {});
    throw e;
  }
}

type ServeOptions = Parameters<typeof serveStudio>[1];

async function serveStudio(
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
    /** The clock for short codes and their limits: tests give a fake one. */
    now?: () => number;
    /** Sign-in attempts allowed in 15 minutes, per account and per address. */
    limits?: { perName: number; perClient: number };
    /** Reads OAuth apps' metadata documents: tests give a stand-in. */
    fetchMetadata?: FetchMetadata;
    /** How local model runtimes are reached: tests give stand-ins. */
    llm?: Partial<Omit<LocalModelsDeps, 'dataDir'>>;
    /** The token file `hf auth login` writes; tests point it elsewhere. */
    hubToken?: string;
    /** How model files download: tests give a stand-in. */
    modelFetch?: typeof fetch;
    /** The voice catalog; presets/voices.toml by default. */
    voiceCatalog?: VoiceCatalog;
    /** The voice engine: tests give a stand-in. */
    voiceEngine?: VoiceEngine;
    /** Checking for and running updates: tests give stand-ins. */
    updates?: {
      fetch?: typeof fetch;
      run?: (failed: (why: string) => void) => void;
      firstMs?: number;
      idleMs?: number;
    };
    /** The slicer for print loops (null for none); found on this computer by default. Tests give a stand-in. */
    slicer?: Slicer | null;
    /** Whether something else is using this computer, for opportunistic sharing: tests give a stand-in. */
    hostBusy?: () => Promise<boolean>;
    busyRecheckMs?: number;
    busySettleMs?: number;
    /** How opportunistic sharing sees the owner and other programs' GPU memory: tests give stand-ins. */
    presence?: { idle?: IdleSource; gpu?: GpuSource; watchMs?: number };
    /** Reports to Hildegard's makers: tests give one with a stand-in GitHub. */
    reports?: Reports;
    /** OpenSCAD for model loops sent as source (null for none); found on this computer by default. */
    openscad?: OpenScad | null;
    /** The Chromium-family browser for web loops and site imports (null for none); found by default. */
    chrome?: string | null;
    /** Figma's API, for the tests. */
    figmaFetch?: FigmaFetch;
  },
  made: { runtime?: ComfyRuntime },
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
    made.runtime = runtime;
  }
  let localEngine: Engine = new ComfySdkEngine(comfyUrl);
  let localProblem: string | null =
    comfy === 'not-installed' ? 'ComfyUI isn’t installed yet. Run `hildegard install`.' : null;

  // Choir: the devices this one joined (one of which may render), and sharing this GPU with them.
  const secretsFor = opts.choirSecrets ?? (await secretStores(join(config.dataDir, 'secrets')));
  // Looks at what opportunistic sharing can see of this computer being busy; set up once the server is ready.
  let lookBusy = async () => {};
  const choir = new Choir({
    dataDir: config.dataDir,
    secrets: secretsFor,
    now: opts.now,
    onChange: (s) => {
      store.emit({ type: 'choir', choir: s });
      route();
      store.emit({ type: 'models', models: modelStates() });
      scheduler.setOpportunistic(s.sharing.opportunistic);
      store.emit({ type: 'engine', engine: scheduler.engineState() });
      void syncSharing();
    },
  });
  // What opportunistic sharing sees beyond GPU use and load: the owner at the keyboard, and other programs holding
  // GPU memory. Hildegard's own ComfyUI and voice workers don't count.
  const presence = new Presence({
    idle: opts.presence?.idle ?? (config.fake ? undefined : systemIdle()),
    gpu: opts.presence?.gpu ?? gpuSourceFor(config.fake, runtime),
  });
  /** Note why this computer is busy for paired devices, for Settings and for the devices placing work here. */
  const setBusy = (why: string | null) => {
    const sees = presence.sees;
    if (why === choir.busy && sees === choir.seesOwner) return;
    choir.busy = why;
    choir.seesOwner = sees;
    choir.emit();
  };
  const OTHER_WORK = 'This computer is busy with other work.';
  /**
   * Whether something other than Hildegard is using this computer, asked while it renders nothing: GPU use and load
   * (busy.ts), then the owner and other programs' GPU memory.
   */
  const lookHost = async (): Promise<boolean> => {
    const base =
      opts.hostBusy ?? (config.fake ? async () => false : () => hostBusy(localGpu?.backend === 'cuda'));
    // GPU use or load first: an NVIDIA driver that isn't answering counts as busy there, and isn't asked again.
    if (await base().catch(() => true)) {
      setBusy(OTHER_WORK);
      return true;
    }
    const why = await presence.reason();
    setBusy(why);
    return why !== null;
  };
  /** This computer as a place for a job to go, when takes render on "auto"; null with no ComfyUI here. */
  const localCandidate = (): Candidate | null =>
    comfy === 'not-installed'
      ? null
      : {
          name: 'local',
          ready: localProblem === null,
          opportunistic: choir.opportunistic,
          busy: choir.opportunistic ? choir.busy : null,
          has: (m) => config.fake || !!models.states().find((x) => x.id === m)?.installed,
          fit: (m) => models.states().find((x) => x.id === m)?.fit ?? null,
          queue: scheduler.guestTakes().length,
        };
  /**
   * Send takes to the device in use: a joined one, or this computer's own ComfyUI. With "auto", `job` (the one about
   * to start) goes to the best device free for it; without one, the queue is looked at again, since a device may
   * have come free.
   */
  const route = (job?: Job) => {
    const auto = choir.state().use === 'auto';
    scheduler.setAuto(auto);
    if (auto && job) choir.pick(place(job, localCandidate(), choir.candidates()));
    const remote = choir.activeEngine();
    if (remote) {
      scheduler.setEngine(remote, 'remote');
      scheduler.setProblem(choir.active()?.problem ?? null);
    } else {
      scheduler.setEngine(localEngine, comfy);
      scheduler.setProblem(localProblem);
    }
    if (auto && !job) scheduler.pump();
  };
  const scheduler = new Scheduler({
    store,
    engine: choir.activeEngine() ?? localEngine,
    catalog,
    mediaDir,
    fake: config.fake,
    comfy: choir.activeEngine() ? 'remote' : comfy,
    onEngine: (engineState) => store.emit({ type: 'engine', engine: engineState }),
    onGuests: (guests) => store.emit({ type: 'guests', guests }),
    poster: (video, out) => makePoster(config.dataDir, video, out),
    // Voice models let go of the GPU before a render needs it.
    beforeRender: () => voiceEngine.release(),
    // Asked only when this computer shares its GPU opportunistically. The fake GPU has no one else to yield to.
    hostBusy: lookHost,
    choose: (job) => route(job),
    busyRecheckMs: opts.busyRecheckMs,
    busySettleMs: opts.busySettleMs,
  });
  scheduler.setOpportunistic(choir.opportunistic);
  route();
  await runtime?.start();
  const secrets =
    opts.secrets ?? (await keychainStore()) ?? fileStore(join(config.dataDir, 'secrets', 'huggingface.json'));
  const hf = new HfLink({
    store: secrets,
    clientId: config.hfClientId,
    onChange: (s) => store.emit({ type: 'hf', hf: s }),
    hubToken: opts.hubToken,
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
    fetch: opts.modelFetch,
  });
  /** Rendering on a joined device, its models are the ones that count, so nothing asks to download them here. */
  const modelStates = (): ModelState[] => {
    // With "auto", a model counts as installed when any device takes can go to has it.
    if (choir.state().use === 'auto') {
      // Only devices a take could be placed on: one on "auto" itself never is (see Choir.candidates).
      const places = new Set(
        choir
          .candidates()
          .filter((x) => x.ready)
          .map((x) => x.name),
      );
      const devices = choir.state().devices.filter((x) => places.has(x.name));
      return withRemoteFit(models.states(), devices);
    }
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
        fitWhy: d.fitWhy[m.id] ?? (d.fit[m.id] === 'no' ? 'memory' : null),
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
    // Made further down, and only asked once requests arrive.
    updates: () => updates,
    // The claim looked up every 30 s: paired devices give /info 4 s, and finding language models can take longer.
    capabilities: async () => choir.capabilities ?? capabilities(),
    // Made further down too: Talk's own steps, lent to paired devices.
    talk: () => nodeTalk,
  });

  // People who sign in from other devices, and the link they reach this Hildegard at.
  const people = new People({ dataDir: config.dataDir });
  const grants = new Grants({ dataDir: config.dataDir, person: (id) => people.get(id) });
  const signer = new MediaSigner({ dataDir: config.dataDir });
  const llm = new LocalModels({ dataDir: config.dataDir, secrets: secretsFor, ...opts.llm });

  // Voice: its own models and Python workers; it shares the GPU with renders through the scheduler.
  const voiceEngine: VoiceEngine =
    opts.voiceEngine ??
    (config.fake ? new FakeVoiceEngine() : new LocalVoiceEngine({ dataDir: config.dataDir }));
  const voiceCatalog = opts.voiceCatalog ?? loadVoiceCatalog(undefined, lock);
  const voiceModels = new VoiceModels({
    dataDir: config.dataDir,
    catalog: voiceCatalog,
    lock,
    tokens: hf,
    safety: loadSafety(),
    gpu: localGpu,
    envReady: (env) => voiceEngine.ready(env),
    onChange: (models) => store.emit({ type: 'voice-models', models }),
    fetch: opts.modelFetch,
    // With the stand-in GPU and its stand-in voice engine, there are no weights to fetch.
    standIn: config.fake && !opts.voiceEngine,
  });
  const consentSigner = new ConsentSigner(config.dataDir);
  const voice = new VoiceStudio({
    dataDir: config.dataDir,
    mediaDir,
    catalog: voiceCatalog,
    models: voiceModels,
    engine: voiceEngine,
    // Hold the GPU, then ask ComfyUI to unload what it kept from the last render.
    lease: async () => {
      const release = await scheduler.lease();
      const comfyUrl = runtime?.comfyUrl();
      if (comfyUrl)
        await fetch(`${comfyUrl}/free`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unload_models: true, free_memory: true }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      return release;
    },
    safety: loadSafety(),
    signer: consentSigner,
    emit: (e) => store.emit(e),
    translate: llmTranslator(llm, jsonFrom),
    device: () => hostname(),
  });
  // What this computer can do for Talk and rendering: paired devices read it, and so does the Studio, in choir state.
  const capabilities = () =>
    localCapabilities({
      fake: config.fake,
      gpu,
      voice: { catalog: voiceCatalog, usable: (m) => voiceModels.usable(m) },
      llm: () => llm.state(),
    });
  const lookCapabilities = async () => {
    const c = await capabilities().catch(() => null);
    if (c && JSON.stringify(c) !== JSON.stringify(choir.capabilities)) {
      choir.capabilities = c;
      // Only the Studio's view changes: nothing about where takes go or what is shared.
      store.emit({ type: 'choir', choir: choir.state() });
    }
  };
  void lookCapabilities();
  setInterval(() => void lookCapabilities(), 30_000).unref();

  // Talk: every step on this computer for now; each is a port another device can fill later.
  const voiceMedia = join(mediaDir, 'voice');
  const talk = {
    talk: {
      stt: localStt(voice, { fake: config.fake }),
      llm: config.fake ? stubLlm() : localLlm(llm),
      tts: localTts(voice),
    },
    files: {
      save: async (bytes: Uint8Array) => join(voiceMedia, (await voice.upload(bytes)).name),
      // Only a Talk upload: a consent recording or a voice reference is refused here, before any step runs anywhere.
      find: (uploadId: string) => voice.uploadFile(uploadId),
      url: (path: string) => (dirname(path) === voiceMedia ? `/media/voice/${basename(path)}` : null),
      read: async (path: string) => new Uint8Array(await readFile(path)),
    },
    status: async (): Promise<TalkStatus> => {
      const caps = await capabilities();
      const answers = config.fake
        ? { runtime: STUB_LLM.runtime, model: STUB_LLM.model }
        : await pickTalkModel(llm)
            .then((p) => (p ? { runtime: p.endpoint.runtime, model: p.model } : null))
            .catch(() => null);
      return {
        ...talkReadiness({
          engine: voiceEngine.ready('speech'),
          caps,
          catalog: voiceCatalog,
          usable: (m) => voiceModels.usable(m),
        }),
        fake: config.fake,
        llm: answers,
        capabilities: caps,
        primary: choir.primary,
      };
    },
  };
  // A recording or an answer kept as a voice upload without decoding it, so a computer whose turns run on another
  // device needs no voice engine of its own.
  const keepAudio = async (bytes: Uint8Array) => {
    const kind = sniffAudio(bytes);
    if (!kind) throw new VoiceError(415, 'type', 'Use a WAV, MP3, M4A, OGG, FLAC or WebM recording.');
    const path = join(voiceMedia, `${createHash('sha256').update(bytes).digest('hex')}.${kind}`);
    mkdirSync(voiceMedia, { recursive: true });
    if (!existsSync(path)) writeFileSync(path, bytes);
    return path;
  };
  const onDevice = (name: string) => {
    const peer = choir.peer(name);
    if (!peer) throw new TalkError(404, 'device', `This computer hasn’t joined a device called ${name}.`);
    const caps = peer.device.capabilities;
    const voiceModel = voiceCatalog.voices.find((v) => v.id === TALK_VOICE)?.model;
    if (!peer.device.online)
      throw new TalkError(
        409,
        'device',
        `${name} isn’t answering right now. ${peer.device.problem ?? ''}`.trim(),
      );
    if (!caps?.stt.length || !caps.llm.length || !(voiceModel && caps.tts.includes(voiceModel)))
      throw new TalkError(409, 'device', `${name} can’t hear, answer and speak for Talk yet.`);
    const o = { url: peer.url, token: peer.token, name };
    return {
      talk: { stt: remoteStt(o), llm: remoteLlm(o), tts: remoteTts({ ...o, save: keepAudio }) },
      files: { ...talk.files, save: keepAudio },
    };
  };
  const nodeTalk: NodeTalkDeps = {
    ...talk.talk,
    tts: (v) => localTts(voice, v),
    voices: () => voiceCatalog.voices.map((v) => v.id),
    files: talk.files,
    safety: loadSafety(),
  };
  const host = new Host({
    dataDir: config.dataDir,
    port: () => port,
    hostPort: () => hostedPort,
    reserved: () => config.allowedHosts,
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
  // A release runs from its `hildegard` command, which says where its script is; a checkout has none, and updates with
  // git. The port is the one this server listens on, known once it does.
  const entry = process.env.HILDEGARD_ENTRY;
  let listening = config.port;
  const updates = new Updates({
    dataDir: config.dataDir,
    version: VERSION,
    updatable: !!opts.updates?.run || !!entry,
    busy: () =>
      [...store.takes.values(), ...store.stills.values()].some(
        (t) => t.status === 'queued' || t.status === 'running',
      ) ||
      // A paired render waiting here would be canceled by the restart, so it holds the update until it's done.
      scheduler.guestTakes().length > 0 ||
      models.states().some((m) => m.downloading) ||
      exporter.list().some((e) => e.status === 'running') ||
      voice.state().jobs.some((j) => j.status === 'queued' || j.status === 'running') ||
      voiceModels.states().some((m) => m.downloading),
    run:
      opts.updates?.run ??
      ((failed) => {
        const logs = join(config.dataDir, 'logs');
        mkdirSync(logs, { recursive: true });
        runUpdate(
          entry!,
          ['--data', config.dataDir, '--port', String(listening)],
          join(logs, 'update.log'),
          process.env,
          failed,
        );
      }),
    onChange: (update) => store.emit({ type: 'update', update }),
    fetch: opts.updates?.fetch,
    firstMs: opts.updates?.firstMs,
    idleMs: opts.updates?.idleMs,
  });
  const printer = new PrinterProfile(config.dataDir);
  const pickSlicer = (p: Printer) => (opts.slicer === undefined ? findSlicer(p) : opts.slicer);
  // The browser that checks web pages and imports sites; tests can say there is none.
  const chrome = opts.chrome === undefined ? findChrome() : opts.chrome;
  // Looked for each time, so OpenSCAD installed while Hildegard runs is used without a restart.
  const openscad = () => (opts.openscad === undefined ? findOpenScad() : opts.openscad);
  // Hidden from OpenSCAD: the owner's home and Hildegard's data, but for the round and the libraries.
  const scadHidden = [homedir(), config.dataDir];
  const app = createApp({
    lookBusy: () => lookBusy(),
    tellPresence: async (away, minutes) => {
      presence.tell(away, minutes);
      // Coming back stops a paired render now, not at the next look.
      if (choir.opportunistic) {
        if (!away && scheduler.guestOnGpu) scheduler.interruptGuest();
        if (scheduler.idle) await lookHost();
        else setBusy(await presence.reason());
      }
    },
    updates,
    voice: { studio: voice, models: voiceModels, publicKey: consentSigner.publicKey },
    talk: { ...talk, onDevice, primary: () => choir.primary },
    likeness: new Likeness(config.dataDir),
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
    home: homeId(config.dataDir),
    people,
    host,
    limits: opts.limits,
    grants,
    signer,
    fetchMetadata: opts.fetchMetadata,
    llm,
    review: reviewer(config.dataDir),
    loops: new Loops({
      dir: join(mediaDir, 'loops'),
      reviewModel: meshReviewer(config.dataDir),
      reviewMedia: reviewer(config.dataDir),
      reviewWeb: webReviewer(chrome),
      renderScad: async (dir, main, out, { part, budget, requireSandbox }) => {
        const o = openscad();
        return o
          ? renderScad(o, dir, main, out, libraryDirs(config.dataDir), {
              part,
              budget,
              hide: scadHidden,
              requireSandbox,
            })
          : null;
      },
      scadSandboxed: () => {
        const o = openscad();
        return !!o && canSandbox(o.path, scadHidden);
      },
      printer: () => printer.get(),
      slice: (files, keep) => {
        const p = printer.get();
        const slicer = pickSlicer(p);
        return slicer ? slice(slicer, p, files, keep) : Promise.resolve(null);
      },
    }),
    printer,
    slicer: pickSlicer,
    reports: opts.reports,
    gpu: localGpu ? `${localGpu.name}${localGpu.vramGb ? `, ${localGpu.vramGb} GB` : ''}` : null,
    openscad: () => {
      const o = openscad();
      const dirs = libraryDirs(config.dataDir);
      return {
        found: o,
        libraryDirs: dirs,
        libraries: listLibraries(dirs).map((l) => l.name),
        sandbox: o ? sandboxKind(o.path, scadHidden) : null,
      };
    },
    sites: {
      store: new Sites(join(config.dataDir, 'sites')),
      secrets: secretsFor,
      importUrl: chrome ? (url: string) => importUrl(url, chrome) : undefined,
      figmaFetch: opts.figmaFetch,
    },
    choir,
    modelStates,
    node,
    tailnet: () => {
      const ts = tailnet();
      return ts ? `http://${ts.ip.includes(':') ? `[${ts.ip}]` : ts.ip}:${port}` : null;
    },
    clock: opts.now,
    invite: async (url, key, long, short) => {
      const ts = tailnet();
      const target = url ?? (ts ? `http://${ts.ip.includes(':') ? `[${ts.ip}]` : ts.ip}:${port}` : null);
      if (!target)
        throw new ChoirError(
          409,
          'Tailscale isn’t running on this computer, so other devices can’t reach it. Start Tailscale, or give the address they reach it at: `hildegard choir invite --url http://<address>:<port>`.',
        );
      {
        const t = new URL(target);
        const h = t.hostname.replace(/^\[|\]$/g, '');
        if (t.protocol === 'http:' && !isIP(h) && covered(h, Number(t.port || 80)))
          throw new ChoirError(
            400,
            `Share at this computer’s Tailscale IP (http://<ip>:${port}) or an https name in front of it, not ${t.host}: other devices couldn’t redeem a code there.`,
          );
      }
      const name = ts?.name ?? hostname();
      let r: ChoirInvite;
      if (key !== undefined) {
        const k = choir.invite(target, name, key);
        r = { ...k, name: deviceName(name), short: null, command: null };
      } else {
        const k = choir.shortInvite(target, name, { long, short });
        r = {
          ...k,
          command: k.short ? `hildegard choir join ${k.short.code} --url ${k.url}` : null,
        };
      }
      await syncSharing();
      return r;
    },
  });
  const server = await listen(app.fetch, config.host, config.port);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const hostedPort = config.hostPort ?? port + 1;
  writeFileSync(portFile(config.dataDir), `${JSON.stringify({ port })}\n`);
  listening = port;
  // An update that restarted Hildegard is over once it answers again.
  rmSync(join(config.dataDir, 'updating'), { force: true });
  const bracketed = config.host.includes(':') ? `[${config.host}]` : config.host;
  // Bound to one address (a Tailscale IP, say), it still answers on loopback: the CLI and linked AI apps use that.
  const loopback = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(config.host)
    ? null
    : await listen(app.fetch, '127.0.0.1', port);
  // Only once everything it reports to exists and the server answers. A download that fails shows on the model and
  // never stops Hildegard.
  models.completeSafety().catch(() => {});
  updates.start();

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
  // An invite nobody used leaves sharing on only until its last code lapses: look again then, so the listener closes
  // and the Studio stops saying "Sharing".
  let lapseTimer: NodeJS.Timeout | null = null;
  const watchLapse = () => {
    if (lapseTimer) clearTimeout(lapseTimer);
    lapseTimer = null;
    const ms = choir.lapsesIn();
    if (ms === null || closing) return;
    lapseTimer = setTimeout(
      () => {
        lapseTimer = null;
        // Nothing awaits this timer, so a failed sync must not become an unhandled rejection that ends the process.
        void syncSharing()
          .then(() => choir.emit())
          .catch((e: Error) => {
            choir.sharingProblem = `Sharing couldn’t update: ${e.message}`;
            choir.emit();
          });
      },
      Math.min(ms, 2 ** 31 - 1),
    );
    lapseTimer.unref();
  };
  const syncSharingNow = async (): Promise<void> => {
    watchLapse();
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
      share = {
        key,
        server: await listen(nodeOnlyApp(node, () => [hostHeader], redeemRoutes(choir)).fetch, h, p),
      };
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

  // The fake GPU says it can see GPU use, like an NVIDIA computer would.
  lookBusy = () =>
    (config.fake
      ? Promise.resolve('gpu+load' as const)
      : busyCheck(undefined, undefined, localGpu?.backend === 'cuda')
    ).then((b) => {
      if (closing || b === choir.busyCheck) return;
      choir.busyCheck = b;
      choir.emit();
    });
  void lookBusy();
  // A driver can stop answering later (an update without a restart): look again now and then, so Settings says so.
  const busyLook = setInterval(() => choir.opportunistic && void lookBusy(), 5 * 60_000);
  busyLook.unref?.();
  // Opportunistic: look every few seconds at whether someone else wants this computer. The owner coming back, or
  // another program taking GPU memory, stops a paired device's render at once (it goes back in line), and paired
  // devices placing work see it's busy. GPU use and load are only asked while nothing renders here.
  let watching = false;
  const watch = setInterval(async () => {
    if (watching || closing) return;
    if (!choir.opportunistic) return setBusy(null);
    watching = true;
    try {
      if (scheduler.idle) await lookHost();
      else {
        const why = await presence.reason();
        if (why && scheduler.guestOnGpu) scheduler.interruptGuest();
        // A render here shows as GPU use; only the owner and other programs say anything now.
        if (why || choir.busy !== OTHER_WORK) setBusy(why);
      }
    } finally {
      watching = false;
    }
  }, opts.presence?.watchMs ?? 5000);
  watch.unref?.();
  // With "auto", every joined device is asked how it is now and then, so takes go to whichever is free.
  const fleet = setInterval(() => {
    if (choir.state().use === 'auto') void choir.refresh().catch(() => {});
  }, 15_000);
  fleet.unref?.();
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
    grants,
    llm,
    hostedUrl: () => (hosted ? `http://127.0.0.1:${hostedPort}` : null),
    updates,
    runtime,
    voice,
    voiceModels,
    async close() {
      closing = true;
      clearInterval(busyLook);
      clearInterval(watch);
      clearInterval(fleet);
      updates.stop();
      await syncingHost;
      if (shareRetry) clearTimeout(shareRetry);
      if (lapseTimer) clearTimeout(lapseTimer);
      scheduler.stop();
      voice.close();
      await voiceEngine.close();
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
