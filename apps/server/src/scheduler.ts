// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type BuiltGraph,
  buildGraph,
  buildStillGraph,
  type Engine,
  EngineError,
  type RenderHandlers,
} from '@hildegard/comfy';
import {
  type Catalog,
  type Character,
  characterText,
  composeShot,
  type EngineState,
  type GuestTake,
  loadSafety,
  type Priority,
  pickStillModel,
  type SafetyCheck,
  type Still,
  type Take,
  type TakeError,
  usable,
} from '@hildegard/presets';
import type { Store } from './store.ts';

const RANK = { forced: 0, interactive: 1, agent: 2 } as const;
/** Where paired devices' renders wait when this computer shares opportunistically: behind all of its own work. */
const YIELD_RANK = 3;
/** How long a paired device's render waits before this computer asks again whether it's busy. */
export const BUSY_RECHECK_MS = 30_000;
/** How long after this computer's own work ends before asking: GPU use and load still show that work for a moment. */
export const BUSY_SETTLE_MS = 3_000;

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
    content_blocked:
      'Change the prompt, the start frame or the references. Hildegard doesn’t make sexual content.',
    character: 'Open the character to see why, then retry.',
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
  /** Local paths of its reference images, in the graph's order. */
  references?: string[];
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

/** A take or a character's still: either waits in the one queue and renders on the one GPU. */
type Job = { take: Take } | { still: Still };
const jobOf = (j: Job): Take | Still => ('take' in j ? j.take : j.still);

