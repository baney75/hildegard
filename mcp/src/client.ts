// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import type { ProseLint } from '@hildegard/craft';
import type {
  Catalog,
  Character,
  CharacterView,
  ChoirDevice,
  ChoirState,
  ExportState,
  MarkCheck,
  Project,
  Shot,
  ShotRequestInput,
  Snapshot,
  Still,
  Take,
  UpdateState,
  Voice,
  VoiceJob,
  VoiceState,
} from '@hildegard/presets';
import type { Draft } from './report.ts';

export class HildegardError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface TakeReview {
  take: string;
  kind: 'video' | 'image' | 'audio';
  passed: boolean;
  checks: Array<{
    id: string;
    status: 'pass' | 'warn' | 'fail';
    value: unknown;
    limit: unknown;
    detail: string;
  }>;
  info: Record<string, unknown>;
  summary: string;
  sheet: string | null;
}

export interface ShotDetail {
  shot: Shot;
  takes: Take[];
  /** Take id → the finished video's path on the computer Hildegard runs on. */
  files: Record<string, string>;
  /** The film the shot is in. */
  project: { id: string; title: string };
}

/** A voice job, and where its clips are on the computer Hildegard runs on. */
export type VoiceJobDetail = VoiceJob & { files: string[] };

export interface LoopCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  value: unknown;
  limit: unknown;
  detail: string;
}
export interface LoopRound {
  n: number;
  at: string;
  file: string;
  format: string;
  note: string;
  sheet: string | null;
  review: { passed: boolean; summary: string; info: Record<string, unknown>; checks: LoopCheck[] };
  critique: { verdict: 'ready' | 'revise' | 'stop'; change?: string } | null;
  /** A print's slice, with a link to its G-code. */
  slice?: {
    slicer: string;
    time: string | null;
    grams: number | null;
    cost: number | null;
    gcode: string | null;
  } | null;
  /** A delivered print's sheet to hand on. */
  handoff?: string | null;
}
export interface OpenScadInfo {
  installed: boolean;
  version: string | null;
  manifold: boolean;
  path: string | null;
  libraryDirs: string[];
  libraries: string[];
  /** How OpenSCAD is sandboxed here; null when it can't be, and then rounds can't include libraries. */
  sandbox: 'sandbox-exec' | 'bwrap' | null;
}

export interface PrinterInfo {
  name: string;
  bedMm: [number, number, number];
  nozzleMm: number;
  layerMm: number;
  material: string;
  filamentMm: number;
  pricePerKg: number;
  currency: string;
  clearanceMm: Record<'press' | 'snug' | 'slide' | 'free', number>;
  calibrated: string[];
  calibratedAt: string | null;
  slicer: string | null;
  profiles: string[];
  slicerFound: { name: string; path: string; ready: boolean } | null;
}
export interface LoopSummary {
  id: string;
  kind: string;
  title: string;
  status: 'open' | 'done' | 'stopped';
  rounds: number;
  maxRounds: number;
  chosen: number | null;
  updatedAt: string;
}
export interface LoopDetail extends Omit<LoopSummary, 'rounds'> {
  rounds: LoopRound[];
  note: string | null;
  questions: string;
  brief: Record<string, unknown>;
  target: Record<string, unknown>;
}
export interface RoundResult {
  loop: string;
  round: LoopRound;
  roundsLeft: number;
  questions: string;
}
export interface CritiqueResult {
  loop: string;
  round: LoopRound;
  verdict: 'ready' | 'revise' | 'stop';
  next: string;
}

