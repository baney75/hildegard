// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import type {
  Catalog,
  Character,
  CharacterView,
  ExportState,
  MarkCheck,
  Project,
  Shot,
  ShotRequestInput,
  Snapshot,
  Still,
  Take,
  Voice,
  VoiceJob,
  VoiceState,
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
  keepStill = (id: string) => this.call<Character>('POST', `/api/stills/${encodeURIComponent(id)}/keep`);
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
