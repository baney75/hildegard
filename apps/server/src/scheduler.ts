// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type BuiltGraph, buildGraph, type Engine, EngineError, type RenderHandlers } from '@hildegard/comfy';
import {
  type Catalog,
  composeShot,
  type EngineState,
  type GuestTake,
  loadSafety,
  type Priority,
  type SafetyCheck,
  type Take,
  type TakeError,
} from '@hildegard/presets';
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
    content_blocked: 'Change the prompt or the start frame. Hildegard doesn’t make sexual content.',
    canceled: 'Retry when you want it.',
    unknown: 'Retry. If it fails again, the details say what happened.',
  };
  return {
    code: err.code,
    message: err.message,
    hint: err.hint ?? hint[err.code] ?? hint.unknown!,
    detail: err.detail || undefined,
  };
}

/** A render a paired device sent (Choir): it waits in this computer's queue like a studio take. */
export interface GuestRender {
  /** The sending device's name, sanitized: display only. */
  from: string | null;
  quality: 'draft' | 'final' | null;
  built: BuiltGraph;
  /** Local path of its start frame. */
  startFrame?: string;
  dest: string;
  /** Aborted when the other device cancels or hangs up. */
  signal: AbortSignal;
  handlers: RenderHandlers;
}

interface Guest {
  id: string;
  createdAt: string;
  position: number | null;
  /** 0 to 1 once it renders. */
  progress: number | null;
  job: GuestRender;
  resolve: () => void;
  reject: (e: unknown) => void;
}

/**
 * One GPU, one render at a time. Forced takes go first, then studio work, then agent work; within a class, oldest
 * first. Force now stops a lower-priority render, which goes back to the front of its class. Renders from paired
 * devices queue here too, as studio work, so they never run alongside a local take.
 */
export class Scheduler {
  private running: { id: string; priority: Priority; abort: AbortController; requeue: boolean } | null = null;
  private guests: Guest[] = [];
  /** The paired device's render on the GPU now, if that is what runs. */
  private guestRunning: Guest | null = null;
  private readonly onGuests: (g: GuestTake[]) => void;
  private guestsSent = '[]';
  private guestProgressAt = 0;
  private paused = false;
  private online = false;
  readonly previews = new Map<string, { bytes: Uint8Array; type: string }>();
  private readonly onEngine: (s: EngineState) => void;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly store: Store;
  private engine: Engine;
  private comfy: EngineState['comfy'];
  private problem: string | null = null;
  private readonly catalog: Catalog;
  private readonly mediaDir: string;
  private readonly poster?: (video: string, out: string) => Promise<boolean>;
  private readonly fake: boolean;
  private readonly safety: SafetyCheck;

  constructor(opts: {
    store: Store;
    engine: Engine;
    catalog: Catalog;
    mediaDir: string;
    fake: boolean;
    comfy?: EngineState['comfy'];
    onEngine: (s: EngineState) => void;
    /** Paired devices' renders here changed: one came, moved, progressed or left. */
    onGuests?: (g: GuestTake[]) => void;
    /** Writes a full-size poster from a finished video; false keeps the sampler's preview. */
    poster?: (video: string, out: string) => Promise<boolean>;
    /** What may render; presets/safety.toml unless a test says otherwise. */
    safety?: SafetyCheck;
  }) {
    this.poster = opts.poster;
    this.safety = opts.safety ?? loadSafety();
    this.comfy = opts.comfy ?? (opts.fake ? 'fake' : 'external');
    this.store = opts.store;
    this.engine = opts.engine;
    this.catalog = opts.catalog;
    this.mediaDir = opts.mediaDir;
    this.fake = opts.fake;
    this.onEngine = opts.onEngine;
    this.onGuests = opts.onGuests ?? (() => {});
  }

  engineState(): EngineState {
    return {
      online: this.online,
      url: this.engine.url,
      fake: this.engine.fake ?? this.fake,
      paused: this.paused,
      device: this.engine.device ?? 'This computer',
      comfy: this.comfy,
      problem: this.online ? null : this.problem,
    };
  }

