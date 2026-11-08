// SPDX-License-Identifier: Apache-2.0
/** Shapes the Studio UI, the MCP server and the local server share. Plain data, safe to send as JSON. */
import type { ShotRequest } from './schema.ts';
import type { ConsentSessionView, Voice, VoiceJob, VoiceModelState } from './voice.ts';

export type TakeStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';
/** Force now jumps the queue; studio work comes before agent work. */
export type Priority = 'forced' | 'interactive' | 'agent';

export interface TakeError {
  code: string;
  /** One plain sentence, shown on the card. */
  message: string;
  /** What to do about it. */
  hint: string;
  detail?: string;
}

export interface Take {
  id: string;
  shotId: string;
  projectId: string;
  /** 1-based number within the shot. */
  number: number;
  status: TakeStatus;
  priority: Priority;
  /** Who asked: the Studio, or an agent by name. */
  source: { kind: 'studio' } | { kind: 'agent'; name: string };
  /** The person signed in from another device who asked for it; absent when it came from this computer. */
  by?: { id: string; name: string };
  request: ShotRequest;
  seed: number;
  model: string;
  summary: string;
  prompt: string;
  width: number;
  height: number;
  seconds: number;
  fps: number;
  quality: 'draft' | 'final';
  queuePosition: number | null;
  progress: { value: number; step: number | null; steps: number | null } | null;
  /** Bumped whenever a new preview frame arrives. */
  previewVersion: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Wall time of the render itself. */
  renderMs: number | null;
  error: TakeError | null;
  kept: boolean;
  /** Set when the take is done. */
  video: string | null;
  poster: string | null;
  /** Bytes of the finished video. */
  bytes: number | null;
}

export interface Shot {
  id: string;
  projectId: string;
  title: string;
  prompt: string;
  createdAt: string;
  takeIds: string[];
}

export interface Project {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  shotIds: string[];
  /** The person, signed in from another device, whose film it is; absent for the owner's own films. */
  owner?: string;
}

/** The angle a character reference shows. */
export type CharacterView = 'portrait' | 'three-quarter' | 'profile' | 'full-body';

/** One image of a character that stills and shots draw them from. */
export interface CharacterRef {
  /** The image in the uploads folder, named by its SHA-256: `/media/uploads/<file>`. */
  file: string;
  view: CharacterView | null;
  /** Where it came from: a still Hildegard made, an image someone added, or the person's own consent photos. */
  source: 'still' | 'upload' | 'consent';
  addedAt: string;
}

/**
 * Consent from the real person a character is based on. They give it on their own device through a one-time link,
 * taking their reference photos live as they agree; Hildegard signs the record and they can revoke it.
 */
export interface LikenessConsent {
  /** Waiting for the person, given, or taken back (the character stops rendering at once). */
  status: 'waiting' | 'active' | 'revoked' | 'declined';
  /** The name they gave. */
  person: string | null;
  /** When the consent link stops working, while it waits. */
  expiresAt: string | null;
  givenAt: string | null;
  revokedAt: string | null;
  /** The signed record's id, once given; `GET /api/characters/:id/consent` returns the record itself. */
  certificate: string | null;
}

