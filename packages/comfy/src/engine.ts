// SPDX-License-Identifier: AGPL-3.0-only
import { Comfy, type ComfyEvent, type Job, type Progress } from '@comfyorg/sdk';
import { ComfyLow } from '@comfyorg/sdk/low';
import type { BuiltGraph } from './graph.ts';

export interface RenderProgress {
  /** 0..1 across the whole graph. */
  value: number;
  step: number | null;
  steps: number | null;
  node: string | null;
}

export interface RenderHandlers {
  onQueued?(position: number | null): void;
  onRunning?(): void;
  onProgress?(p: RenderProgress): void;
  onPreview?(bytes: Uint8Array, contentType: string): void;
}

export interface RenderOptions {
  /** Local path of a start frame to upload and bind to the graph's LoadImage node. */
  startFrame?: string;
  /** Where to write the finished video. */
  dest: string;
  signal?: AbortSignal;
  handlers?: RenderHandlers;
  /** The take's quality, for another device's queue to show when it renders there; graphs don't say. */
  quality?: 'draft' | 'final';
}

export type EngineErrorCode =
  | 'out_of_memory'
  | 'model_missing'
  | 'model_corrupt'
  | 'engine_offline'
  | 'invalid_graph'
  | 'node_failed'
  | 'content_blocked'
  | 'canceled'
  | 'unknown';

/** A render failure, sorted into something the UI can explain in a sentence. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail: string;
  /** What to do about it, when the usual advice for the code would be wrong (another device's, say). */
  readonly hint: string | undefined;
  constructor(code: EngineErrorCode, message: string, detail = '', hint?: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
    this.hint = hint;
  }
}

export interface Engine {
  /** Where renders go, for the UI and `hildegard status`. */
  readonly url: string;
  /** Which device renders, for people ("parish1 · RTX 4080 Laptop"); this computer when unset. */
  readonly device?: string;
  /** The device renders with the stand-in engine, so any model works and no real video is made. */
  readonly fake?: boolean;
  render(built: BuiltGraph, opts: RenderOptions): Promise<void>;
  ping(): Promise<boolean>;
}

/** Map a ComfyUI failure into a code and a plain sentence. */
export function classifyFailure(code: string | undefined, message: string | undefined): EngineError {
  const text = `${code ?? ''} ${message ?? ''}`;
  // Hildegard's safety check stopped it (comfy-nodes/hildegard_guard). Its own missing-classifier message says so.
  const guard = /HildegardGuard: ([^\n]*)/.exec(text);
  if (guard)
    return /classifier is missing/.test(guard[1]!)
      ? new EngineError(
          'model_missing',
          'The safety classifier isn’t installed, so nothing can render.',
          guard[1],
        )
      : new EngineError(
          'content_blocked',
          /start frame/.test(guard[1]!)
            ? 'Hildegard refused this start frame: it looks sexual.'
            : 'Hildegard refused this take: a frame looked sexual, so it was deleted.',
          guard[1],
        );
  if (
    /out[ _]of[ _]memory|OutOfMemory|CUDA out of memory|Allocation on device|MPS backend out of memory/i.test(
      text,
    )
  )
    return new EngineError('out_of_memory', 'Your GPU ran out of memory.', message);
  if (/deserializing header|header too small|incomplete metadata|invalid load key|unexpected EOF/i.test(text))
    return new EngineError('model_corrupt', 'A model file is damaged or only partly downloaded.', message);
  if (
    /value_not_in_list|not in list|No such file|FileNotFoundError|ckpt_name|unet_name|clip_name|vae_name|lora_name/i.test(
      text,
    )
  )
    return new EngineError('model_missing', 'A model file this shot needs is not installed.', message);
  if (
    /invalid_workflow|missing_node_type|not found.*node|Cannot execute because a node is missing/i.test(text)
  )
    return new EngineError('invalid_graph', 'ComfyUI is missing a node this shot needs.', message);
  return new EngineError('node_failed', 'ComfyUI stopped with an error.', message ?? code ?? '');
}

