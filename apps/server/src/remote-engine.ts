// SPDX-License-Identifier: AGPL-3.0-only
import { createWriteStream } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type BuiltGraph,
  type Engine,
  EngineError,
  type EngineErrorCode,
  type RenderOptions,
} from '@hildegard/comfy';
import type { UpdateState } from '@hildegard/presets';

/** The detail on the error a device gives when it refuses this computer's key. */
export const REFUSED = 'key refused';

/** GET /api/node/info: what a sharing device says about itself. */
export interface NodeInfo {
  /** Random and stable, so a device can recognise its own code. */
  id: string;
  name: string;
  version: string;
  gpu: { name: string; vramGb: number | null } | null;
  /** Its ComfyUI answers. */
  online: boolean;
  /** It renders with the stand-in engine (tests): any model works, no real video. */
  fake: boolean;
  /** Models installed and verified there. */
  models: string[];
  /** How each model fits its GPU (null for the stand-in); missing from versions before it was added. */
  fit?: Record<string, 'fits' | 'tight' | 'no' | null>;
  /** Why a model won't run there, by model id; missing from versions before it was added. */
  fitWhy?: Record<string, 'memory' | 'apple-gpu' | null>;
  /** Takes and paired renders waiting there, the running one included. */
  queue: number;
  /** False while it renders on yet another device itself, so it takes no work. */
  accepting: boolean;
  /** Its updates; missing from versions before 0.1.9. */
  update?: UpdateState;
  /** It shares its GPU only while it's free; missing from versions before 0.1.11. */
  opportunistic?: boolean;
  /** Opportunistic and in use: why renders sent there wait, such as "Someone is using this computer."; or null. */
  busy?: string | null;
}

/** POST /api/node/render streams these, one JSON object per line. */
export type NodeEvent =
  | { type: 'accepted'; job: string }
  | { type: 'queued'; position: number | null }
  | { type: 'running' }
  | { type: 'progress'; value: number; step: number | null; steps: number | null; node: string | null }
  | { type: 'preview'; contentType: string; data: string }
  | { type: 'ping' }
  | { type: 'done'; media: string; bytes: number }
  | { type: 'error'; code: EngineErrorCode; message: string; detail: string };

export const ERROR_CODES: readonly EngineErrorCode[] = [
  'out_of_memory',
  'model_missing',
  'model_corrupt',
  'engine_offline',
  'invalid_graph',
  'node_failed',
  'content_blocked',
  'canceled',
  'unknown',
];

/** Longest line the client reads: a preview frame, base64, with room to spare. */
const MAX_LINE = 8 * 1024 * 1024;

/** Split a byte stream into JSON lines. */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    if (buf.length > MAX_LINE && !buf.includes('\n'))
      throw new Error('The device sent a line too long to read.');
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
      i = buf.indexOf('\n');
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

/** "NVIDIA GeForce RTX 4080 Laptop GPU" → "RTX 4080 Laptop". */
export function shortGpu(name: string): string {
  return name
    .replace(/^(NVIDIA|AMD)\s+/i, '')
    .replace(/^GeForce\s+/i, '')
    .replace(/\s+GPU$/i, '')
    .trim();
}

const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '');

/**
 * Renders on another of the owner's devices, through that device's Hildegard (/api/node/*), never its ComfyUI
 * directly. Events map onto the same handlers a local render calls; the video lands at opts.dest like a local one.
 */
export class RemoteEngine implements Engine {
  readonly url: string;
  readonly name: string;
  private readonly token: () => string | null;
  private readonly fetchFn: typeof fetch;
  private readonly onInfo: (info: NodeInfo | null, problem: string | null) => void;
  private readonly from: () => string | null;
  private last: NodeInfo | null = null;

  constructor(opts: {
    name: string;
    url: string;
    token: () => string | null;
    fetch?: typeof fetch;
    onInfo?: (info: NodeInfo | null, problem: string | null) => void;
    /** This computer's short name, for the other device's queue to show; display only. */
    from?: () => string | null;
  }) {
    this.url = opts.url.replace(/\/$/, '');
    this.name = opts.name;
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? fetch;
    this.onInfo = opts.onInfo ?? (() => {});
    this.from = opts.from ?? (() => null);
  }

  /** "parish1 · RTX 4080 Laptop" once it has said which GPU it has. */
  get device(): string {
    const gpu = this.last?.gpu?.name;
    return gpu ? `${this.name} · ${shortGpu(gpu)}` : this.name;
  }

  get fake(): boolean {
    return this.last?.fake ?? false;
  }

  /** Seed what is known about the device, so the first state shown already names its GPU. */
  known(info: NodeInfo) {
    this.last = info;
  }

  private offline(detail = ''): EngineError {
    return new EngineError(
      'engine_offline',
      `${this.name} isn’t answering.`,
      detail,
      `Check that Hildegard is running on ${this.name} and that both devices are on your tailnet. Takes wait and start once it answers.`,
    );
  }

  private refused(): EngineError {
    return new EngineError(
      'engine_offline',
      `${this.name} no longer accepts this computer.`,
      REFUSED,
      `On ${this.name}, open Settings › Devices and share its GPU again, then add the new code here.`,
    );
  }

  /** Advice that names the other device, where the usual advice would point at this one. */
  private hint(code: EngineErrorCode): string | undefined {
    if (code === 'model_missing' || code === 'model_corrupt')
      return `Install the model on ${this.name} (Settings › Models there), then retry.`;
    if (code === 'invalid_graph') return `Update Hildegard on ${this.name} to match this one, then retry.`;
    if (code === 'engine_offline') return `Check that ComfyUI is running on ${this.name}, then retry.`;
    if (code === 'out_of_memory')
      return `Try Draft quality or a shorter take, or close other apps using ${this.name}’s GPU.`;
    return undefined;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const token = this.token();
    if (!token) throw this.refused();
    return { authorization: `Bearer ${token}`, ...extra };
  }

