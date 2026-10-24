// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import type {
  Catalog,
  ExportState,
  Project,
  Shot,
  ShotRequestInput,
  Snapshot,
  Take,
} from '@hildegard/presets';

export class HildegardError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export interface ShotDetail {
  shot: Shot;
  takes: Take[];
  /** Take id → the finished video's path on the computer Hildegard runs on. */
  files: Record<string, string>;
  /** The film the shot is in. */
  project: { id: string; title: string };
}

/** Talks to the Hildegard server on this computer, as the Studio does. */
export class HildegardClient {
  readonly url: string;
  private readonly fetchFn: typeof fetch;

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
  exportFilm = (id: string) =>
    this.call<ExportState>('POST', `/api/projects/${encodeURIComponent(id)}/export`);
  exportState = (id: string) =>
    this.call<ExportState & { file: string | null }>('GET', `/api/exports/${encodeURIComponent(id)}`);
  installModel = (id: string, acceptLicense: boolean) =>
    this.call<unknown>('POST', `/api/models/${encodeURIComponent(id)}/install`, { acceptLicense });

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
  async poster(take: Take): Promise<{ data: string; mimeType: string } | null> {
    if (!take.poster) return null;
    const res = await this.fetchFn(`${this.url}${take.poster}`).catch(() => null);
    if (!res?.ok) return null;
    return { data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: 'image/jpeg' };
  }
}
