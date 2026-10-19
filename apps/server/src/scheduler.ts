import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type BuiltGraph, buildLtxGraph, type Engine, EngineError } from '@hildegard/comfy';
import { type Catalog, composeShot, type EngineState, type Take, type TakeError } from '@hildegard/presets';
import type { Store } from './store.ts';

const RANK = { forced: 0, interactive: 1, agent: 2 } as const;

/** Plain-language fixes for each failure. */
export function explain(e: unknown): TakeError {
  const err = e instanceof EngineError ? e : new EngineError('unknown', 'Something went wrong.', String(e));
  const hint: Record<string, string> = {
    out_of_memory: 'Try Draft quality or a shorter take, or close other apps using the GPU.',
    model_missing: 'Install the model in Settings, then retry.',
    model_corrupt: 'Reinstall the model in Settings; Hildegard checks every file when it downloads.',
    engine_offline: 'Start ComfyUI with `hildegard start`, then retry.',
    invalid_graph: 'Run `hildegard install` to add the missing ComfyUI nodes, then retry.',
    node_failed: 'Retry. If it fails again, the details say which step stopped.',
    canceled: 'Retry when you want it.',
    unknown: 'Retry. If it fails again, the details say what happened.',
  };
  return {
    code: err.code,
    message: err.message,
    hint: hint[err.code] ?? hint.unknown!,
    detail: err.detail || undefined,
  };
}

/**
 * One GPU, one render at a time. Forced takes go first, then studio work, then agent work; within a class, oldest
 * first. Force now stops a lower-priority render, which goes back to the front of its class.
 */
export class Scheduler {
  private running: { take: Take; abort: AbortController; requeue: boolean } | null = null;
  private paused = false;
  private online = false;
  readonly previews = new Map<string, { bytes: Uint8Array; type: string }>();
  private readonly onEngine: (s: EngineState) => void;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly store: Store;
  private readonly engine: Engine;
  private readonly catalog: Catalog;
  private readonly mediaDir: string;
  private readonly fake: boolean;

  constructor(opts: {
    store: Store;
    engine: Engine;
    catalog: Catalog;
    mediaDir: string;
    fake: boolean;
    onEngine: (s: EngineState) => void;
  }) {
    this.store = opts.store;
    this.engine = opts.engine;
    this.catalog = opts.catalog;
    this.mediaDir = opts.mediaDir;
    this.fake = opts.fake;
    this.onEngine = opts.onEngine;
  }

  engineState(): EngineState {
    return {
      online: this.online,
      url: this.engine.url,
      fake: this.fake,
      paused: this.paused,
      device: 'This computer',
    };
  }

  /** Watch ComfyUI: quickly while it is down, rarely while it is up. */
  start() {
    const tick = async () => {
      const was = this.online;
      this.online = await this.engine.ping();
      if (was !== this.online) {
        this.onEngine(this.engineState());
        if (this.online) this.pump();
      }
      this.pingTimer = setTimeout(tick, this.online ? 10_000 : 2_000);
      this.pingTimer.unref?.();
    };
    void tick();
  }

  stop() {
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.running?.abort.abort();
  }

  setPaused(paused: boolean) {
    this.paused = paused;
    this.onEngine(this.engineState());
    if (!paused) this.pump();
  }