/**
 * Talks to ComfyUI through Comfy's own SDK and comfy-api-proxy. The SDK falls back to Comfy Cloud when no base URL
 * is set, which would send prompts off the machine, so this refuses to start without an explicit local URL.
 */
export class ComfySdkEngine implements Engine {
  readonly url: string;
  private readonly client: Comfy;
  /** For the raw event stream: `Job.events()` drops any progress frame lower than the last, see {@link liveEvents}. */
  private readonly low: ComfyLow;

  constructor(baseUrl: string) {
    const u = new URL(baseUrl);
    if (!/^https?:$/.test(u.protocol)) throw new Error(`ComfyUI URL must be http(s): ${baseUrl}`);
    if (/(^|\.)comfy\.org$/i.test(u.hostname))
      throw new Error('Hildegard renders on your own ComfyUI; cloud endpoints are not allowed here.');
    this.url = u.origin;
    // The SDK reads its base URL from the environment at construction, and would send COMFY_API_KEY to whatever
    // that names. Hildegard never uses a Comfy account, so neither may leak in.
    const prevUrl = process.env.COMFY_BASE_URL;
    const prevKey = process.env.COMFY_API_KEY;
    process.env.COMFY_BASE_URL = this.url;
    delete process.env.COMFY_API_KEY;
    try {
      this.client = new Comfy({ clientInfo: 'hildegard' } as ConstructorParameters<typeof Comfy>[0]);
      this.low = new ComfyLow(this.url, undefined, { clientInfo: 'hildegard' });
    } finally {
      if (prevUrl === undefined) delete process.env.COMFY_BASE_URL;
      else process.env.COMFY_BASE_URL = prevUrl;
      if (prevKey !== undefined) process.env.COMFY_API_KEY = prevKey;
    }
  }

