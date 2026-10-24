// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentInfo,
  AgentsResponse,
  AuthState,
  Catalog,
  ChoirDevice,
  ChoirState,
  ExportState,
  HfState,
  HostState,
  ModelState,
  NewInvite,
  PeopleResponse,
  Project,
  Role,
  SetupStep,
  Shot,
  Snapshot,
  Take,
  UpdateState,
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
export interface DeviceStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
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
  linkAgent: (id: string, link: boolean) =>
    call<{ step: SetupStep; agents: AgentInfo[] }>(
      'POST',
      `/api/agents/${id}/${link ? 'connect' : 'disconnect'}`,
    ),
};