  /** What the device says about itself. Throws an EngineError with a sentence when it can't be asked. */
  async info(): Promise<NodeInfo> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.url}/api/node/info`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(4000),
      });
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw this.offline((e as Error).message);
    }
    if (res.status === 401) throw this.refused();
    if (!res.ok) throw this.offline(`HTTP ${res.status}`);
    const info = (await res.json()) as NodeInfo;
    this.last = info;
    return info;
  }

  /** Asks the device to update to the newest release. Returns its update state; throws with a sentence when it can't. */
  async update(): Promise<UpdateState> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.url}/api/node/update`, {
        method: 'POST',
        headers: this.headers(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw this.offline((e as Error).message);
    }
    if (res.status === 401) throw this.refused();
    if (res.status === 404)
      throw new EngineError(
        'unknown',
        `${this.name} runs a Hildegard from before 0.1.9, which can’t be updated from here.`,
        '',
        `On ${this.name}, run \`hildegard update\` once. After that, update it from any of your devices.`,
      );
    const body = (await res.json().catch(() => ({}))) as { error?: string } & Partial<UpdateState>;
    if (!res.ok) throw new EngineError('unknown', `${this.name}: ${body.error ?? `HTTP ${res.status}`}`);
    return body as UpdateState;
  }

  /** Ready when the device answers, its ComfyUI does, and it takes work. */
  async ping(): Promise<boolean> {
    try {
      const info = await this.info();
      const problem = !info.online
        ? `${this.name} is up, but its ComfyUI isn’t answering yet.`
        : !info.accepting
          ? `${this.name} renders on another device itself, so it takes no work.`
          : null;
      this.onInfo(info, problem);
      return !problem;
    } catch (e) {
      this.onInfo(null, (e as Error).message);
      return false;
    }
  }

  async render(built: BuiltGraph, opts: RenderOptions): Promise<void> {
    const { signal, handlers = {} } = opts;
    if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
    const startFrame = opts.startFrame ? (await readFile(opts.startFrame)).toString('base64') : undefined;
    const references = opts.references?.length
      ? await Promise.all(opts.references.map(async (f) => (await readFile(f)).toString('base64')))
      : undefined;
    const ac = new AbortController();
    let job: string | null = null;
    const onAbort = () => {
      // Say so, then hang up: either one stops the render there.
      if (job)
        void this.fetchFn(`${this.url}/api/node/render/${job}/cancel`, {
          method: 'POST',
          headers: this.headers(),
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      ac.abort();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.url}/api/node/render`, {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({
            built,
            startFrame,
            references,
            from: this.from() ?? undefined,
            quality: opts.quality,
          }),
          signal: ac.signal,
        });
      } catch (e) {
        if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
        if (e instanceof EngineError) throw e;
        throw this.offline((e as Error).message);
      }
      if (res.status === 401) throw this.refused();
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; code?: EngineErrorCode };
        const code = body.code && ERROR_CODES.includes(body.code) ? body.code : 'node_failed';
        throw new EngineError(
          code,
          clip(body.error, 300) || `${this.name} refused the take.`,
          '',
          this.hint(code),
        );
      }

      let media: string | null = null;
      try {
        for await (const raw of lines(res.body)) {
          const ev = raw as NodeEvent;
          switch (ev.type) {
            case 'accepted':
              job = /^[a-f0-9]{32}$/.test(ev.job) ? ev.job : null;
              break;
            case 'queued':
              handlers.onQueued?.(typeof ev.position === 'number' ? ev.position : null);
              break;
            case 'running':
              handlers.onRunning?.();
              break;
            case 'progress':
              handlers.onProgress?.({
                value: Math.min(1, Math.max(0, Number(ev.value) || 0)),
                step: typeof ev.step === 'number' ? ev.step : null,
                steps: typeof ev.steps === 'number' ? ev.steps : null,
                node: typeof ev.node === 'string' ? ev.node.slice(0, 80) : null,
              });
              break;
            case 'preview':
              if (/^image\/(jpeg|png|webp)$/.test(ev.contentType))
                handlers.onPreview?.(new Uint8Array(Buffer.from(ev.data, 'base64')), ev.contentType);
              break;
            case 'done':
              media = /^[a-f0-9]{32}$/.test(ev.media) ? ev.media : null;
              break;
            case 'error': {
              const code = ERROR_CODES.includes(ev.code) ? ev.code : 'unknown';
              throw new EngineError(
                code,
                clip(ev.message, 300) || 'Something went wrong.',
                clip(ev.detail, 4000),
                this.hint(code),
              );
            }
          }
        }
      } catch (e) {
        if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
        if (e instanceof EngineError) throw e;
        throw this.offline(`The connection dropped: ${(e as Error).message}`);
      }
      if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
      if (!media) throw this.offline('The connection ended before the take finished.');

      let video: Response;
      try {
        video = await this.fetchFn(`${this.url}/api/node/media/${media}`, {
          headers: this.headers(),
          signal: ac.signal,
        });
      } catch (e) {
        if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
        throw this.offline((e as Error).message);
      }
      if (!video.ok || !video.body)
        throw new EngineError('node_failed', `${this.name} finished the render but couldn’t send it.`);
      try {
        await pipeline(Readable.fromWeb(video.body as never), createWriteStream(opts.dest), {
          signal: ac.signal,
        });
      } catch (e) {
        await rm(opts.dest, { force: true });
        if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
        throw this.offline(`The file stopped halfway: ${(e as Error).message}`);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
