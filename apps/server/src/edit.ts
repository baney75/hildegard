// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Video edits: an edit list (edl.json) per edit, rendered and proven on the output by tools/edit_video.py on the Python
 * `hildegard install` set up. Each edit belongs to the person who made it (or this computer); the owner of this Hildegard
 * sees everyone's, as with films. Jobs run one at a time: encoding is CPU work, and one long render should not starve
 * the rest of the computer. Every run of the script, a job's or a check a request waits on, takes a turn: one at a time
 * per person and MAX_PY at once overall, with a short line of waiters per person; past that a request gets a 429.
 *
 * The edit list the API stores names footage by reference (`recording:rec_…`, `export:…`, `edit:ed_…`), never by path,
 * so a signed-in director can't read a file off the computer by naming it. Only this computer itself may give a path.
 * Before anything runs, the references become paths in a copy (`edl.run.json`) that only the Python script reads.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import type { EditCheck, EditJobView, EditRenderView, EditVerifyView, EditView } from '@hildegard/presets';
import { resource } from '@hildegard/runtime';
import { exportPython } from './export.ts';

export class EditError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 502;
  readonly code: string;
  constructor(status: EditError['status'], code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const ID_RE = /^ed_[0-9a-f]{16}$/;
const OWNER_RE = /^[A-Za-z0-9-]{1,64}$/;
/** Edits a person may have queued or running at once. */
export const MAX_ACTIVE = 3;
/** Runs of the script at once, everyone's together: each can hold a decoder and the analysis of a long recording. */
export const MAX_PY = 2;
/** Requests one person may have waiting for a turn behind their running one; more is a 429. */
export const MAX_WAITING = 2;
/** How long a request waits for its turn before it is told to try again. */
export const TURN_WAIT_MS = 120_000;
/** The most processes one render may start, whatever is asked: each holds a full-size decoder and its frames. */
export const MAX_RENDER_WORKERS = 4;

/** The render workers to use: what was asked, never more than the cores or MAX_RENDER_WORKERS. */
export function renderWorkers(asked?: number, cores = availableParallelism()): number {
  return Math.max(1, Math.min(asked ?? MAX_RENDER_WORKERS, cores, MAX_RENDER_WORKERS));
}
/** The files of an edit that /media may serve. */
export const PUBLIC_FILES = /^(out\.mp4|sheet\.jpg|chapters\.txt)$/;

export type Edl = Record<string, unknown>;
type Json = Record<string, unknown>;

/** What is stored for an edit, as one JSON file. */
interface Stored {
  id: string;
  owner: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  edl: Edl;
  check: EditCheck | null;
  job: EditJobView | null;
  render: EditRenderView | null;
  verify: EditVerifyView | null;
  plan: Json | null;
}

// ── Running the script ──────────────────────────────────────────────────────────────────────────────────────────

/** Runs `edit_video.py <args> --json`; `on` hears each progress line. Resolves with the last JSON line it printed. */
export type EditRunner = (args: string[], on: (m: Json) => void) => Promise<Json>;

const noPython = () =>
  new EditError(
    502,
    'tool',
    'Video editing uses the Python that `hildegard install` sets up. Run `hildegard install`, then try again.',
  );

export function pyRunner(dataDir: string, minutes = 120): EditRunner {
  return (args, on) =>
    new Promise((resolveRun, reject) => {
      let py: string;
      try {
        py = resource(join('tools', 'edit_video.py'));
      } catch (e) {
        return reject(new EditError(502, 'tool', (e as Error).message));
      }
      const child = spawn(exportPython(dataDir), ['-I', py, ...args, '--json'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: {
          ...process.env,
          HG_EDIT_ENCODER: process.env.HILDEGARD_EDIT_ENCODER ?? process.env.HG_EDIT_ENCODER ?? '',
        },
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr = (stderr + d.toString()).slice(-4000);
      });
      let last: Json | null = null;
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const m = JSON.parse(line) as Json;
          if ('ok' in m) last = m;
          else on(m);
        } catch {}
      });
      const timer = setTimeout(() => child.kill(), minutes * 60_000);
      child.once('error', () => {
        clearTimeout(timer);
        reject(noPython());
      });
      child.once('close', () => {
        clearTimeout(timer);
        if (last) return resolveRun(last);
        if (/No module named|ModuleNotFoundError/.test(stderr)) return reject(noPython());
        if (stderr) console.error(`Video editing failed:\n${stderr}`);
        reject(new EditError(422, 'edit', 'Video editing failed. The server log has the details.'));
      });
    });
}

