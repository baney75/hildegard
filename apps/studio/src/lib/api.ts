// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentInfo,
  AgentsResponse,
  AuthState,
  Catalog,
  Character,
  CharacterView,
  ChoirDevice,
  ChoirInvite,
  ChoirState,
  ConnectCode,
  ConsentSessionView,
  DesignRequest,
  DeviceCapabilities,
  ExportState,
  HfState,
  HostState,
  MarkCheck,
  ModelState,
  NewInvite,
  ObsState,
  PeopleResponse,
  Project,
  Role,
  SetupStep,
  Shot,
  Snapshot,
  SpeakRequestInput,
  Still,
  StreamDestinationId,
  StreamDevices,
  StreamPreflight,
  StreamState,
  Take,
  TunnelReport,
  UpdateState,
  Voice,
  VoiceJob,
  VoiceModelState,
  VoiceState,
  VoiceUse,
} from '@hildegard/presets';

/** What the record page behind a link may know: what is asked of the person, and whether it can still be sent. */
export interface RecordLinkInfo {
  kind: 'voice' | 'video';
  purpose: string | null;
  expiresAt: string;
  state: 'pending' | 'received';
  maxBytes: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  /** What the owner can do about it, when the server says: a command or a page. */
  readonly fix: string | null;
  /** When the server needs to know which owner is meant: their names. */
  readonly owners: string[] | null;
  /** The server's machine-readable reason, such as `missing_model`, when it gives one. */
  readonly code: string | null;
  constructor(
    status: number,
    message: string,
    field?: string,
    fix?: string | null,
    owners?: string[] | null,
    code?: string | null,
  ) {
    super(message);
    this.owners = owners ?? null;
    this.code = code ?? null;
    this.status = status;
    this.field = field;
    this.fix = fix ?? null;
  }
}

/** Fired when the server says this browser's session is gone, so the Studio shows the sign-in page. */
export const SIGNED_OUT = 'hildegard:signed-out';

async function call<T>(method: string, path: string, body?: unknown, raw?: BodyInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      // The server refuses writes without this header; browsers cannot send it cross-site without a preflight.
      headers:
        method === 'GET'
          ? {}
          : { 'x-hildegard': '1', ...(raw ? {} : { 'content-type': 'application/json' }) },
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch {
    throw new ApiError(0, 'Hildegard is not answering. Is it still running on this computer?');
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T & {
    error?: string;
    field?: string;
    code?: string;
    fix?: string | null;
    owners?: unknown;
  };
  if (res.status === 401 && data.code === 'signin') window.dispatchEvent(new Event(SIGNED_OUT));
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.error ?? `Something went wrong (${res.status}).`,
      data.field,
      data.fix,
      Array.isArray(data.owners) ? data.owners.filter((o): o is string => typeof o === 'string') : null,
      typeof data.code === 'string' ? data.code : null,
    );
  return data;
}

/** What POST /api/images takes; the server checks every part. */
export interface ImageBody {
  prompt: string;
  aspect: string;
  quality: 'draft' | 'final';
  count: number;
  seed?: number;
  references?: string[];
  noRealPerson?: true;
  camera?: { body?: string; lens?: string; focal?: number; aperture?: number };
  look?: { lighting?: string; palette?: string; genre?: string; era?: string };
}

export interface UploadResult {
  name: string;
  url: string;
}
export interface AudioUpload {
  name: string;
  url: string;
  seconds: number;
}
/** A new consent session also carries the token the speaker's phone link uses. */
export type NewConsent = ConsentSessionView & { token: string | null };
/** What the speaker's phone sees: their name and the line, nothing else. */
export interface ConsentLink {
  speaker: string;
  line: string;
  expiresAt: string;
  recorded: boolean;
}
/** A license to accept before a voice model downloads, and those of the models it brings. */
export interface VoiceLicense {
  license: string;
  licenseUrl: string;
  terms: string[];
  also: Array<{ id: string; name: string; license: string; licenseUrl: string }>;
}

export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
}

/** What a real person's consent link asks them, for the page it opens. */
export interface LikenessAsk {
  character: string;
  maker: string;
  expiresAt: string;
  photos: CharacterView[];
  statement: string;
}