/**
 * One GPU, one render at a time. Forced work goes first, then studio work, then agent work; within a class, oldest
 * first. Force now stops a lower-priority render, which goes back to the front of its class. Stills queue with takes,
 * and renders from paired devices queue here too, as studio work, so nothing runs alongside anything else.
 *
 * Shared opportunistically, paired devices' renders go behind all of this computer's own work instead: a take, a still
 * or speech arriving here stops one that is rendering (it goes back in line), and one only starts when `hostBusy` says
 * nothing else is using this computer.
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
  private opportunistic = false;
  private readonly hostBusy: () => Promise<boolean>;
  /** Asking hostBusy now; nothing starts until it answers. */
  private askingBusy = false;
  /** hostBusy just said this computer is free, for this paired render: it may start if it is still first, soon. */
  private guestCleared: { id: string; at: number } | null = null;
  private busyTimer: NodeJS.Timeout | null = null;
  /** A paired render stopped for speech while takes were paused: it may run again once speech is done, paused or not. */
  private resumeGuest: string | null = null;
  /** When this computer's own last render or lease ended. */
  private localEndedAt = 0;
  private readonly busySettleMs: number;
  private readonly busyRecheckMs: number;
  /** Other work holding this GPU (voice), and work waiting for it; no take starts while it is held. */
  private leased = false;
  private readonly leaseQueue: Array<() => void> = [];
  private readonly beforeRender: () => Promise<void>;
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
    /** Runs before each render on this computer's GPU: voice lets go of the memory it holds. */
    beforeRender?: () => Promise<void>;
    /** Whether something other than Hildegard is using this computer now; asked only when sharing opportunistically. */
    hostBusy?: () => Promise<boolean>;
    /** How long to wait before asking again; BUSY_RECHECK_MS unless a test says otherwise. */
    busyRecheckMs?: number;
    /** How long to let this computer's own work settle before asking; BUSY_SETTLE_MS unless a test says otherwise. */
    busySettleMs?: number;
  }) {
    this.busyRecheckMs = opts.busyRecheckMs ?? BUSY_RECHECK_MS;
    this.busySettleMs = opts.busySettleMs ?? BUSY_SETTLE_MS;
    this.hostBusy = opts.hostBusy ?? (async () => false);
    this.poster = opts.poster;
    this.beforeRender = opts.beforeRender ?? (async () => {});
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
      if (this.online) {
        this.yieldGuest();
        this.pump();
      }
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
    if (this.busyTimer) clearTimeout(this.busyTimer);
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
    if (!paused) {
      this.yieldGuest();
      this.pump();
    }
  }

  /**
   * On: paired devices' renders go behind this computer's own work, yield to it, and wait while this computer is busy.
   * Off: they queue as studio work and run.
   */
  setOpportunistic(on: boolean) {
    if (on === this.opportunistic) return;
    this.opportunistic = on;
    this.guestCleared = null;
    if (!on && this.busyTimer) {
      clearTimeout(this.busyTimer);
      this.busyTimer = null;
    }
    // Something of this computer's own may be waiting behind the paired render on the GPU now.
    if (on) this.yieldGuest();
    this.renumber();
    this.pump();
  }

  /** Whether paired devices' renders wait behind this computer's own work and its being busy. */
  get yields(): boolean {
    return this.opportunistic;
  }

  /** Opportunistic: stop the paired device's render on the GPU now; it goes back in line, and starts over later. */
  private yieldGuest() {
    if (!this.opportunistic || !this.guestRunning || !this.running || this.stopped) return;
    // Only for work that can start now: never stop a paired render just to leave the GPU idle. Speech gets the GPU
    // even while takes are paused or ComfyUI is down, so a lease waiting always counts.
    const local = !this.paused && this.online && this.order().some((x) => !('guest' in x));
    if (!this.leaseQueue.length && !local) return;
    if (!local && this.paused) this.resumeGuest = this.guestRunning.id;
    this.running.requeue = true;
    this.running.abort.abort();
  }

  queued(): Take[] {
    return [...this.store.takes.values()]
      .filter((t) => t.status === 'queued')
      .sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.createdAt.localeCompare(b.createdAt));
  }

  /** Everything waiting, takes, stills and paired devices' renders alike, in the order it will run. */
  private order(): Array<Job | { guest: Guest }> {
    const key = (x: Job | { guest: Guest }) =>
      'guest' in x
        ? ([this.opportunistic ? YIELD_RANK : RANK.interactive, x.guest.createdAt] as const)
        : ([RANK[jobOf(x).priority], jobOf(x).createdAt] as const);
    const stills = [...this.store.stills.values()]
      .filter((s) => s.status === 'queued')
      .map((still) => ({ still }));
    return [
      ...this.queued().map((take) => ({ take })),
      ...stills,
      ...this.guests.map((guest) => ({ guest })),
    ].sort((a, b) => {
      const [ra, ca] = key(a);
      const [rb, cb] = key(b);
      return ra - rb || ca.localeCompare(cb);
    });
  }

  /** A take or a still by id, and how to save it. */
  private job(id: string): { job: Take | Still; put: (progressOnly?: boolean) => void } | null {
    const t = this.store.takes.get(id);
    if (t) return { job: t, put: (p) => this.store.putTake(t, p) };
    const s = this.store.stills.get(id);
    if (s) return { job: s, put: (p) => this.store.putStill(s, p) };
    return null;
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
      } else if ('still' in x) {
        if (x.still.queuePosition !== pos) {
          x.still.queuePosition = pos;
          this.store.putStill(x.still, true);
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
    this.yieldGuest();
    this.renumber();
    this.pump();
  }

  enqueueStill(still: Still) {
    this.store.putStill(still);
    this.yieldGuest();
    this.renumber();
    this.pump();
  }

  /** Cancel a take or a still. */
  cancel(id: string): boolean {
    const found = this.job(id);
    if (!found) return false;
    const { job: t, put } = found;
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
    put();
    this.renumber();
    return true;
  }

  /** `interrupt` stops whatever is rendering (it restarts later); otherwise the take or still just runs next. */
  force(id: string, interrupt: boolean): boolean {
    const found = this.job(id);
    if (found?.job.status !== 'queued') return false;
    found.job.priority = 'forced';
    found.job.createdAt = new Date().toISOString();
    found.put();
    if (interrupt && this.running && this.running.priority !== 'forced') {
      this.running.requeue = true;
      this.running.abort.abort();
    }
    this.renumber();
    this.pump();
    return true;
  }

  retry(id: string): Take | Still | null {
    const found = this.job(id);
    const t = found?.job;
    if (!found || !t || (t.status !== 'failed' && t.status !== 'canceled')) return null;
    Object.assign(t, {
      status: 'queued',
      error: null,
      progress: null,
      startedAt: null,
      finishedAt: null,
      renderMs: null,
      createdAt: new Date().toISOString(),
    } satisfies Partial<Take>);
    found.put();
    this.yieldGuest();
    this.renumber();
    this.pump();
    return t;
  }

  /**
   * Hold the GPU for other work, such as speech: waits for the render on it now to finish, then no take starts until
   * the returned function is called. The one exception: shared opportunistically, a paired device's render on the GPU
   * stops for it and goes back in line, and resumes after it even while takes are paused. Voice goes ahead of takes still waiting, since it takes
   * seconds. Renders that go to another device don't need this GPU, so the lease comes at once.
   */
  lease(): Promise<() => void> {
    return new Promise((resolve) => {
      if (this.comfy === 'remote') {
        resolve(() => {});
        return;
      }
      this.leaseQueue.push(() => {
        let done = false;
        resolve(() => {
          if (done) return;
          done = true;
          this.leased = false;
          this.localEndedAt = Date.now();
          this.pump();
        });
      });
      this.yieldGuest();
      this.pump();
    });
  }

  /** Start the next take or still if the GPU is free. */
  pump() {
    if (this.running || this.leased || this.stopped) return;
    const lease = this.leaseQueue.shift();
    if (lease) {
      this.leased = true;
      lease();
      return;
    }
    if (!this.online) return;
    // Paused, only a paired render that speech interrupted may go on, ahead of the paused takes.
    const next = this.paused
      ? this.order().find((x) => 'guest' in x && x.guest.id === this.resumeGuest)
      : this.order()[0];
    if (!next) return;
    if ('guest' in next && this.opportunistic) {
      const c = this.guestCleared;
      this.guestCleared = null;
      // Cleared moments ago for this very render: start it. Anything else asks again.
      if (!(c && c.id === next.guest.id && Date.now() - c.at < 2000)) {
        // Only paired renders wait (they go last), so ask whether anything else is using this computer first.
        if (this.busyTimer || this.askingBusy) return;
        // This computer's own work just ended: let its GPU use and load settle before asking.
        const settle = this.localEndedAt + this.busySettleMs - Date.now();
        if (settle > 0) {
          this.busyTimer = setTimeout(() => {
            this.busyTimer = null;
            this.pump();
          }, settle);
          this.busyTimer.unref?.();
          return;
        }
        this.askingBusy = true;
        const id = next.guest.id;
        const askedAt = Date.now();
        void this.hostBusy()
          // Can't tell: count it busy, since this computer's own work comes first.
          .catch(() => true)
          .then((busy) => {
            this.askingBusy = false;
            if (this.stopped) return;
            // Turned off while asking, or this computer's own work ran meanwhile and the answer measured it: ask again.
            if (!this.opportunistic || this.running || this.leased || this.localEndedAt >= askedAt) {
              this.pump();
              return;
            }
            if (busy) {
              this.busyTimer = setTimeout(() => {
                this.busyTimer = null;
                this.pump();
              }, this.busyRecheckMs);
              this.busyTimer.unref?.();
            } else this.guestCleared = { id, at: Date.now() };
            this.pump();
          });
        return;
      }
    }
    if ('guest' in next) {
      if (next.guest.id === this.resumeGuest) this.resumeGuest = null;
      void this.runGuest(next.guest);
    } else if ('take' in next) void this.run(next.take);
    else void this.runStill(next.still);
  }

  /** The characters a take casts, as they are now: each must still exist, and may still be drawn. */
  private castOf(take: Take): Character[] {
    return take.request.characters.map((id) => {
      const c = this.store.characters.get(id);
      if (!c)
        throw new EngineError(
          'character',
          'A character in this shot was deleted.',
          '',
          'Remove them from the shot, then retry.',
        );
      const ok = usable(c);
      if (!ok.ok) throw new EngineError('character', ok.why);
      const words = this.safety.text(characterText(c));
      if (!words.ok) throw new EngineError('content_blocked', words.message);
      return c;
    });
  }

  /** Local paths of reference images, which must all still be there. */
  private async referencePaths(files: readonly string[]): Promise<string[]> {
    const paths = files.map((f) => join(this.mediaDir, 'uploads', f));
    for (const p of paths)
      await stat(p).catch(() => {
        throw new EngineError(
          'character',
          'A reference image is missing.',
          '',
          'Add the character’s references again, then retry.',
        );
      });
    return paths;
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
      await this.beforeRender().catch(() => {});
      await this.engine.render(g.job.built, {
        dest: g.job.dest,
        startFrame: g.job.startFrame,
        references: g.job.references,
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
      // Its GPU use and load linger a moment too, like this computer's own work.
      this.localEndedAt = Date.now();
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
    let ranFrom: number | null = null;
    const dest = join(this.mediaDir, `${take.id}.mp4`);
    try {
      // Checked again here, not only when it was asked for: a take queued before an update, or retried, too.
      const words = this.safety.text(take.request.prompt);
      if (!words.ok) throw new EngineError('content_blocked', words.message);
      const shot = composeShot(this.catalog, take.request, this.castOf(take));
      const built: BuiltGraph = buildGraph({
        shot,
        seed: take.seed,
        prefix: `hildegard/${take.id}`,
        startFrame: take.request.startFrame ? 'start.png' : undefined,
      });
      const references = await this.referencePaths(shot.cast?.keyframe.references ?? []);
      let lastProgressAt = 0;
      if (this.comfy !== 'remote') await this.beforeRender().catch(() => {});
      await this.engine.render(built, {
        dest,
        quality: take.quality,
        signal: abort.signal,
        references,
        startFrame: take.request.startFrame
          ? join(this.mediaDir, 'uploads', take.request.startFrame)
          : undefined,
        handlers: {
          // Render time counts from when the GPU starts on it, not from a wait in another device's queue.
          onRunning: () => {
            ranFrom ??= Date.now();
          },
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
        take.renderMs = Date.now() - (ranFrom ?? started);
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
      this.localEndedAt = Date.now();
      this.renumber();
      this.pump();
    }
  }

  /** Render one still of a character, from its record: the words and references fixed when it was asked for. */
  private async runStill(still: Still) {
    const abort = new AbortController();
    this.running = { id: still.id, priority: still.priority, abort, requeue: false };
    Object.assign(still, {
      status: 'running',
      queuePosition: 0,
      startedAt: new Date().toISOString(),
      progress: { value: 0, step: null, steps: null },
      error: null,
    } satisfies Partial<Still>);
    this.store.putStill(still);
    this.renumber();

    const started = Date.now();
    let ranFrom: number | null = null;
    const dir = join(this.mediaDir, 'stills');
    const dest = join(dir, `${still.id}.png`);
    try {
      const c = this.store.characters.get(still.characterId);
      if (!c) throw new EngineError('character', 'This character was deleted.');
      const ok = usable(c);
      if (!ok.ok) throw new EngineError('character', ok.why);
      const words = this.safety.text(still.prompt);
      if (!words.ok) throw new EngineError('content_blocked', words.message);
      const model = pickStillModel(this.catalog, still.model);
      const q = model.final;
      const built = buildStillGraph({
        still: {
          model,
          prompt: still.prompt,
          width: still.width,
          height: still.height,
          steps: q.steps,
          cfg: q.cfg,
          references: still.references,
          guard: {
            classifier: this.catalog.safety.classifier.path.split('/').pop()!,
            threshold: this.catalog.safety.threshold,
          },
        },
        seed: still.seed,
        prefix: `hildegard/still-${still.id}`,
      });
      const references = await this.referencePaths(still.references);
      await mkdir(dir, { recursive: true });
      let lastProgressAt = 0;
      await this.engine.render(built, {
        dest,
        quality: 'final',
        signal: abort.signal,
        references,
        handlers: {
          onRunning: () => {
            ranFrom ??= Date.now();
          },
          onProgress: (p) => {
            still.progress = { value: p.value, step: p.step, steps: p.steps };
            const now = Date.now();
            if (now - lastProgressAt > 160 || p.value >= 1) {
              lastProgressAt = now;
              this.store.putStill(still, true);
            }
          },
          onPreview: (bytes, type) => {
            this.previews.set(still.id, { bytes, type });
            still.previewVersion++;
            this.store.putStill(still, true);
          },
        },
      });
      Object.assign(still, {
        status: 'done',
        image: `/media/stills/${still.id}.png`,
        progress: { value: 1, step: still.progress?.steps ?? null, steps: still.progress?.steps ?? null },
      } satisfies Partial<Still>);
    } catch (e) {
      if (this.running?.requeue) {
        Object.assign(still, { status: 'queued', progress: null, startedAt: null } satisfies Partial<Still>);
      } else {
        still.status = e instanceof EngineError && e.code === 'canceled' ? 'canceled' : 'failed';
        still.error = explain(e);
        await rm(dest, { force: true });
      }
    } finally {
      if ((still.status as Still['status']) !== 'queued') {
        still.queuePosition = null;
        still.finishedAt = new Date().toISOString();
        still.renderMs = Date.now() - (ranFrom ?? started);
        if (still.error?.code === 'content_blocked') still.previewVersion++;
        this.previews.delete(still.id);
      }
      this.store.putStill(still);
      this.running = null;
      this.localEndedAt = Date.now();
      this.renumber();
      this.pump();
    }
  }
}