// ── The store ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface EditStoreOptions {
  /** `<media>/edits`. */
  dir: string;
  now?: () => number;
}

export class EditStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly edits = new Map<string, Stored>();

  constructor(o: EditStoreOptions) {
    this.dir = o.dir;
    this.now = o.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
    for (const owner of readdirSync(this.dir)) {
      if (!OWNER_RE.test(owner)) continue;
      for (const id of safeList(join(this.dir, owner))) {
        if (!ID_RE.test(id)) continue;
        try {
          const s = JSON.parse(readFileSync(join(this.dir, owner, id, 'edit.json'), 'utf8')) as Stored;
          // A job that was running when the server stopped did not finish.
          if (s.job?.status === 'running')
            s.job = {
              ...s.job,
              status: 'failed',
              stage: null,
              error: 'The server stopped before this finished. Run it again.',
            };
          this.edits.set(s.id, s);
        } catch {}
      }
    }
  }

  dirOf(e: { owner: string; id: string }): string {
    return join(this.dir, e.owner, e.id);
  }

  /** The folder's real location, refusing anything that isn't under the edits folder. */
  fileOf(e: { owner: string; id: string }, name: string): string {
    const p = resolve(this.dirOf(e), name);
    if (!p.startsWith(resolve(this.dir) + sep))
      throw new EditError(400, 'path', 'That isn’t a file of this edit.');
    return p;
  }

  get(id: string): Stored | undefined {
    return this.edits.get(id);
  }

  list(owner?: string): Stored[] {
    return [...this.edits.values()]
      .filter((e) => owner === undefined || e.owner === owner)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  create(owner: string, title: string, edl: Edl): Stored {
    if (!OWNER_RE.test(owner)) throw new EditError(400, 'owner', 'Who is asking?');
    const at = new Date(this.now()).toISOString();
    const e: Stored = {
      id: `ed_${randomBytes(8).toString('hex')}`,
      owner,
      title: title.slice(0, 120) || 'Untitled edit',
      createdAt: at,
      updatedAt: at,
      edl,
      check: null,
      job: null,
      render: null,
      verify: null,
      plan: null,
    };
    mkdirSync(this.dirOf(e), { recursive: true });
    this.edits.set(e.id, e);
    this.save(e);
    return e;
  }

  save(e: Stored): void {
    e.updatedAt = new Date(this.now()).toISOString();
    const file = join(this.dirOf(e), 'edit.json');
    writeFileSync(`${file}.part`, JSON.stringify(e), { mode: 0o600 });
    renameSync(`${file}.part`, file);
  }

  remove(id: string): void {
    const e = this.edits.get(id);
    if (!e) return;
    this.edits.delete(id);
    rmSync(this.dirOf(e), { recursive: true, force: true });
  }
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// ── References → paths ──────────────────────────────────────────────────────────────────────────────────────────

export interface Resolvers {
  /** The file of a recording this person may use, or null. */
  recording: (id: string) => string | null;
  /** The file of a finished export this person may use, or null. */
  exported: (id: string) => string | null;
  /** The finished video of an edit this person may use, or null. */
  edit: (id: string) => string | null;
  /** Whether this person is this computer itself, who may name a path. */
  local: boolean;
}

const REF = /^(recording|export|edit):([A-Za-z0-9_-]{1,64})$/;

/** The edit list with every footage and music reference turned into a path. Throws EditError for one that isn't allowed. */
export function resolveRefs(edl: Edl, r: Resolvers): Edl {
  const out = JSON.parse(JSON.stringify(edl)) as Edl;
  const pathOf = (value: unknown, where: string): string => {
    if (typeof value !== 'string' || !value) throw new EditError(422, 'source', `${where} needs a file.`);
    const m = REF.exec(value);
    if (m) {
      const found =
        m[1] === 'recording' ? r.recording(m[2]!) : m[1] === 'export' ? r.exported(m[2]!) : r.edit(m[2]!);
      if (!found) throw new EditError(404, 'source', `${where}: there is no ${m[1]} “${m[2]}” you can use.`);
      return found;
    }
    if (!r.local)
      throw new EditError(
        403,
        'source',
        `${where}: name footage as recording:<id> (from record_link or an import), export:<id> or edit:<id>. Only this computer may give a path.`,
      );
    return value;
  };
  const sources = out.sources as Record<string, { path?: unknown }> | undefined;
  if (sources && typeof sources === 'object')
    for (const [k, s] of Object.entries(sources))
      if (s && typeof s === 'object') s.path = pathOf(s.path, `sources.${k}.path`);
  const music = out.music as { path?: unknown } | undefined;
  if (music && typeof music === 'object') music.path = pathOf(music.path, 'music.path');
  // A transcript is a file of the edit itself, never another path.
  const caps = out.captions as { transcript?: unknown } | undefined;
  if (caps && typeof caps.transcript === 'string' && caps.transcript !== 'transcript.json' && !r.local)
    throw new EditError(
      422,
      'transcript',
      'captions.transcript: use the transcript object itself, or "transcript.json" once the edit has one.',
    );
  return out;
}

// ── Jobs ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EditJobsOptions {
  store: EditStore;
  runner: EditRunner;
  /** Overrides MAX_PY and TURN_WAIT_MS, for tests. */
  maxPy?: number;
  turnWaitMs?: number;
}