/** A reusable character: who they are in words, the images that fix their face and clothes, and their voice. */
export interface Character {
  id: string;
  name: string;
  /** Face, hair, age, build: what stays the same in every shot. */
  description: string;
  /** What they wear unless a shot says otherwise. */
  wardrobe: string;
  references: CharacterRef[];
  /** The reference shown on their card; the first portrait unless someone picked another. */
  cover: string | null;
  /** A voice from the Voice studio, by id. */
  voice: string | null;
  /** Invented (nobody real), or based on a real person, who must consent. */
  likeness: 'invented' | 'real';
  consent: LikenessConsent | null;
  /** The person, signed in from another device, whose character it is; absent for the owner's own. */
  owner?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A still Hildegard renders: a character's portrait or one view of their sheet, or an image on its own from the
 * Images studio (no character and no view).
 */
export interface Still {
  id: string;
  /** The character it draws; null for an image on its own. */
  characterId: string | null;
  view: CharacterView | null;
  /** For an image on its own: the person, signed in from another device, whose image it is; absent for the owner's. */
  owner?: string;
  /** For an image on its own: its aspect ratio id, its quality and the camera and look it was drawn with. */
  aspect?: string;
  quality?: 'draft' | 'final';
  summary?: string;
  status: TakeStatus;
  priority: Priority;
  source: { kind: 'studio' } | { kind: 'agent'; name: string };
  by?: { id: string; name: string };
  seed: number;
  model: string;
  prompt: string;
  /** Reference images it was drawn from, as CharacterRef.file names. */
  references: string[];
  width: number;
  height: number;
  queuePosition: number | null;
  progress: { value: number; step: number | null; steps: number | null } | null;
  previewVersion: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  renderMs: number | null;
  error: TakeError | null;
  /** Set when done: `/media/stills/<id>.png`. */
  image: string | null;
  /** The reference it became, once kept: a CharacterRef.file. */
  kept?: string;
}

export interface EngineState {
  /** Whether ComfyUI answers. */
  online: boolean;
  url: string;
  /** Rendering with the stand-in engine (tests and UI development): no real video is made. */
  fake: boolean;
  paused: boolean;
  device: string;
  /** Who runs ComfyUI: Hildegard itself, the owner, nobody yet, the stand-in engine, or another device (Choir). */
  comfy: 'managed' | 'external' | 'not-installed' | 'fake' | 'remote';
  /** Why ComfyUI isn't answering, when Hildegard knows. */
  problem: string | null;
}

/** POST /api/models/:id/remove: what removing a model frees, and what it leaves. */
export interface ModelRemoval {
  id: string;
  /** Files only this model uses, on disk. */
  own: Array<{ file: string; bytes: number }>;
  /** Files other models use too; `neededBy` is the installed or downloading ones, empty when the file is now unused. */
  shared: Array<{ file: string; bytes: number; neededBy: string[] }>;
  /** What was deleted, or with `dryRun` what would be. */
  removed: string[];
  freedBytes: number;
  dryRun: boolean;
}

export interface ModelState {
  id: string;
  installed: boolean;
  /** Files still to fetch, with total bytes. */
  missingBytes: number;
  downloading: { done: number; total: number; file: string; bytesPerSec: number } | null;
  /** Needs a Hugging Face sign-in and the license accepted on its page. */
  gated: boolean;
  /** The user has accepted this model's current license in Hildegard. */
  licenseAccepted: boolean;
  /** How it fits this computer's GPU, as `hildegard models` says it; null when unknown (the stand-in GPU). */
  fit: 'fits' | 'tight' | 'no' | null;
  /** Why it won't run here when fit is 'no'. */
  fitWhy: 'memory' | 'apple-gpu' | null;
  error: string | null;
}

export interface HfState {
  linked: boolean;
  user: string | null;
  /** How the token is kept: the OS keychain, a 0600 file, or the environment. */
  storage: 'keychain' | 'file' | 'env' | null;
  /** Whether "Sign in with Hugging Face" is available (an OAuth client id is configured; it is by default). */
  oauth: boolean;
  /** Not linked, but this computer is signed in to Hugging Face already (`hf auth login`): one click links it. */
  found?: boolean;
}

/** Export film: one MP4 of each shot's chosen take, in order. */
export interface ExportState {
  id: string;
  projectId: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  /** Takes joined so far, of total. */
  done: number;
  total: number;
  takeIds: string[];
  /** Set when done: plays in the browser; add ?download to save it. */
  url: string | null;
  bytes: number | null;
  seconds: number | null;
  error: string | null;
  createdAt: string;
}

/**
 * What a device says it can do for Talk and for rendering: its own microphone and speaker, the speech and language
 * models it runs, its GPU, and whether it serves people as they wait or works through batches.
 */
export interface DeviceCapabilities {
  mic: boolean;
  speaker: boolean;
  /** Transcription models it can run now, by voice model id, such as "whisper-small". */
  stt: string[];
  /** Speech models it can run now, by voice model id, such as "kokoro-82m". */
  tts: string[];
  /** Language models running on it. */
  llm: Array<{ runtime: string; model: string; vramGb: number | null }>;
  gpu: { name: string; vramGb: number | null } | null;
  compute: 'interactive' | 'batch';
}

/** A device this computer joined, to render on its GPU. */
export interface ChoirDevice {
  name: string;
  url: string;
  /** It answered the last time Hildegard asked. */
  online: boolean;
  /** "RTX 4080 Laptop, 12 GB", when it said. */
  gpu: string | null;
  version: string | null;
  /** Models installed and verified there. */
  models: string[];
  /** How each model fits its GPU, by model id, as ModelState.fit says it. */
  fit: Record<string, 'fits' | 'tight' | 'no' | null>;
  /** Why each model won't run there, by model id, as ModelState.fitWhy says it. */
  fitWhy: Record<string, 'memory' | 'apple-gpu' | null>;
  /** Why it is not answering, in a sentence. */
  problem: string | null;
  /** Its updates, as it last said; null from versions before 0.1.9, which can't be updated from here. */
  update: UpdateState | null;
  /** It shares its GPU only while it's free; null until it says (versions before 0.1.11 don't). */
  opportunistic: boolean | null;
  /** Why it is busy for paired devices now (opportunistic, and in use), or null. */
  busy: string | null;
  /** Renders queued or running there, as it last said. */
  queue: number | null;
  /** What it says it can do; null until it says (versions before 0.1.14 don't). */
  capabilities: DeviceCapabilities | null;
}

/** Choir: rendering on another of your devices, and sharing this one's GPU with them. */
export interface ChoirState {
  /** Where takes render: "local", the name of a joined device, or "auto" for the best free device for each take. */
  use: string;
  /** Where the take rendering now, or next, goes: "local" or a device's name. The same as `use` unless that's "auto". */
  rendering: string;
  /**
   * The device Talk hears, answers and speaks on by default this session: "local" or a joined device's name. The
   * microphone and speaker stay with the Studio you talk into either way. Kept across restarts; back to "local" when
   * that device is removed.
   */
  primary: string;
  devices: ChoirDevice[];
  /** What this computer says it can do, as its joined devices see it in theirs; null until the server has looked. */
  capabilities: DeviceCapabilities | null;
  /** This computer shares its GPU: paired devices may render here. */
  sharing: {
    on: boolean;
    /** Where paired devices reach this one. */
    url: string | null;
    /** Join codes made since sharing was last turned off. */
    paired: number;
    /** Why paired devices can't reach it right now, such as Tailscale being down. */
    problem: string | null;
    /**
     * On: paired devices' renders wait behind this computer's own work, stop when its own work arrives, and start only
     * while nothing else is using it. Off: they render when their turn comes.
     */
    opportunistic: boolean;
    /**
     * What it can tell about being busy: GPU use and load (NVIDIA), load only, or nothing (Windows without NVIDIA,
     * where opportunistic sharing can only yield to Hildegard's own work), or an NVIDIA GPU that isn't answering, which
     * holds paired renders until it does. Null until the server has looked.
     */
    busyCheck: 'gpu+load' | 'load' | 'none' | 'gpu-unknown' | null;
    /**
     * Opportunistic: why it's busy for paired devices now, such as "Someone is using this computer." or "llama-server
     * is using the GPU.", or null while it's free. Always null when not opportunistic.
     */
    busy: string | null;
    /** Whether it can tell when someone uses it (an idle clock); null until it has looked, false on a headless box. */
    seesOwner: boolean | null;
  };
}

/**
 * A render a paired device sent to this computer (Choir), as this computer's queue shows it. Only what the queue
 * needs: never its prompt, which belongs to whoever asked for it there.
 */
export interface GuestTake {
  id: string;
  /** The sending device's name, as it gave it; display only, never proof of who sent it. Null when it didn't say. */
  from: string | null;
  status: 'running' | 'queued';
  /** Place in this computer's queue, 0 while rendering, as Take.queuePosition counts it. */
  queuePosition: number | null;
  /** 0 to 1 while rendering; null before the first step. */
  progress: number | null;
  quality: 'draft' | 'final' | null;
  createdAt: string;
}

export interface Snapshot {
  version: string;
  /** Where this build's source code is (AGPL §13): the repository and, when known, the exact commit. */
  source: { url: string; commit: string | null };
  projects: Project[];
  shots: Shot[];
  takes: Take[];
  engine: EngineState;
  models: ModelState[];
  hf: HfState;
  exports: ExportState[];
  choir: ChoirState;
  /** Renders paired devices sent here, waiting or rendering, in queue order. */
  guests: GuestTake[];
  update: UpdateState;
  characters: Character[];
  stills: Still[];
}

/** Updates to Hildegard itself. */
export interface UpdateState {
  /** The version running. */
  current: string;
  /** A newer release, when there is one. */
  available: string | null;
  /** Update by itself once nothing is rendering. On unless the owner turned it off. */
  auto: boolean;
  /** An update is running: Hildegard restarts as the new version. */
  applying: boolean;
  /** Asked to update while something renders: it updates once that's done, even with automatic updates off. */
  waiting: boolean;
  /** A release install, which can update itself; a source checkout can't. */
  updatable: boolean;
  /** Why the last check failed, if it did. */
  error: string | null;
  checkedAt: string | null;
}

/** Owners may do everything; directors make films of their own and nothing else. */
export type Role = 'owner' | 'director';

/** Someone who signs in to this Hildegard from another device. */
export interface Person {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  /** When they last used Hildegard, if they have signed in. */
  lastSeenAt: string | null;
  /** Devices they are signed in on. */
  sessions: number;
}

/** An invite link that has not been used yet. The link itself is shown once, when it is made. */
export interface PendingInvite {
  id: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
}

/** GET /api/auth/me: who this browser is. */
export interface AuthState {
  /** On the computer Hildegard runs on: no sign-in, and every power, as always. */
  local: boolean;
  /** Signed in from another device. */
  person: { id: string; name: string; role: Role } | null;
  /** An owner account exists, so people can sign in from other devices. */
  owner: boolean;
}

/** Host mode: Hildegard at a link, for you and the people you invite. */
export interface HostState {
  on: boolean;
  /**
   * How people reach it: Tailscale Serve (HTTPS on your tailnet), Tailscale Funnel (HTTPS on the public internet),
   * this computer's own Tailscale address (plain HTTP inside the tailnet, which WireGuard encrypts), or the owner's
   * own HTTPS front door (`custom`: a Cloudflare named tunnel, Caddy and the like) forwarding to the hosted listener.
   */
  via: 'tailscale' | 'funnel' | 'address' | 'custom' | null;
  /** The link to open, once it works. */
  url: string | null;
  /** Why the link doesn't work right now, in a sentence. */
  problem: string | null;
  /** What the owner must do about the problem, when it is theirs to do: a command or a page to open. */
  fix: string | null;
  /** Tailscale on this computer. */
  tailscale: { running: boolean; name: string | null; ip: string | null };
  /** An owner account exists. */
  owner: boolean;
  /**
   * With `via: 'custom'`, whether Hildegard runs the front door itself: a Cloudflare named tunnel on the owner's own
   * domain, or a quick tunnel (a temporary trycloudflare.com name, with no account). Null for a door the owner runs.
   */
  tunnel?: 'cloudflare' | 'quick' | null;
}

/**
 * Where one tunnel provider stands on this computer, so each step that is already done is skipped: `missing` (its
 * tool isn't installed), `signed-out` (installed, not signed in to an account), `ready` (signed in, no link yet), `on`
 * (Hildegard's link runs through it) or `problem` (it should be on and isn't; `problem` and `fix` say why).
 */
export type TunnelProviderState = 'missing' | 'signed-out' | 'ready' | 'on' | 'problem';

export interface TunnelProvider {
  state: TunnelProviderState;
  installed: boolean;
  signedIn: boolean;
  /** The tool's version, when it answered. */
  version: string | null;
  /** The provider's own page for making a free account. Hildegard never makes one. */
  signup: string;
  /** The provider's own download page. */
  download: string;
  /** The command that installs the tool on this kind of computer, for the owner to run. */
  install: string | null;
  /** The command that signs this computer in to an account the owner already has. */
  signIn: string;
  problem: string | null;
  fix: string | null;
}

/** GET /api/tunnel */
export interface TunnelReport {
  tailscale: TunnelProvider & {
    /** This computer's MagicDNS name, once signed in. */
    name: string | null;
    /** Funnel (the public internet) carries the link, not Serve (the tailnet only). */
    funnel: boolean;
    /** Tailscale itself says a Serve or Funnel route forwards to Hildegard's hosted listener right now. */
    forwarding: boolean;
  };
  cloudflare: TunnelProvider & {
    /** The named tunnel Hildegard uses on this computer, `hildegard-<computer>`, once it exists in the account. */
    tunnel: { name: string; id: string } | null;
    /** The name people open, for a named tunnel. */
    hostname: string | null;
    /** The link runs through a quick tunnel: its name changes on every start, and it has no account. */
    temporary: boolean;
    /** Hildegard can fetch the pinned cloudflared itself on this kind of computer. */
    canFetch: boolean;
    /** A sign-in Hildegard started is waiting for the owner on this page. */
    signingIn: string | null;
  };
  host: HostState;
}

/**
 * Something that lets an AI app use this Hildegard's MCP from another device, as one person: a key made for an app on
 * the owner's own devices, or a chatbot (claude.ai, ChatGPT) someone approved on Hildegard's sign-in page.
 */
export interface AgentGrant {
  id: string;
  /** What the person called it, or the chatbot's own name. */
  name: string;
  kind: 'key' | 'chatbot';
  person: { id: string; name: string };
  createdAt: string;
  lastUsedAt: string | null;
  /** When it stops working on its own; null for a key that lasts until it is revoked. */
  expiresAt: string | null;
  /** A chatbot: approved with a passphrase, or with a one-time connect code the person made. */
  approval?: 'passphrase' | 'code';
}

/** POST /api/auth/codes: a one-time code to approve a chatbot's connection. */
export interface ConnectCode {
  /** `HG-XXXX-XXXX`, good once for 10 minutes. */
  code: string;
  expiresAt: string;
  /** Who it approves as: the owner who made it. */
  person: { id: string; name: string };
  /** The address to give the chatbot, once Hildegard is at a link. */
  mcpUrl: string | null;
}

/** POST /api/choir/invite: what the sharing device hands the other one. */
export interface ChoirInvite {
  /** The long `hgc1_` code, made only when asked for (it leaves a key behind); a secret. Null for a short invite. */
  code: string | null;
  /** Where the sharing device is reached. */
  url: string;
  /** What this device is called in the other's Choir. */
  name: string;
  /** A short code to type instead (`HG-XXXX-XXXX`), good once for 10 minutes; null when the caller brought its own key. */
  short: { code: string; expiresAt: string } | null;
  /** The command for the other device, with the short code and the address. */
  command: string | null;
}

/** GET /api/auth/grants */
export interface GrantsResponse {
  grants: AgentGrant[];
  /** Where AI apps on other devices reach this Hildegard's MCP, once it is at a link. */
  mcpUrl: string | null;
}

/** POST /api/auth/keys: the key itself, shown this once. */
export interface NewKey {
  grant: AgentGrant;
  key: string;
  mcpUrl: string | null;
}

/** The local model runtimes Hildegard can use: Ollama, LM Studio, llama.cpp, vLLM, MLX and the like. */
export type LlmRuntime =
  | 'ollama'
  | 'lm-studio'
  | 'llama-cpp'
  | 'vllm'
  | 'mlx'
  | 'sglang'
  | 'jan'
  | 'koboldcpp'
  | 'tabby'
  | 'local-ai'
  | 'openai';

export interface LlmModel {
  id: string;
  /** Bytes on disk, when the runtime says. */
  size: number | null;
  /** Context length in tokens, when the runtime says. */
  context: number | null;
  /** Loaded in memory right now, when the runtime says. */
  loaded: boolean | null;
}

/** One OpenAI-compatible endpoint: found running on this computer, or added by the owner. */
export interface LlmEndpoint {
  id: string;
  runtime: LlmRuntime;
  name: string;
  /** The OpenAI-compatible base, ending in /v1 for most runtimes. */
  url: string;
  online: boolean;
  models: LlmModel[];
  /** Added by the owner, rather than found. */
  custom: boolean;
  /** Sends a key; the key itself stays in the keychain. */
  keyed: boolean;
  error: string | null;
}

/** GET /api/llm */
export interface LlmState {
  endpoints: LlmEndpoint[];
  /** What directs when no endpoint or model is named. */
  use: { endpoint: string; model: string } | null;
}

/** POST /api/llm/direct: what a local model did with an idea. */
export interface LlmDirectResult {
  endpoint: string;
  model: string;
  /** How it directed: calling Hildegard's tools itself, or writing a shot list Hildegard then queued. */
  mode: 'tools' | 'plan';
  steps: Array<{ tool: string; args: Record<string, unknown>; ok: boolean; result: string }>;
  shots: string[];
  reply: string;
}

/** GET /api/people */
export interface PeopleResponse {
  people: Person[];
  invites: PendingInvite[];
  /** How many takes each director may have waiting or rendering at once. Owners have no limit. */
  directorQueue: number;
}

/** POST /api/people/invites. `url` holds the one-time secret: show it once, never log it. */
export interface NewInvite {
  invite: PendingInvite;
  url: string;
}

/** Server-sent events on /api/events. */
export type ServerEvent =
  | { type: 'take'; take: Take }
  | { type: 'shot'; shot: Shot }
  | { type: 'project'; project: Project }
  | { type: 'removed'; kind: 'take' | 'shot' | 'project' | 'voice-job' | 'character' | 'still'; id: string }
  | { type: 'character'; character: Character }
  | { type: 'still'; still: Still }
  | { type: 'engine'; engine: EngineState }
  | { type: 'models'; models: ModelState[] }
  | { type: 'hf'; hf: HfState }
  | { type: 'export'; export: ExportState }
  | { type: 'choir'; choir: ChoirState }
  | { type: 'guests'; guests: GuestTake[] }
  | { type: 'host'; host: HostState }
  | { type: 'update'; update: UpdateState }
  | { type: 'voice-job'; job: VoiceJob }
  | { type: 'voices'; voices: Voice[] }
  | { type: 'voice-models'; models: VoiceModelState[] }
  | { type: 'consent'; session: ConsentSessionView };

/** POST /api/shots */
export interface CreateShotBody {
  projectId?: string;
  /** Add takes to an existing shot instead of starting a new one. */
  shotId?: string;
  title?: string;
  request: unknown;
  priority?: Priority;
}

/** An AI app Hildegard can link its MCP server into. */
export interface AgentInfo {
  id: string;
  name: string;
  /** The app looks installed on the computer Hildegard runs on. */
  installed: boolean;
  connected: boolean;
  /** Its MCP config file. */
  file: string;
  /** How to sign the app in so its provider's terms allow it. */
  signIn: string;
}

/** GET /api/agents */
export interface AgentsResponse {
  agents: AgentInfo[];
  /** The entry to paste into any other MCP app. */
  snippet: string;
  /** This browser is on the computer Hildegard runs on, so it may link apps there. */
  local: boolean;
}

/** One step a setup action took, as the CLI reports them. */
export interface SetupStep {
  id: string;
  title: string;
  status: 'done' | 'skipped' | 'needs-owner' | 'failed';
  detail: string;
  command?: string;
}