/** A website made here: imported, from a template, or written by an AI app. */
export interface SiteSummary {
  id: string;
  title: string;
  source: { kind: 'template' | 'figma' | 'pen' | 'url' | 'files' | 'empty'; from: string | null };
  createdAt: string;
  updatedAt: string;
  reference: { file: string; width: number } | null;
  notes: string[];
  pages: string[];
  files: number;
  bytes: number;
  /** Where its pages are served, framed only by the Studio. */
  preview: string;
  /** Whether everyone can read it at /s/<id>/. */
  published?: boolean;
}
export interface SiteDetail extends SiteSummary {
  fileList: Array<{ path: string; bytes: number }>;
}
export interface SiteTemplate {
  id: string;
  name: string;
  for: string;
  description: string;
  sections: string[];
  images: Array<{ file: string; aspect: string; prompt: string }>;
  type: { display: string; text: string };
  pages: string[];
}
export interface SiteToken {
  name: string;
  value: string;
  dark: boolean;
  file: string;
}
export type NewSite =
  | { from: 'empty'; title: string }
  | { from: 'template'; template: string; title?: string }
  | { from: 'figma'; url: string; title?: string }
  | { from: 'pen'; pen: string; images?: Record<string, string>; title?: string }
  | { from: 'url'; url: string; title?: string }
  | { from: 'zip'; data: string; title: string };

/** GET /api/talk */
export interface TalkStatus {
  ready: boolean;
  fake: boolean;
  problem: string | null;
  llm: { runtime: string; model: string } | null;
  capabilities: DeviceCapabilities;
  /** Where a turn that names no device runs: "local" or a joined device. */
  primary: string;
}

/** POST /api/talk/turn */
export interface TalkTurn {
  transcript: string;
  replyText: string;
  audio: { contentType: string; url?: string; data?: string };
  route: { stt: 'local' | 'remote'; llm: 'local' | 'remote'; tts: 'local' | 'remote' };
  /** How long each step took, and the whole turn, in milliseconds. */
  ms: { stt: number; llm: number; tts: number; total: number };
  /** Where it ran: "local" or a joined device's name. */
  device: string;
}

