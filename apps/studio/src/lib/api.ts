// SPDX-License-Identifier: AGPL-3.0-only
import type {
  AgentInfo,
  AgentsResponse,
  Catalog,
  ChoirDevice,
  ChoirState,
  ExportState,
  HfState,
  ModelState,
  Project,
  SetupStep,
  Shot,
  Snapshot,
  Take,
} from '@hildegard/presets';

export class ApiError extends Error {
  readonly status: number;
  readonly field: string | undefined;
  constructor(status: number, message: string, field?: string) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

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
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; field?: string };
  if (!res.ok)
    throw new ApiError(res.status, data.error ?? `Something went wrong (${res.status}).`, data.field);
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
  linkAgent: (id: string, link: boolean) =>
    call<{ step: SetupStep; agents: AgentInfo[] }>(
      'POST',
      `/api/agents/${id}/${link ? 'connect' : 'disconnect'}`,
    ),
};