const queueFull = () =>
  new EditError(429, 'queue', 'Hildegard is busy with your other edits. Try again when one finishes.');

interface Waiter {
  owner: string;
  /** A request waiting on the answer, not a job already accepted. */
  request: boolean;
  grant: (release: () => void) => void;
}

/** Turns at running the script: one at a time per person, `max` at once overall, first come first served. */
class Turns {
  private readonly max: number;
  private readonly waitMs: number;
  private running = 0;
  private readonly holders = new Set<string>();
  private readonly waiting: Waiter[] = [];

  constructor(max: number, waitMs: number) {
    this.max = max;
    this.waitMs = waitMs;
  }

  /** Resolves with the release once it is `owner`'s turn. A request past the line, or kept waiting too long, gets a 429. */
  take(owner: string, request: boolean): Promise<() => void> {
    return new Promise((resolveTurn, reject) => {
      if (request) {
        const mine = this.waiting.filter((w) => w.request && w.owner === owner).length;
        if (mine >= MAX_WAITING || this.waiting.filter((w) => w.request).length >= this.max * 8)
          return reject(queueFull());
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const w: Waiter = {
        owner,
        request,
        grant: (release) => {
          if (timer) clearTimeout(timer);
          resolveTurn(release);
        },
      };
      if (request)
        timer = setTimeout(() => {
          const i = this.waiting.indexOf(w);
          if (i < 0) return;
          this.waiting.splice(i, 1);
          reject(queueFull());
        }, this.waitMs);
      this.waiting.push(w);
      this.pump();
    });
  }

  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.running < this.max; ) {
      const w = this.waiting[i]!;
      if (this.holders.has(w.owner)) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.running++;
      this.holders.add(w.owner);
      let released = false;
      w.grant(() => {
        if (released) return;
        released = true;
        this.running--;
        this.holders.delete(w.owner);
        this.pump();
      });
    }
  }
}

type Work = (set: (patch: Partial<EditJobView>) => void) => Promise<void>;

/** Edits' jobs, one running at a time, the status kept on the edit so a restart or another client sees it. */
export class EditJobs {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly o: EditJobsOptions;
  private readonly turns: Turns;

  constructor(o: EditJobsOptions) {
    this.o = o;
    this.turns = new Turns(o.maxPy ?? MAX_PY, o.turnWaitMs ?? TURN_WAIT_MS);
  }

  active(owner: string): number {
    return this.o.store.list(owner).filter((e) => e.job?.status === 'running').length;
  }

  busy(e: Stored): boolean {
    return e.job?.status === 'running';
  }

