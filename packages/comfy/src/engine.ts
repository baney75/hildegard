import { Comfy, type Job } from '@comfyorg/sdk';
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
}

export type EngineErrorCode =
  | 'out_of_memory'
  | 'model_missing'
  | 'model_corrupt'
  | 'engine_offline'
  | 'invalid_graph'
  | 'node_failed'
  | 'canceled'
  | 'unknown';

/** A render failure, sorted into something the UI can explain in a sentence. */
export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail: string;
  constructor(code: EngineErrorCode, message: string, detail = '') {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

export interface Engine {
  /** Where renders go, for the UI and `hildegard status`. */
  readonly url: string;
  render(built: BuiltGraph, opts: RenderOptions): Promise<void>;
  ping(): Promise<boolean>;
}

/** Map a ComfyUI failure into a code and a plain sentence. */
export function classifyFailure(code: string | undefined, message: string | undefined): EngineError {
  const text = `${code ?? ''} ${message ?? ''}`;
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
    } finally {
      if (prevUrl === undefined) delete process.env.COMFY_BASE_URL;
      else process.env.COMFY_BASE_URL = prevUrl;
      if (prevKey !== undefined) process.env.COMFY_API_KEY = prevKey;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.url}/api/v2/jobs/hildegard-ping`, {
        signal: AbortSignal.timeout(2000),
      });
      return res.status === 404 || res.ok;
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
        for await (const ev of job.events(signal)) {
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
            handlers.onProgress?.({
              value: ev.value,
              step: ev.step,
              steps: ev.steps,
              node: ev.currentNodeClass,
            });
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