  /** Point at another ComfyUI (the managed one moved ports) or another device, or record why it is down. */
  setEngine(engine: Engine, comfy?: EngineState['comfy']) {
    if (engine.url === this.engine.url && engine.device === this.engine.device) return;
    this.engine = engine;
    if (comfy) this.comfy = comfy;
    this.online = false;
    this.onEngine(this.engineState());
    // Ask the new one straight away rather than at the next tick.
    if (this.started && !this.stopped) {
      if (this.pingTimer) clearTimeout(this.pingTimer);
      void this.tick();
    }
  }

  setProblem(problem: string | null) {
    if (problem === this.problem) return;
    this.problem = problem;
    this.onEngine(this.engineState());
  }

  private started = false;
  private stopped = false;
  private async tick() {
    const engine = this.engine;
    const was = this.online;
    const online = await engine.ping();
    // The engine changed while asking: its answer is about the old one.
    if (engine !== this.engine || this.stopped) return;
    this.online = online;
    if (was !== this.online) {
      this.onEngine(this.engineState());
      if (this.online) this.pump();
    }
    if (this.pingTimer) clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => void this.tick(), this.online ? 10_000 : 2_000);
    this.pingTimer.unref?.();
  }

  /** Watch ComfyUI: quickly while it is down, rarely while it is up. */
  start() {
    this.started = true;
    void this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.pingTimer) clearTimeout(this.pingTimer);
    // Shutting down is not a cancel: the take goes back in the queue and renders after the next start.
    if (this.running) {
      this.running.requeue = true;
      this.running.abort.abort();
    }
    for (const g of this.guests.splice(0)) g.reject(new EngineError('canceled', 'Canceled.'));
    this.guestsChanged();
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

  /** Everything waiting, takes and paired devices' renders alike, in the order it will run. */
  private order(): Array<{ take: Take } | { guest: Guest }> {
    const key = (x: { take: Take } | { guest: Guest }) =>
      'take' in x
        ? ([RANK[x.take.priority], x.take.createdAt] as const)
        : ([RANK.interactive, x.guest.createdAt] as const);
    return [...this.queued().map((take) => ({ take })), ...this.guests.map((guest) => ({ guest }))].sort(
      (a, b) => {
        const [ra, ca] = key(a);
        const [rb, cb] = key(b);
        return ra - rb || ca.localeCompare(cb);
      },
    );
  }

  /** The take rendering now, when it is one of this computer's own rather than a paired device's. */
  runningTake(): Take | null {
    return this.running ? (this.store.takes.get(this.running.id) ?? null) : null;
  }

  /** Paired devices' renders here, the running one first, then the waiting ones in the order they will run. */
  guestTakes(): GuestTake[] {
    const view = (g: Guest, status: GuestTake['status']): GuestTake => ({
      id: g.id,
      from: g.job.from,
      status,
      queuePosition: g.position,
      progress: g.progress,
      quality: g.job.quality,
      createdAt: g.createdAt,
    });
    const waiting = this.order().flatMap((x) => ('guest' in x ? [view(x.guest, 'queued')] : []));
    return this.guestRunning ? [view(this.guestRunning, 'running'), ...waiting] : waiting;
  }

  /** Tell the UI when paired devices' renders changed; the same list twice says nothing. */
  private guestsChanged() {
    const list = this.guestTakes();
    const json = JSON.stringify(list);
    if (json === this.guestsSent) return;
    this.guestsSent = json;
    this.onGuests(list);
  }

  /** How many renders are waiting or running, paired devices' included. */
  load(): number {
    return this.order().length + (this.running ? 1 : 0);
  }

  /** Recompute queue positions and tell the UI (or the paired device) about any that moved. */
  private renumber() {
    this.order().forEach((x, i) => {
      const pos = i + (this.running ? 1 : 0);
      if ('take' in x) {
        if (x.take.queuePosition !== pos) {
          x.take.queuePosition = pos;
          this.store.putTake(x.take, true);
        }
      } else if (x.guest.position !== pos) {
        x.guest.position = pos;
        x.guest.job.handlers.onQueued?.(pos);
      }
    });
    this.guestsChanged();
  }

  /** Queue a paired device's render. Resolves when the video is at job.dest. */
  guest(job: GuestRender): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (job.signal.aborted) return reject(new EngineError('canceled', 'Canceled.'));
      const g: Guest = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        position: null,
        progress: null,
        job,
        resolve,
        reject,
      };
      this.guests.push(g);
      job.signal.addEventListener(
        'abort',
        () => {
          // Still waiting: just leave the queue. Running: runGuest stops it.
          const i = this.guests.indexOf(g);
          if (i < 0) return;
          this.guests.splice(i, 1);
          reject(new EngineError('canceled', 'Canceled.'));
          this.renumber();
        },
        { once: true },
      );
      this.renumber();
      this.pump();
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
    if (this.running?.id === id) {
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
    if (interrupt && this.running && this.running.priority !== 'forced') {
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
    if (this.running || this.paused || !this.online || this.stopped) return;
    const next = this.order()[0];
    if (!next) return;
    if ('take' in next) void this.run(next.take);
    else void this.runGuest(next.guest);
  }

  private async runGuest(g: Guest) {
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    g.job.signal.addEventListener('abort', onAbort, { once: true });
    this.guests.splice(this.guests.indexOf(g), 1);
    this.running = { id: g.id, priority: 'interactive', abort, requeue: false };
    this.guestRunning = g;
    g.position = 0;
    g.progress = null;
    this.renumber();
    const { handlers } = g.job;
    try {
      await this.engine.render(g.job.built, {
        dest: g.job.dest,
        startFrame: g.job.startFrame,
        signal: abort.signal,
        handlers: {
          ...handlers,
          // This computer's queue shows its progress too, about as often as a local take's.
          onProgress: (p) => {
            g.progress = Math.min(1, Math.max(0, p.value));
            const now = Date.now();
            if (now - this.guestProgressAt > 160 || p.value >= 1) {
              this.guestProgressAt = now;
              this.guestsChanged();
            }
            handlers.onProgress?.(p);
          },
        },
      });
      g.resolve();
    } catch (e) {
      if (this.running?.requeue && !g.job.signal.aborted) {
        // Interrupted by Force now here: back in line, oldest first, and the other device hears it's waiting.
        g.position = null;
        g.progress = null;
        this.guests.push(g);
      } else g.reject(e);
    } finally {
      g.job.signal.removeEventListener('abort', onAbort);
      this.running = null;
      this.guestRunning = null;
      this.renumber();
      this.pump();
    }
  }

  private async run(take: Take) {
    const abort = new AbortController();
    this.running = { id: take.id, priority: take.priority, abort, requeue: false };
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
      // Checked again here, not only when it was asked for: a take queued before an update, or retried, too.
      const words = this.safety.text(take.request.prompt);
      if (!words.ok) throw new EngineError('content_blocked', words.message);
      const shot = composeShot(this.catalog, take.request);
      const built: BuiltGraph = buildGraph({
        shot,
        seed: take.seed,
        prefix: `hildegard/${take.id}`,
        startFrame: take.request.startFrame ? 'start.png' : undefined,
      });
      let lastProgressAt = 0;
      await this.engine.render(built, {
        dest,
        quality: take.quality,
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
      const jpg = join(this.mediaDir, `${take.id}.jpg`);
      const preview = this.previews.get(take.id);
      if (await this.poster?.(dest, jpg).catch(() => false)) {
        take.poster = `/media/${take.id}.jpg`;
      } else if (preview) {
        await writeFile(jpg, preview.bytes);
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
        // Interrupted by Force now, or by Hildegard stopping: back to the front of its class, no error shown.
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
        // A stopped take keeps its last frame as a poster, so the card shows where it got to. A refused one keeps
        // nothing: its previews may show what was refused.
        const last = this.previews.get(take.id);
        if (take.error?.code === 'content_blocked') {
          await Promise.all(
            [`${take.id}.jpg`, `${take.id}.mp4`].map((f) => rm(join(this.mediaDir, f), { force: true })),
          );
          take.poster = null;
          take.previewVersion++;
        } else if (last && !take.poster) {
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
