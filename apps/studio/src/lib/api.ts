// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentInfo,
  AgentsResponse,
  AuthState,
  Catalog,
  Character,
  CharacterView,
  ChoirDevice,
  ChoirState,
  ConsentSessionView,
  DesignRequest,
  ExportState,
  HfState,
  HostState,
  MarkCheck,
  ModelState,
  NewInvite,
  PeopleResponse,
  Project,
  Role,
  SetupStep,
  Shot,
  Snapshot,
  SpeakRequestInput,
  Still,
  Take,
  UpdateState,
  Voice,
  VoiceJob,
  VoiceModelState,
  VoiceState,
  VoiceUse,
} from '@hildegard/presets';

export class ApiError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  /** What the owner can do about it, when the server says: a command or a page. */
  readonly fix: string | null;
  constructor(status: number, message: string, field?: string, fix?: string | null) {
    super(message);
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
  };
  if (res.status === 401 && data.code === 'signin') window.dispatchEvent(new Event(SIGNED_OUT));
  if (!res.ok)
    throw new ApiError(
      res.status,
      data.error ?? `Something went wrong (${res.status}).`,
      data.field,
      data.fix,
    );
  return data;
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

export const api = {
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
  choirInvite: (url?: string) => call<{ code: string; url: string }>('POST', '/api/choir/invite', { url }),
  choirRevoke: () => call<ChoirState>('POST', '/api/choir/revoke'),
  choirJoin: (code: string) =>
    call<{ device: ChoirDevice; choir: ChoirState }>('POST', '/api/choir/join', { code }),
  choirLeave: (name: string) => call<ChoirState>('POST', '/api/choir/leave', { name }),
  choirUse: (name: string) => call<ChoirState>('POST', '/api/choir/use', { name }),
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
  hostOn: (via: 'tailscale' | 'funnel') => call<HostState>('POST', '/api/host', { via }),
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
  recordByLink: (token: string, audio: Blob) =>
    call<{ recorded: boolean }>(
      'POST',
      `/api/consent/${encodeURIComponent(token)}/recording`,
      undefined,
      audio,
    ),
};