  /**
   * Whether a job sent now would run: comfy-api-proxy answers *and* the ComfyUI behind it does. The proxy's own
   * health check doesn't look upstream, so ask it which ComfyUI it fronts and check that one.
   */
  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/v2/health`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) return false;
      const { upstream } = (await res.json()) as { upstream?: string };
      if (!upstream) return true;
      const comfy = await fetch(`${upstream.replace(/\/$/, '')}/system_stats`, {
        signal: AbortSignal.timeout(2000),
      });
      return comfy.ok;
    } catch {
      return false;
    }
  }

  async render(built: BuiltGraph, opts: RenderOptions): Promise<void> {
    const { signal, handlers = {} } = opts;
    const wf = this.client.workflows.fromJson(structuredClone(built.graph) as never);
    if (opts.startFrame) {
      if (!built.startFrameNode) throw new EngineError('invalid_graph', 'This graph takes no start frame.');
      wf.setInput(built.startFrameNode, 'image', this.client.assets.fromFile(opts.startFrame));
    }

    let job: Job;
    try {
      job = await this.client.submit(wf, { signal });
    } catch (e) {
      throw this.wrap(e);
    }
    const onAbort = () => void job.cancel().catch(() => {});
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      handlers.onQueued?.(job.queuePosition ?? null);
      let started = false;
      try {
        for await (const ev of this.liveEvents(job, signal)) {
          if (ev.kind === 'statusChange') {
            if (ev.status === 'queued') handlers.onQueued?.(ev.queuePosition);
            if (ev.status === 'running' && !started) {
              started = true;
              handlers.onRunning?.();
            }
          } else if (ev.kind === 'progress') {
            if (!started) {
              started = true;
              handlers.onRunning?.();
            }
            const value = progressOf(ev);
            if (value !== null)
              handlers.onProgress?.({ value, step: ev.step, steps: ev.steps, node: ev.currentNodeClass });
          } else if (ev.kind === 'preview' && ev.data.length) {
            handlers.onPreview?.(ev.data, ev.contentType);
          }
        }
      } catch (e) {
        if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
        // The event stream is best effort; the job's own state below is the authority.
        void e;
      }
      if (signal?.aborted) throw new EngineError('canceled', 'Canceled.');
      await job.wait({ signal } as never).catch(() => {});
      await job.refresh(signal);
      if (job.status === 'canceled' || job.status === 'canceling')
        throw new EngineError('canceled', 'Canceled.');
      if (job.status !== 'succeeded') throw classifyFailure(job.error?.code, job.error?.message);
      // comfy-api-proxy 0.1.6 labels SaveVideo files type "image", so trust the content type.
      const isVideo = (o: { type: string; contentType: string }) =>
        o.type === 'video' || o.contentType.startsWith('video/');
      const output = job.getOutputs(built.outputNode).find(isVideo) ?? job.outputs.find(isVideo);
      if (!output) throw new EngineError('node_failed', 'ComfyUI finished but saved no video.');
      await output.toFile(opts.dest, { signal });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The job's live events, every progress frame included. The SDK's own `Job.events()` keeps progress monotonic by
   * `value`, but comfy-api-proxy's `value` reads 1 once the text encoders finish and then drops back while sampling,
   * so through it no sampler step ever arrives. Reconnects a few times, without replay, like the SDK.
   */
  private async *liveEvents(job: Job, signal?: AbortSignal): AsyncGenerator<ComfyEvent, void, void> {
    const url = job.urls.events || job.id;
    for (let drops = 0; drops < 4; drops++) {
      try {
        for await (const raw of this.low.getJobEvents(url, { signal })) {
          const data = raw.data;
          if (raw.event === 'progress') yield progressFrame(data);
          else if (raw.event === 'status') {
            const status = typeof data.status === 'string' ? data.status : '';
            const queuePosition = typeof data.queue_position === 'number' ? data.queue_position : null;
            yield { kind: 'statusChange', status, queuePosition };
            if (TERMINAL.has(status)) return;
          } else if (raw.event === 'preview' && typeof data.data_base64 === 'string') {
            yield {
              kind: 'preview',
              nodeId: typeof data.node_id === 'string' ? data.node_id : '',
              contentType:
                typeof data.content_type === 'string' ? data.content_type : 'application/octet-stream',
              data: new Uint8Array(Buffer.from(data.data_base64, 'base64')),
            };
          }
        }
      } catch (e) {
        if (signal?.aborted) throw e;
      }
      await job.refresh(signal);
      if (TERMINAL.has(job.status)) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private wrap(e: unknown): EngineError {
    if (e instanceof EngineError) return e;
    const err = e as { code?: string; message?: string; name?: string; cause?: { code?: string } };
    const msg = err?.message ?? String(e);
    if (
      /ECONNREFUSED|fetch failed|ENOTFOUND|EHOSTUNREACH|ConnectionError/i.test(
        `${msg} ${err?.cause?.code ?? ''} ${err?.name}`,
      )
    )
      return new EngineError('engine_offline', 'ComfyUI is not running.', msg);
    if (err?.name === 'AbortError') return new EngineError('canceled', 'Canceled.');
    return classifyFailure(err?.code, msg);
  }
}

const TERMINAL = new Set(['succeeded', 'failed', 'canceled']);

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function progressFrame(data: Record<string, unknown>): Progress {
  return {
    kind: 'progress',
    value: num(data.value) ?? 0,
    message: typeof data.message === 'string' ? data.message : null,
    nodesDone: num(data.nodes_done),
    nodesTotal: num(data.nodes_total),
    currentNode: typeof data.current_node === 'string' ? data.current_node : null,
    currentNodeClass: typeof data.current_node_class === 'string' ? data.current_node_class : null,
    step: num(data.step),
    steps: num(data.steps),
  };
}

/**
 * How far a render is, 0 to 1, from one progress frame: the sampler's steps, and nothing else. The proxy's `value`
 * and its node counts are guesses about a graph it hasn't finished walking (they read 100% after the text encoders),
 * so outside sampling, while models load or the video decodes, this is null and the UI shows it as working, not as a
 * number.
 */
export function progressOf(ev: { step: number | null; steps: number | null }): number | null {
  if (ev.step === null || !ev.steps) return null;
  return Math.min(1, Math.max(0, ev.step / ev.steps));
}