export interface WritingSample {
  id: string;
  title: string;
  source: string;
  addedAt: string;
  words: number;
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
export interface WritingState {
  person: string;
  voice: { md: string; updatedAt: string | null; versions: number };
  samples: WritingSample[];
  edits: WritingEdit[];
  topCut: Array<{ phrase: string; count: number }>;
}

export const api = {
  writing: () => call<WritingState>('GET', '/api/writing/voice'),
  setWritingVoice: (md: string) =>
    call<{ person: string; voice: WritingState['voice'] }>('PUT', '/api/writing/voice', { md }),
  addWritingSample: (body: { title: string; text: string; source?: string }) =>
    call<{ sample: WritingSample }>('POST', '/api/writing/samples', body),
  removeWritingSample: (id: string) => call<{ ok: true }>('DELETE', `/api/writing/samples/${id}`),
  sites: () =>
    call<{
      sites: SiteSummary[];
      templates: SiteTemplate[];
      figma: { linked: boolean };
      urlImport: boolean;
    }>('GET', '/api/sites'),
  site: (id: string) => call<SiteDetail>('GET', `/api/sites/${id}`),
  createSite: (body: NewSite) => call<SiteDetail>('POST', '/api/sites', body),
  renameSite: (id: string, title: string) => call<SiteDetail>('PATCH', `/api/sites/${id}`, { title }),
  deleteSite: (id: string) => call<{ ok: true }>('DELETE', `/api/sites/${id}`),
  figmaToken: (token: string) =>
    call<{ linked: boolean; as: string | null }>('PUT', '/api/sites/figma-token', { token }),
  figmaUnlink: () => call<{ linked: boolean }>('DELETE', '/api/sites/figma-token'),
  siteTokens: (id: string) => call<{ tokens: SiteToken[] }>('GET', `/api/sites/${id}/tokens`),
  setSiteToken: (id: string, t: { name: string; value: string; dark: boolean; file: string }) =>
    call<{ tokens: SiteToken[] }>('POST', `/api/sites/${id}/tokens`, t),
  siteText: (id: string, page: string, from: string, to: string) =>
    call<SiteDetail>('POST', `/api/sites/${id}/text`, { page, from, to }),

  snapshot: () => call<Snapshot>('GET', '/api/snapshot'),
  catalog: () => call<Catalog>('GET', '/api/catalog'),
  createProject: (title?: string) => call<Project>('POST', '/api/projects', { title }),
  renameProject: (id: string, title: string) => call<Project>('PATCH', `/api/projects/${id}`, { title }),
  exportFilm: (id: string) => call<ExportState>('POST', `/api/projects/${id}/export`),
  createShot: (body: { projectId?: string; shotId?: string; request: unknown }) =>
    call<{ project: Project; shot: Shot; takes: Take[] }>('POST', '/api/shots', body),
  renameShot: (id: string, title: string) => call<Shot>('PATCH', `/api/shots/${id}`, { title }),
  deleteShot: (id: string) => call<void>('DELETE', `/api/shots/${id}`),
  cancel: (id: string) => call<Take>('POST', `/api/takes/${id}/cancel`),
  force: (id: string, interrupt: boolean) => call<Take>('POST', `/api/takes/${id}/force`, { interrupt }),
  retry: (id: string) => call<Take>('POST', `/api/takes/${id}/retry`),
  keep: (id: string, kept: boolean) => call<Take>('POST', `/api/takes/${id}/keep`, { kept }),
  deleteTake: (id: string) => call<void>('DELETE', `/api/takes/${id}`),
  pause: () => call('POST', '/api/engine/pause'),
  resume: () => call('POST', '/api/engine/resume'),
  upload: (file: Blob) => call<UploadResult>('POST', '/api/uploads', undefined, file),
  installModel: (id: string, acceptLicense = false) =>
    call<ModelState[]>('POST', `/api/models/${id}/install`, { acceptLicense }),
  cancelModel: (id: string) => call<ModelState[]>('POST', `/api/models/${id}/cancel`),
  hfToken: (token: string) => call<HfState>('POST', '/api/hf/token', { token }),
  hfUnlink: () => call<HfState>('POST', '/api/hf/unlink'),
  updateCheck: () => call<UpdateState>('POST', '/api/update/check'),
  updateNow: () => call<UpdateState>('POST', '/api/update'),
  updateAuto: (auto: boolean) => call<UpdateState>('PUT', '/api/update', { auto }),
  hfImport: () => call<HfState>('POST', '/api/hf/import'),
  hfOAuth: () => call<{ url: string }>('POST', '/api/hf/oauth/start'),
  hfDevice: () => call<DeviceStart>('POST', '/api/hf/device'),
  agents: () => call<AgentsResponse>('GET', '/api/agents'),
  choir: () => call<ChoirState>('GET', '/api/choir'),
  choirTailnet: () => call<{ url: string | null }>('GET', '/api/choir/tailnet'),
  /** With `long`, only the long code is made: no short code is left live and unseen. */
  choirInvite: (url?: string, long?: boolean) =>
    call<ChoirInvite>('POST', '/api/choir/invite', {
      url,
      ...(long ? { long: true, short: false } : {}),
    }),
  /** A one-time code to approve a chatbot's connection (owners). */
  connectCode: (person?: string) => call<ConnectCode>('POST', '/api/auth/codes', person ? { person } : {}),
  choirRevoke: () => call<ChoirState>('POST', '/api/choir/revoke'),
  choirJoin: (code: string, url?: string) =>
    call<{ device: ChoirDevice; choir: ChoirState }>('POST', '/api/choir/join', { code, url }),
  choirLeave: (name: string) => call<ChoirState>('POST', '/api/choir/leave', { name }),
  choirUse: (name: string) => call<ChoirState>('POST', '/api/choir/use', { name }),
  choirPrimary: (name: string) => call<ChoirState>('POST', '/api/choir/primary', { name }),
  choirOpportunistic: (on: boolean) => call<ChoirState>('POST', '/api/choir/opportunistic', { on }),
  /** Update a joined device to the newest release. */
  choirUpdate: (name: string) =>
    call<{ device: ChoirDevice; choir: ChoirState }>('POST', '/api/choir/update', { name }),
  me: () => call<AuthState>('GET', '/api/auth/me'),
  signIn: (name: string, passphrase: string) =>
    call<AuthState>('POST', '/api/auth/signin', { name, passphrase }),
  signOut: () => call<AuthState>('POST', '/api/auth/signout'),
  checkInvite: (token: string) =>
    call<{ role: Role; expiresAt: string }>('GET', `/api/auth/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, name: string, passphrase: string) =>
    call<AuthState>('POST', `/api/auth/invite/${encodeURIComponent(token)}/accept`, { name, passphrase }),
  people: () => call<PeopleResponse>('GET', '/api/people'),
  makeOwner: (name: string, passphrase: string) =>
    call<PeopleResponse>('POST', '/api/people/owner', { name, passphrase }),
  invite: (role: Role) => call<NewInvite>('POST', '/api/people/invites', { role }),
  cancelInvite: (id: string) => call<PeopleResponse>('DELETE', `/api/people/invites/${id}`),
  setRole: (id: string, role: Role) => call<PeopleResponse>('PATCH', `/api/people/${id}`, { role }),
  removePerson: (id: string) => call<PeopleResponse>('DELETE', `/api/people/${id}`),
  setDirectorQueue: (directorQueue: number) =>
    call<PeopleResponse>('PATCH', '/api/people/settings', { directorQueue }),
  changePassphrase: (current: string, next: string) =>
    call<AuthState>('POST', '/api/auth/passphrase', { current, next }),
  host: () => call<HostState>('GET', '/api/host'),
  hostOn: (via: 'tailscale' | 'funnel' | 'quick') => call<HostState>('POST', '/api/host', { via }),
  cloudflareOn: (hostname: string) => call<HostState>('POST', '/api/host', { via: 'cloudflare', hostname }),
  tunnel: () => call<TunnelReport>('GET', '/api/tunnel'),
  cloudflareLogin: () =>
    call<{ done: boolean; url: string | null; opened: boolean }>('POST', '/api/tunnel/login', {
      provider: 'cloudflare',
    }),
  cloudflareInstall: () =>
    call<{ installed: boolean; version: string }>('POST', '/api/tunnel/install', { provider: 'cloudflare' }),
  hostOff: () => call<HostState>('POST', '/api/host/off'),
  createCharacter: (body: {
    name: string;
    description?: string;
    wardrobe?: string;
    likeness?: 'invented' | 'real';
  }) => call<Character>('POST', '/api/characters', body),
  editCharacter: (
    id: string,
    body: {
      name?: string;
      description?: string;
      wardrobe?: string;
      voice?: string | null;
      cover?: string | null;
    },
  ) => call<Character>('PATCH', `/api/characters/${id}`, body),
  deleteCharacter: (id: string) => call<void>('DELETE', `/api/characters/${id}`),
  addReference: (id: string, file: string, view: CharacterView | null) =>
    call<Character>('POST', `/api/characters/${id}/references`, { file, view, noRealPerson: true }),
  removeReference: (id: string, file: string) =>
    call<Character>('DELETE', `/api/characters/${id}/references/${file}`),
  makeStills: (id: string, body: { view: CharacterView; count?: number; note?: string }) =>
    call<{ character: Character; stills: Still[] }>('POST', `/api/characters/${id}/stills`, body),
  /** Images on their own: from words, or edits of up to four uploaded reference images. */
  makeImages: (body: ImageBody) => call<{ stills: Still[] }>('POST', '/api/images', body),
  forceStill: (id: string) => call<Still>('POST', `/api/stills/${id}/force`),
  keepStill: (id: string) => call<Character>('POST', `/api/stills/${id}/keep`),
  cancelStill: (id: string) => call<Still>('POST', `/api/stills/${id}/cancel`),
  retryStill: (id: string) => call<Still>('POST', `/api/stills/${id}/retry`),
  deleteStill: (id: string) => call<void>('DELETE', `/api/stills/${id}`),
  askConsent: (id: string, maker?: string) =>
    call<{ character: Character; url: string; local: boolean }>('POST', `/api/characters/${id}/consent`, {
      maker,
    }),
  revokeConsent: (id: string) => call<Character>('POST', `/api/characters/${id}/consent/revoke`),
  likeness: (token: string) => call<LikenessAsk>('GET', `/api/likeness/${encodeURIComponent(token)}`),
  giveLikeness: (token: string, person: string, photos: string[]) =>
    call<{ ok: true; revokeUrl: string }>('POST', `/api/likeness/${encodeURIComponent(token)}`, {
      person,
      agree: true,
      photos,
    }),
  declineLikeness: (token: string) => call('POST', `/api/likeness/${encodeURIComponent(token)}/decline`),
  revokeLikeness: (token: string) =>
    call<{ ok: true; character: string | null }>('POST', `/api/likeness/revoke/${encodeURIComponent(token)}`),
  /** The voice studio's voices, for a character to speak in: none where there is no voice studio. */
  voices: () =>
    call<
      Array<{
        id: string;
        name: string;
        kind: string;
        blurb: string;
        hue?: number;
        consent?: { status: string };
      }>
    >('GET', '/api/voice/voices')
      // A Hildegard without the voice studio answers with something else, or not at all.
      .then((v) => (Array.isArray(v) ? v : []))
      .catch((e) => {
        // The voices are the owner's.
        if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return [];
        throw e;
      }),
  linkAgent: (id: string, link: boolean) =>
    call<{ step: SetupStep; agents: AgentInfo[] }>(
      'POST',
      `/api/agents/${id}/${link ? 'connect' : 'disconnect'}`,
    ),
  voice: () => call<VoiceState>('GET', '/api/voice'),
  speak: (body: SpeakRequestInput) => call<VoiceJob>('POST', '/api/voice/speak', body),
  designVoice: (body: Partial<DesignRequest>) => call<VoiceJob>('POST', '/api/voice/design', body),
  keepDesign: (job: string, candidate: number, name: string) =>
    call<Voice>('POST', `/api/voice/design/${job}/keep`, { candidate, name }),
  convertVoice: (source: string, voice: string) =>
    call<VoiceJob>('POST', '/api/voice/convert', { source, voice }),
  transcribe: (source: string, language?: string) =>
    call<VoiceJob>('POST', '/api/voice/transcribe', { source, language }),
  dub: (source: string, language: string, voice: string) =>
    call<VoiceJob>('POST', '/api/voice/dub', { source, language, voice }),
  voiceJob: (id: string) => call<VoiceJob>('GET', `/api/voice/jobs/${id}`),
  cancelVoiceJob: (id: string) => call<VoiceJob>('POST', `/api/voice/jobs/${id}/cancel`),
  keepVoiceJob: (id: string, kept: boolean) => call<VoiceJob>('POST', `/api/voice/jobs/${id}/keep`, { kept }),
  deleteVoiceJob: (id: string) => call<void>('DELETE', `/api/voice/jobs/${id}`),
  previewVoice: (id: string) => call<VoiceJob | { audio: string }>('POST', `/api/voice/voices/${id}/preview`),
  renameVoice: (id: string, name: string) => call<Voice>('PATCH', `/api/voice/voices/${id}`, { name }),
  deleteVoice: (id: string) => call<void>('DELETE', `/api/voice/voices/${id}`),
  revokeVoice: (id: string) => call<Voice>('POST', `/api/voice/voices/${id}/revoke`),
  voiceUses: (id: string) => call<VoiceUse[]>('GET', `/api/voice/voices/${id}/uses`),
  talk: () => call<TalkStatus>('GET', '/api/talk'),
  /** One spoken turn: the recording goes up, the transcript, the answer and its audio come back. */
  /** One turn; `device` names a joined device to hear, answer and speak on instead of this computer. */
  talkTurn: (audio: Blob, opts: { language?: string; device?: string } = {}) => {
    const form = new FormData();
    form.set('audio', audio, 'turn');
    if (opts.language) form.set('language', opts.language);
    if (opts.device) form.set('device', opts.device);
    return call<TalkTurn>('POST', '/api/talk/turn', undefined, form);
  },
  uploadAudio: (file: Blob) => call<AudioUpload>('POST', '/api/voice/uploads', undefined, file),
  isOurs: (source: string) => call<MarkCheck>('POST', '/api/voice/check', { source }),
  installVoiceModel: (id: string, acceptLicense = false) =>
    call<VoiceModelState[]>('POST', `/api/voice/models/${id}/install`, { acceptLicense }),
  cancelVoiceModel: (id: string) => call<VoiceModelState[]>('POST', `/api/voice/models/${id}/cancel`),
  startConsent: (body: {
    speaker: string;
    relation: 'self' | 'agreed' | 'licensed';
    language?: string;
    until?: string | null;
  }) => call<NewConsent>('POST', '/api/voice/consent', body),
  consent: (id: string) => call<ConsentSessionView>('GET', `/api/voice/consent/${id}`),
  recordConsent: (id: string, audio: Blob) =>
    call<ConsentSessionView>('POST', `/api/voice/consent/${id}/recording`, undefined, audio),
  addSamples: (id: string, names: string[]) =>
    call<ConsentSessionView>('POST', `/api/voice/consent/${id}/samples`, { names }),
  removeSample: (id: string, name: string) =>
    call<ConsentSessionView>('DELETE', `/api/voice/consent/${id}/samples/${encodeURIComponent(name)}`),
  checkConsent: (id: string) => call<VoiceJob>('POST', `/api/voice/consent/${id}/check`),
  finishClone: (id: string, name: string) => call<Voice>('POST', `/api/voice/consent/${id}/finish`, { name }),
  consentLink: (token: string) => call<ConsentLink>('GET', `/api/consent/${encodeURIComponent(token)}`),
  // ── Go live ──
  stream: () => call<StreamState>('GET', '/api/stream'),
  streamSettings: (patch: Record<string, unknown>) => call<StreamState>('PUT', '/api/stream/settings', patch),
  /** The key goes in this request's body and nowhere else; nothing ever reads it back. */
  streamKey: (id: StreamDestinationId, key: string) =>
    call<StreamState>('PUT', `/api/stream/keys/${id}`, { key }),
  streamKeyRemove: (id: StreamDestinationId) => call<StreamState>('DELETE', `/api/stream/keys/${id}`),
  streamDevices: () => call<StreamDevices>('GET', '/api/stream/devices'),
  streamPreflight: () => call<StreamPreflight>('POST', '/api/stream/preflight'),
  streamPreview: (on: boolean) => call<StreamState>('POST', `/api/stream/preview/${on ? 'start' : 'stop'}`),
  streamGoLive: () => call<StreamState>('POST', '/api/stream/go-live'),
  streamCancel: () => call<StreamState>('POST', '/api/stream/cancel'),
  streamStop: () => call<StreamState>('POST', '/api/stream/stop'),
  streamLog: () => call<{ lines: string[] }>('GET', '/api/stream/log'),
  obs: () => call<ObsState & { passwordSaved: boolean }>('GET', '/api/stream/obs'),
  obsPassword: (password: string) =>
    call<ObsState & { passwordSaved: boolean }>('PUT', '/api/stream/obs/password', { password }),
  obsScene: (scene: string) =>
    call<ObsState & { passwordSaved: boolean }>('POST', '/api/stream/obs/scene', { scene }),
  obsStream: (on: boolean) =>
    call<ObsState & { passwordSaved: boolean }>('POST', `/api/stream/obs/${on ? 'start' : 'stop'}`),
  obsService: (destination: StreamDestinationId) =>
    call<ObsState & { passwordSaved: boolean }>('POST', '/api/stream/obs/service', { destination }),
  recordLinkInfo: (token: string) => call<RecordLinkInfo>('GET', `/api/record/${encodeURIComponent(token)}`),
  /** Sends the recording a link was made for. The link works once. */
  recordSend: (token: string, clip: Blob) =>
    call<{ received: boolean }>('POST', `/api/record/${encodeURIComponent(token)}`, undefined, clip),
  recordByLink: (token: string, audio: Blob) =>
    call<{ recorded: boolean }>(
      'POST',
      `/api/consent/${encodeURIComponent(token)}/recording`,
      undefined,
      audio,
    ),
};
