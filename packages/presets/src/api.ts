// SPDX-License-Identifier: Apache-2.0
/** Shapes the Studio UI, the MCP server and the local server share. Plain data, safe to send as JSON. */
import type { ShotRequest } from './schema.ts';

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
  error: string | null;
}

export interface HfState {
  linked: boolean;
  user: string | null;
  /** How the token is kept: the OS keychain, a 0600 file, or the environment. */
  storage: 'keychain' | 'file' | 'env' | null;
  /** Whether "Sign in with Hugging Face" is available (an OAuth app id is configured). */
  oauth: boolean;
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
  /** Why it is not answering, in a sentence. */
  problem: string | null;
}

/** Choir: rendering on another of your devices, and sharing this one's GPU with them. */
export interface ChoirState {
  /** Where takes render: "local", or the name of a joined device. */
  use: string;
  devices: ChoirDevice[];
  /** This computer shares its GPU: paired devices may render here. */
  sharing: {
    on: boolean;
    /** Where paired devices reach this one. */
    url: string | null;
    /** Join codes made since sharing was last turned off. */
    paired: number;
    /** Why paired devices can't reach it right now, such as Tailscale being down. */
    problem: string | null;
  };
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
   * or this computer's own Tailscale address (plain HTTP inside the tailnet, which WireGuard encrypts).
   */
  via: 'tailscale' | 'funnel' | 'address' | null;
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
  | { type: 'removed'; kind: 'take' | 'shot' | 'project'; id: string }
  | { type: 'engine'; engine: EngineState }
  | { type: 'models'; models: ModelState[] }
  | { type: 'hf'; hf: HfState }
  | { type: 'export'; export: ExportState }
  | { type: 'choir'; choir: ChoirState }
  | { type: 'host'; host: HostState };

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