  start(e: Stored, kind: EditJobView['kind'], work: Work): EditJobView {
    if (this.busy(e))
      throw new EditError(
        409,
        'busy',
        `This edit is still ${e.job!.kind === 'render' ? 'rendering' : 'working'}. Wait for it to finish.`,
      );
    if (this.active(e.owner) >= MAX_ACTIVE)
      throw new EditError(
        429,
        'queue',
        `You have ${MAX_ACTIVE} edits working already. Let one finish first.`,
      );
    const job: EditJobView = {
      kind,
      status: 'running',
      stage: 'Waiting',
      done: null,
      total: null,
      error: null,
    };
    e.job = job;
    this.o.store.save(e);
    const set = (patch: Partial<EditJobView>) => Object.assign(job, patch);
    this.tail = this.tail.then(async () => {
      set({ stage: 'Starting' });
      try {
        await work(set);
        set({ status: 'done', stage: null });
      } catch (err) {
        set({
          status: 'failed',
          stage: null,
          error: err instanceof EditError ? err.message : 'That failed. The server log has the details.',
        });
        if (!(err instanceof EditError)) console.error(err);
      } finally {
        this.o.store.save(e);
      }
    });
    return job;
  }

  /**
   * Runs the script on `owner`'s turn, with progress lines going to the job. A job's runs wait their turn; a request's
   * (`request`) may get a 429 instead, when that person already has others waiting or waited too long.
   */
  async run(
    owner: string,
    set: (p: Partial<EditJobView>) => void,
    args: string[],
    request = false,
  ): Promise<Json> {
    const release = await this.turns.take(owner, request);
    try {
      return await this.o.runner(args, (m) => {
        if (typeof m.stage === 'string') set({ stage: m.stage });
        if (typeof m.done === 'number' && typeof m.total === 'number') set({ done: m.done, total: m.total });
      });
    } finally {
      release();
    }
  }
}

// ── Shaping what is shown ───────────────────────────────────────────────────────────────────────────────────────

export type { Stored as StoredEdit };

export function view(e: Stored, file: string | null = null, base = '/media/edits'): EditView {
  const url = (name: string) => `${base}/${e.owner}/${e.id}/${name}`;
  return {
    id: e.id,
    title: e.title,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    edl: e.edl,
    check: e.check,
    job: e.job,
    render: e.render
      ? { ...e.render, url: url('out.mp4'), file, sheetUrl: e.render.sheet ? url('sheet.jpg') : null }
      : null,
    verify: e.verify,
    plan: e.plan,
  };
}

export const asString = (x: unknown): string => (typeof x === 'string' ? x : '');
export const asNumber = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null;

export function toCheck(r: Json): EditCheck {
  return {
    ok: r.ok === true,
    errors: (r.errors as EditCheck['errors']) ?? (r.error ? [{ path: '', message: asString(r.error) }] : []),
    warnings: (r.warnings as EditCheck['warnings']) ?? [],
    summary: (r.summary as EditCheck['summary']) ?? null,
  };
}

export function toRender(r: Json, sheet: boolean): EditRenderView {
  return {
    url: '',
    file: null,
    sheetUrl: null,
    sheet,
    seconds: asNumber(r.seconds) ?? 0,
    frames: asNumber(r.frames) ?? 0,
    width: asNumber(r.width) ?? 0,
    height: asNumber(r.height) ?? 0,
    fps: asNumber(r.fps) ?? 0,
    encoder: asString(r.encoder),
    lufs: asNumber(r.lufs),
    truePeak: asNumber(r.true_peak),
    audioTracks: asNumber(r.audio_tracks) ?? 0,
    chaptersEmbedded: r.chapters_embedded === true,
    warnings: (r.warnings as Array<{ path: string; message: string }>) ?? [],
    at: new Date().toISOString(),
  };
}

export function toVerify(r: Json): EditVerifyView {
  return {
    ok: r.ok === true,
    checks: (r.checks as EditVerifyView['checks']) ?? [],
    unproven: (r.unproven as string[]) ?? [],
    error: r.error ? asString(r.error) : null,
    at: new Date().toISOString(),
  };
}