export interface SiteSummary {
  id: string;
  title: string;
  source: { kind: string; from: string | null };
  createdAt: string;
  updatedAt: string;
  pages: string[];
  files: number;
  bytes: number;
  notes: string[];
  reference: { file: string; width: number } | null;
  /** Whether everyone can read it at /s/<id>/. */
  published: boolean;
  /** The preview's path on the server: /preview/<id>/<key>/. */
  preview: string;
}
export interface SiteDetail extends SiteSummary {
  fileList: { path: string; bytes: number }[];
}
export interface TemplateInfo {
  id: string;
  name: string;
  for: string;
  description: string;
  sections: string[];
  images: { file: string; aspect: string; prompt: string }[];
  pages: string[];
}
export interface WritingEdit {
  at: string;
  draftWords: number;
  finalWords: number;
  removed: string[];
  added: string[];
  lintBefore: { fails: number; warns: number };
  lintAfter: { fails: number; warns: number };
  note: string;
}
export interface WritingVoice {
  person: string;
  voice: { md: string; updatedAt: string | null; versions: number };
  samples: { id: string; title: string; source: string; addedAt: string; words: number }[];
  /** The last ten edits, newest first. */
  edits: WritingEdit[];
  topCut: { phrase: string; count: number }[];
}
export interface PostResult {
  slug: string;
  draft: boolean;
  path: string;
  date: string;
  site: SiteDetail & { path: string; address: string | null };
  lint: { ok: boolean; fails: string[]; warns: string[] };
}
export interface SiteToken {
  name: string;
  value: string;
  dark: boolean;
  file: string;
}

/** A voice mixed over a film's sound (export_film). */
export interface VoiceoverArgs {
  mediaId: string;
  startSeconds?: number;
  gainDb?: number;
  duckDb?: number;
}
export interface RecordLink {
  needsLink?: undefined;
  id: string;
  /** Where the person records: on this computer, or on their phone. */
  where: 'here' | 'phone';
  /** The link is https, so a phone allows its microphone; over plain http it can only send a file. */
  secure: boolean;
  /** The secret that opens the link. Only the call that made the link ever returns it. */
  token: string;
  path: string;
  url: string;
  /** `url` is Hildegard's own link, which a phone can reach; otherwise it is only the address the request came to. */
  viaLink: boolean;
  /** The link is on the internet: anyone who has Hildegard's link can reach its sign-in page. */
  public: boolean;
  expiresAt: string;
  /** The link opens only on the computer Hildegard runs on, not on a phone. */
  localOnly: boolean;
}
/** What turning on a link would do, decided once by the server. `id` goes back with the person's yes. */
export interface LinkPlan {
  route: 'tailscale' | 'quick' | 'none';
  /** The sign-in page would be on the internet. */
  public: boolean;
  id: string;
  ask: string;
}
/** A phone link was asked for and there is no (private) link on: nothing was made, and the person decides. */
export interface NeedsLink {
  needsLink: true;
  where: 'phone';
  plan: LinkPlan;
  /** For a private plan, the question to ask word for word; otherwise what the person has to do themselves. */
  ask: string;
  /** A link is on, but it is public, and a private one was asked for. */
  existingPublic: boolean;
  /** Null when no AI app may turn it on (a public route, or nothing to use). */
  turnOn: { tool: string; rest: string; next: string } | null;
}
/** What `link_on` did, or why it needs the owner. */
export interface LinkOnResult {
  status: 'on' | 'needs-owner' | 'confirm' | 'failed';
  plan?: LinkPlan;
  already?: boolean;
  via?: string;
  url?: string;
  private?: boolean;
  temporary?: boolean;
  message: string;
  steps: { id: string; title: string; detail: string; command?: string }[];
}
export interface Recording {
  id: string;
  kind: 'voice' | 'video';
  purpose: string | null;
  filmId: string | null;
  status: 'pending' | 'received' | 'expired';
  expiresAt: string | null;
  receivedAt: string | null;
  seconds: number | null;
  bytes: number | null;
  url: string | null;
  from: string | null;
  clean: { lufs: number; truePeak: number; targetLufs: number; peak: number; backend: string } | null;
  /** Where the file is on this computer, for agents running here. */
  file?: string | null;
  chapters?: { at: number; title: string }[];
  interview?: { questions: number; answered: number } | null;
}
export type RecordSource = 'camera' | 'screen' | 'screen+camera' | 'voice';
/** A browser demo, for the agent that asked for it. */
export interface DemoView {
  id: string;
  status: 'starting' | 'recording' | 'rendering' | 'done' | 'failed' | 'stopped';
  stage: string | null;
  log: string[];
  error: string | null;
  recording: { id: string; url: string | null; file: string | null; seconds: number | null } | null;
}
/** Where an interview stands, for the agent that asked for it. */
export interface InterviewView {
  id: string;
  status: 'pending' | 'received' | 'expired';
  expiresAt: string | null;
  questions: string[];
  current: { index: number; question: string } | null;
  answers: {
    index: number;
    question: string;
    at: number;
    receivedAt: string;
    mediaId: string;
    seconds: number | null;
    url: string | null;
    file: string | null;
    transcript: string | null;
    transcribing: boolean;
  }[];
  chapters: { at: number; title: string }[];
  transcribes: boolean;
  recording: Recording | null;
}
export interface CleanJobView {
  id: string;
  from: string;
  status: 'running' | 'done' | 'failed';
  stage: string | null;
  error: string | null;
  recording: Recording | null;
}

const filePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** Talks to the Hildegard server on this computer, as the Studio does. */
export class HildegardClient {
  readonly url: string;
  /** How it reaches the server; a stand-in in tests, which reports also search GitHub with. */
  readonly fetchFn: typeof fetch;

  constructor(url = process.env.HILDEGARD_URL ?? 'http://127.0.0.1:7341', fetchFn: typeof fetch = fetch) {
    this.url = url.replace(/\/$/, '');
    this.fetchFn = fetchFn;
  }

  private async call<T>(method: string, path: string, body?: unknown, raw?: Uint8Array): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.url}${path}`, {
        method,
        headers:
          method === 'GET'
            ? {}
            : { 'x-hildegard': '1', ...(raw ? {} : { 'content-type': 'application/json' }) },
        body: raw ? Buffer.from(raw) : body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new HildegardError(
        0,
        `Hildegard is not running at ${this.url}. Start it with \`hildegard start\`, then try again.`,
      );
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const field = typeof data.field === 'string' ? ` (${data.field})` : '';
      throw new HildegardError(
        res.status,
        `${String(data.error ?? `Hildegard answered ${res.status}`)}${field}`,
        data,
      );
    }
    return data as T;
  }

  snapshot = () => this.call<Snapshot>('GET', '/api/snapshot');
  catalog = () => this.call<Catalog>('GET', '/api/catalog');
  shot = (id: string) => this.call<ShotDetail>('GET', `/api/shots/${encodeURIComponent(id)}`);
  createProject = (title: string) => this.call<Project>('POST', '/api/projects', { title });
  createShot = (body: { request: ShotRequestInput; projectId?: string; title?: string; agent: string }) =>
    this.call<{ project: Project; shot: Shot; takes: Take[] }>('POST', '/api/shots', body);
  /** Stops a waiting or rendering take, as the Studio's Cancel does; a finished one answers 409. */
  cancelTake = (id: string) => this.call<Take>('POST', `/api/takes/${encodeURIComponent(id)}/cancel`);
  exportFilm = (id: string, voiceover?: VoiceoverArgs) =>
    this.call<ExportState>(
      'POST',
      `/api/projects/${encodeURIComponent(id)}/export`,
      voiceover ? { voiceover } : undefined,
    );
  // ── Recording from any chat ──
  recordLink = (body: {
    kind?: 'voice' | 'video';
    sources?: RecordSource[];
    script?: string;
    questions?: string[];
    purpose?: string;
    filmId?: string;
    where?: 'here' | 'phone' | 'auto';
    private?: boolean;
  }) => this.call<RecordLink | NeedsLink>('POST', '/api/record/links', body);
  /**
   * Turns on the private link a plan names. Only this computer may ask. It sends the plan id and never `acceptPublic`:
   * a public link is the person's own to turn on (Studio, terminal), not an AI app's.
   */
  linkOn = (plan?: string) => this.call<LinkOnResult>('POST', '/api/link/on', plan ? { plan } : {});
  /** A recording by its id, or by the link's token (which travels in the body, never the address). */
  recording = (by: { id: string } | { token: string }) =>
    'id' in by
      ? this.call<Recording>('GET', `/api/record/${encodeURIComponent(by.id)}`)
      : this.call<Recording>('POST', '/api/record/status', { token: by.token });
  /** Brings a file in as a recording, for cleaning or a film; the server checks what it is. */
  importRecording = (bytes: Uint8Array, kind: 'voice' | 'video' | 'auto' = 'auto') =>
    this.call<Recording>('POST', `/api/record/imports?kind=${kind}`, undefined, bytes);
  cleanRecording = (id: string, body: { target_lufs?: number; peak?: number }) =>
    this.call<CleanJobView>('POST', `/api/record/${encodeURIComponent(id)}/clean`, body);
  // ── Browser demos ──
  startDemo = (body: Record<string, unknown>) => this.call<DemoView>('POST', '/api/demos', body);
  demo = (id: string) => this.call<DemoView>('GET', `/api/demos/${encodeURIComponent(id)}`);
  interviewAsk = (id: string, question: string) =>
    this.call<{ id: string; index: number; questions: string[] }>(
      'POST',
      `/api/record/${encodeURIComponent(id)}/ask`,
      { question },
    );
  interview = (id: string) =>
    this.call<InterviewView>('GET', `/api/record/${encodeURIComponent(id)}/interview`);
  cleanJob = (id: string) => this.call<CleanJobView>('GET', `/api/record/clean/${encodeURIComponent(id)}`);
  exportState = (id: string) =>
    this.call<ExportState & { file: string | null }>('GET', `/api/exports/${encodeURIComponent(id)}`);
  /** Technical checks on a finished take, and where its contact sheet is. */
  review = (takeId: string) =>
    this.call<TakeReview>('GET', `/api/takes/${encodeURIComponent(takeId)}/review`);
  createCharacter = (body: { name: string; description?: string; wardrobe?: string }) =>
    this.call<Character>('POST', '/api/characters', { ...body, likeness: 'invented' });
  makeStills = (id: string, body: { view: CharacterView; count?: number; note?: string; agent: string }) =>
    this.call<{ character: Character; stills: Still[] }>(
      'POST',
      `/api/characters/${encodeURIComponent(id)}/stills`,
      body,
    );
  /** Draws images on their own, from words or as an edit of up to four uploaded references. */
  makeImages = (body: {
    prompt: string;
    aspect?: string;
    quality?: 'draft' | 'final';
    count?: number;
    seed?: number;
    references?: string[];
    noRealPerson?: true;
    camera?: { body?: string; lens?: string; focal?: number; aperture?: number };
    look?: { lighting?: string; palette?: string; genre?: string; era?: string };
    agent: string;
  }) => this.call<{ stills: Still[] }>('POST', '/api/images', body);
  /** The prose lint (up to 200,000 characters): the tells that make writing read as machine-made. */
  lintWriting = (text: string, strict?: boolean) =>
    this.call<ProseLint>('POST', '/api/writing/lint', strict ? { text, strict } : { text });
  keepStill = (id: string) => this.call<Character>('POST', `/api/stills/${encodeURIComponent(id)}/keep`);
  updateCheck = () => this.call<UpdateState>('POST', '/api/update/check');
  updateNow = () => this.call<UpdateState>('POST', '/api/update');
  choir = () => this.call<ChoirState>('GET', '/api/choir');
  updateDevice = (name: string) =>
    this.call<{ device: ChoirDevice; choir: ChoirState }>('POST', '/api/choir/update', { name });
  installModel = (id: string, acceptLicense: boolean) =>
    this.call<unknown>('POST', `/api/models/${encodeURIComponent(id)}/install`, { acceptLicense });

  // ── Voice ──
  voice = () => this.call<VoiceState>('GET', '/api/voice');
  voiceJob = (id: string) => this.call<VoiceJobDetail>('GET', `/api/voice/jobs/${encodeURIComponent(id)}`);
  /** speak, design, convert, transcribe or dub: queues a voice job. */
  voiceRun = (kind: 'speak' | 'design' | 'convert' | 'transcribe' | 'dub', body: Record<string, unknown>) =>
    this.call<VoiceJob>('POST', `/api/voice/${kind}`, body);
  keepDesign = (job: string, candidate: number, name: string) =>
    this.call<Voice>('POST', `/api/voice/design/${encodeURIComponent(job)}/keep`, { candidate, name });
  cancelVoiceJob = (id: string) =>
    this.call<VoiceJob>('POST', `/api/voice/jobs/${encodeURIComponent(id)}/cancel`);
  isOurs = (source: string) => this.call<MarkCheck>('POST', '/api/voice/check', { source });
  installVoiceModel = (id: string, acceptLicense: boolean) =>
    this.call<unknown>('POST', `/api/voice/models/${encodeURIComponent(id)}/install`, { acceptLicense });
  // ── Loops ──
  loops = () => this.call<{ loops: LoopSummary[] }>('GET', '/api/loops');
  loop = (id: string) => this.call<LoopDetail>('GET', `/api/loops/${encodeURIComponent(id)}`);
  startLoop = (body: Record<string, unknown>) => this.call<LoopDetail>('POST', '/api/loops', body);
  /** A round: the file's bytes, and what changed. The server reads what the file is from its bytes. */
  submitRound = (id: string, bytes: Uint8Array, note: string) =>
    this.call<RoundResult>(
      'POST',
      `/api/loops/${encodeURIComponent(id)}/rounds?note=${encodeURIComponent(note.slice(0, 1000))}`,
      undefined,
      bytes,
    );
  critique = (id: string, n: number, body: Record<string, unknown>) =>
    this.call<CritiqueResult>('POST', `/api/loops/${encodeURIComponent(id)}/rounds/${n}/critique`, body);
  finishLoop = (id: string, round: number, note: string) =>
    this.call<LoopDetail>('POST', `/api/loops/${encodeURIComponent(id)}/finish`, { round, note });
  // ── Reports to Hildegard's makers ──
  reportDraft = (body: Record<string, unknown>) =>
    this.call<{ draft: Draft; filer: string | null }>('POST', '/api/report/draft', body);
  reportFile = (id: string, on?: number) =>
    this.call<{ draft: Draft }>('POST', '/api/report/file', { id, confirm: true, ...(on ? { on } : {}) });
  /** Web: the image of the design every round is held to, drawn `width` pixels wide. */
  setLoopReference = (id: string, bytes: Uint8Array, width: number, page?: string) =>
    this.call<LoopDetail>(
      'PUT',
      `/api/loops/${encodeURIComponent(id)}/reference?width=${width}${page ? `&page=${encodeURIComponent(page)}` : ''}`,
      undefined,
      bytes,
    );
  // ── Sites ──
  sites = () =>
    this.call<{
      sites: SiteSummary[];
      templates: TemplateInfo[];
      figma: { linked: boolean };
      urlImport: boolean;
    }>('GET', '/api/sites');
  site = (id: string) => this.call<SiteDetail>('GET', `/api/sites/${encodeURIComponent(id)}`);
  createSite = (body: Record<string, unknown>) => this.call<SiteDetail>('POST', '/api/sites', body);
  writeSiteFile = (id: string, path: string, bytes: Uint8Array) =>
    this.call<SiteSummary>(
      'PUT',
      `/api/sites/${encodeURIComponent(id)}/files/${filePath(path)}`,
      undefined,
      bytes,
    );
  deleteSiteFile = (id: string, path: string) =>
    this.call<SiteSummary>('DELETE', `/api/sites/${encodeURIComponent(id)}/files/${filePath(path)}`);
  siteTokens = (id: string) =>
    this.call<{ tokens: SiteToken[] }>('GET', `/api/sites/${encodeURIComponent(id)}/tokens`);
  setSiteToken = (id: string, body: { name: string; value: string; dark?: boolean }) =>
    this.call<{ tokens: SiteToken[] }>('POST', `/api/sites/${encodeURIComponent(id)}/tokens`, body);
  /** A file of a site's, as bytes. */
  async siteFile(id: string, path: string): Promise<Uint8Array> {
    const res = await this.fetchFn(
      `${this.url}/api/sites/${encodeURIComponent(id)}/files/${filePath(path)}`,
    ).catch(() => null);
    if (!res) throw new HildegardError(0, `Hildegard is not running at ${this.url}.`);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new HildegardError(res.status, data.error ?? `Hildegard answered ${res.status}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }
  postToSite = (id: string, body: Record<string, unknown>) =>
    this.call<PostResult>('POST', `/api/sites/${encodeURIComponent(id)}/posts`, body);
  publishSite = (id: string, published: boolean) =>
    this.call<SiteDetail & { path: string; address: string | null }>(
      'PUT',
      `/api/sites/${encodeURIComponent(id)}/publish`,
      { published },
    );
  // ── Writing ──
  writingVoice = () => this.call<WritingVoice>('GET', '/api/writing/voice');
  setWritingVoice = (md: string) =>
    this.call<{ person: string; voice: WritingVoice['voice'] }>('PUT', '/api/writing/voice', { md });
  addWritingSample = (body: { title: string; text: string; source?: string }) =>
    this.call<{ person: string; sample: WritingVoice['samples'][number] }>(
      'POST',
      '/api/writing/samples',
      body,
    );
  /** One saved sample, with its text. */
  writingSample = (id: string) =>
    this.call<{ person: string; sample: WritingVoice['samples'][number] & { text: string } }>(
      'GET',
      `/api/writing/samples/${encodeURIComponent(id)}`,
    );
  recordWritingEdit = (body: { draft: string; final: string; note?: string }) =>
    this.call<{ person: string; edit: WritingEdit }>('POST', '/api/writing/edits', body);
  siteZip = (id: string) => this.bytes(`/api/sites/${encodeURIComponent(id)}/zip`);
  siteReference = (id: string) => this.bytes(`/api/sites/${encodeURIComponent(id)}/reference`);
  // ── The printer ──
  printer = () => this.call<PrinterInfo>('GET', '/api/printer');
  setPrinter = (body: Record<string, unknown>) => this.call<PrinterInfo>('PUT', '/api/printer', body);
  openscad = () => this.call<OpenScadInfo>('GET', '/api/openscad');
  /** Any file the server serves (a take's video, a still), as bytes; null if it isn't there. */
  async bytes(path: string): Promise<Uint8Array | null> {
    const res = await this.fetchFn(`${this.url}${path}`).catch(() => null);
    if (!res?.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  /** A recording's bytes; the server checks it is audio. */
  async uploadAudio(bytes: Uint8Array): Promise<string> {
    return (await this.call<{ name: string }>('POST', '/api/voice/uploads', undefined, bytes)).name;
  }
  /** A clip the server serves, as base64. */
  async audio(path: string): Promise<{ data: string; mimeType: string } | null> {
    const res = await this.fetchFn(`${this.url}${path}`).catch(() => null);
    if (!res?.ok) return null;
    return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: 'audio/wav' };
  }

  async upload(path: string): Promise<string> {
    const bytes = await readFile(path).catch(() => {
      throw new HildegardError(0, `Cannot read ${path}`);
    });
    return this.uploadBytes(bytes);
  }

  /** A start frame's bytes; the server checks it is a PNG, JPEG or WebP. */
  async uploadBytes(bytes: Uint8Array): Promise<string> {
    return (await this.call<{ name: string }>('POST', '/api/uploads', undefined, bytes)).name;
  }

  /** A finished take's poster, for clients that can show images. */
  poster(take: Take): Promise<{ data: string; mimeType: string } | null> {
    return take.poster ? this.image(take.poster) : Promise.resolve(null);
  }

  /** An image the server serves, such as a poster, a contact sheet or a still, as base64. */
  async image(path: string): Promise<{ data: string; mimeType: string } | null> {
    const res = await this.fetchFn(`${this.url}${path}`).catch(() => null);
    if (!res?.ok) return null;
    const type = res.headers.get('content-type')?.split(';')[0] ?? '';
    return {
      data: Buffer.from(await res.arrayBuffer()).toString('base64'),
      mimeType: type.startsWith('image/') ? type : 'image/jpeg',
    };
  }
}