  queued(): Take[] {
    return [...this.store.takes.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
  }

  /** Recompute queue positions and tell the UI about any that moved. */
  private renumber() {
    this.queued().forEach((t, i) => {
      const pos = i + (this.running ? 1 : 0);
      if (t.queuePosition !== pos) {
        t.queuePosition = pos;
        this.store.putTake(t, true);
      }
    });
  }

  enqueue(take: Take) {
    this.store.putTake(take);
    this.renumber();
    this.pump();
  }

  cancel(id: string): boolean {
    const t = this.store.takes.get(id);
    if (!t) return false;
    if (this.running?.take.id === id) {
      this.running.requeue = false;
      this.running.abort.abort();
      return true;
    }
    if (t.status !== 'queued') return false;
    t.status = 'canceled';
    t.queuePosition = null;
    t.finishedAt = new Date().toISOString();
    t.error = explain(new EngineError('canceled', 'Canceled.'));
    this.store.putTake(t);
    this.renumber();
    return true;
  }

  /** `interrupt` stops whatever is rendering (it restarts later); otherwise the take just runs next. */
  force(id: string, interrupt: boolean): boolean {
    const t = this.store.takes.get(id);
    if (t?.status !== 'queued') return false;
    t.priority = 'forced';
    t.createdAt = new Date().toISOString();
    this.store.putTake(t);
    if (interrupt && this.running && this.running.take.priority !== 'forced') {
      this.running.requeue = true;
      this.running.abort.abort();
    }
    this.renumber();
    this.pump();
    return true;
  }

  retry(id: string): Take | null {
    const t = this.store.takes.get(id);
    if (!t || (t.status !== 'failed' && t.status !== 'canceled')) return null;
    Object.assign(t, {
      status: 'queued',
      error: null,
      progress: null,
      startedAt: null,
      finishedAt: null,
      renderMs: null,
      createdAt: new Date().toISOString(),
    } satisfies Partial<Take>);
    this.enqueue(t);
    return t;
  }

  /** Start the next take if the GPU is free. */
  pump() {
    if (this.running || this.paused || !this.online) return;
    const next = this.queued()[0];
    if (!next) return;
    void this.run(next);
  }

  private async run(take: Take) {
    const abort = new AbortController();
    this.running = { take, abort, requeue: false };
    take.status = 'running';
    take.queuePosition = 0;
    take.startedAt = new Date().toISOString();
    take.progress = { value: 0, step: null, steps: null };
    take.error = null;
    this.store.putTake(take);
    this.renumber();

    const started = Date.now();
    const dest = join(this.mediaDir, `${take.id}.mp4`);
    try {
      const shot = composeShot(this.catalog, take.request);
      const built: BuiltGraph = buildLtxGraph({
        shot,
        seed: take.seed,
        prefix: `hildegard/${take.id}`,
        startFrame: take.request.startFrame ? 'start.png' : undefined,
      });
      let lastProgressAt = 0;
      await this.engine.render(built, {
        dest,
        signal: abort.signal,
        startFrame: take.request.startFrame
          ? join(this.mediaDir, 'uploads', take.request.startFrame)
          : undefined,
        handlers: {
          onProgress: (p) => {
            take.progress = { value: p.value, step: p.step, steps: p.steps };
            const now = Date.now();
            // The UI animates between updates, so ~6 per second is plenty.
            if (now - lastProgressAt > 160 || p.value >= 1) {
              lastProgressAt = now;
              this.store.putTake(take, true);
            }
          },
          onPreview: (bytes, type) => {
            this.previews.set(take.id, { bytes, type });
            take.previewVersion++;
            this.store.putTake(take, true);
          },
        },
      });
      const preview = this.previews.get(take.id);
      if (preview) {
        await writeFile(join(this.mediaDir, `${take.id}.jpg`), preview.bytes);
        take.poster = `/media/${take.id}.jpg`;
      }
      const { size } = await import('node:fs/promises').then((fs) => fs.stat(dest));
      Object.assign(take, {
        status: 'done',
        video: `/media/${take.id}.mp4`,
        bytes: size,
        progress: { value: 1, step: take.progress?.steps ?? null, steps: take.progress?.steps ?? null },
      } satisfies Partial<Take>);
    } catch (e) {
      const requeue = this.running?.requeue;
      if (requeue) {
        // Interrupted by Force now: back to the front of its class, no error shown.
        Object.assign(take, { status: 'queued', progress: null, startedAt: null } satisfies Partial<Take>);
      } else {
        take.status = e instanceof EngineError && e.code === 'canceled' ? 'canceled' : 'failed';
        take.error = explain(e);
      }
    } finally {
      // Set inside the try/catch above; TypeScript cannot see that.
      const requeued = (take.status as Take['status']) === 'queued';
      if (!requeued) {
        take.queuePosition = null;
        take.finishedAt = new Date().toISOString();
        take.renderMs = Date.now() - started;
        // A stopped take keeps its last frame as a poster, so the card shows where it got to.
        const last = this.previews.get(take.id);
        if (last && !take.poster) {
          await writeFile(join(this.mediaDir, `${take.id}.jpg`), last.bytes).catch(() => {});
          take.poster = `/media/${take.id}.jpg`;
        }
        this.previews.delete(take.id);
      }
      this.store.putTake(take);
      this.running = null;
      this.renumber();
      this.pump();
    }
  }
}
