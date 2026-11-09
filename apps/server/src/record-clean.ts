// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cleaning a recording: tools/voice_clean.py on the Python `hildegard install` set up, one job at a time (it is
 * CPU work, and a long take should not starve the rest of the computer). The chain itself lives in that one file.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { resource } from '@hildegard/runtime';
import { exportPython } from './export.ts';
import { type Entry, type MediaInfo, RecordError, type RecordingView, type RecordStore } from './record.ts';

export interface CleanSpec {
  src: string;
  out: string;
  target_lufs: number;
  peak: number;
}
export interface CleanResult {
  lufs: number;
  true_peak: number;
  seconds: number;
  backend: string;
}

export const CLEAN_DEFAULTS = { targetLufs: -16, peak: -1.5 } as const;

/** How many cleanups may wait or run at once, for one person and for everyone. */
export const MAX_PENDING_CLEANS_PER_OWNER = 5;
export const MAX_PENDING_CLEANS = 20;

const script = () => resource(join('tools', 'voice_clean.py'));

/**
 * What a media file holds and how long it is, with tools/voice_clean.py --probe. Null where Python can't be asked
 * (no script, no Python, no answer); a file Python read and refused is a RecordError, so a malformed one with a
 * right-looking header is not taken for one nobody could check.
 */
export function probeMedia(dataDir: string): (file: string) => Promise<MediaInfo | null> {
  return (file) =>
    new Promise((resolve, reject) => {
      let py: string;
      try {
        py = script();
      } catch {
        return resolve(null);
      }
      const child = spawn(exportPython(dataDir), ['-I', py, '--probe', file], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
      });
      const timer = setTimeout(() => child.kill(), 20_000);
      child.once('error', () => resolve(null));
      child.once('close', () => {
        clearTimeout(timer);
        try {
          const m = JSON.parse(out.trim().split('\n').at(-1) ?? '') as Partial<MediaInfo> & { ok?: boolean };
          if (m.ok === false)
            return reject(new RecordError(415, 'type', 'Hildegard couldn’t read that recording.'));
          resolve(
            m.ok && typeof m.seconds === 'number'
              ? { seconds: m.seconds, audio: !!m.audio, video: !!m.video }
              : null,
          );
        } catch {
          resolve(null);
        }
      });
    });
}

/** Runs the cleanup script; `stage` hears each step's name. Rejects with the script's own plain sentence. */
export function runClean(
  dataDir: string,
  spec: CleanSpec,
  stage: (name: string) => void = () => {},
): Promise<CleanResult> {
  return new Promise((resolve, reject) => {
    let py: string;
    try {
      py = script();
    } catch (e) {
      return reject(new RecordError(502, 'tool', (e as Error).message));
    }
    const specFile = `${spec.out}.spec.json`;
    writeFileSync(specFile, JSON.stringify(spec), { mode: 0o600 });
    const child = spawn(exportPython(dataDir), ['-I', py, specFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let result: CleanResult | null = null;
    let error: string | null = null;
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const m = JSON.parse(line) as { stage?: string; ok?: boolean; error?: string } & Partial<CleanResult>;
        if (typeof m.stage === 'string') stage(m.stage);
        if (m.ok === true) result = m as CleanResult;
        if (m.ok === false) error = m.error ?? null;
      } catch {}
    });
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    child.once('error', () => {
      clearTimeout(timer);
      rmSync(specFile, { force: true });
      reject(noPython());
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      rmSync(specFile, { force: true });
      if (code === 0 && result) return resolve(result);
      if (/No module named|ModuleNotFoundError/.test(`${error ?? ''}${stderr}`)) return reject(noPython());
      if (stderr) console.error(`Cleaning failed:\n${stderr}`);
      reject(new RecordError(422, 'clean', error ?? 'Cleaning failed. The server log has the details.'));
    });
  });
}

const noPython = () =>
  new RecordError(
    502,
    'tool',
    'Cleaning uses the Python that `hildegard install` sets up. Run `hildegard install`, then try again.',
  );

export interface CleanJob {
  id: string;
  /** Who started it: only they, the owner and this computer may follow it. */
  owner: string;
  from: string;
  status: 'running' | 'done' | 'failed';
  stage: string | null;
  recording: RecordingView | null;
  error: string | null;
}

export interface CleanOptions {
  dataDir: string;
  store: RecordStore;
  /** Stands in for the script in tests. */
  run?: (spec: CleanSpec, stage: (name: string) => void) => Promise<CleanResult>;
}

/** Cleaning jobs, one running at a time, kept in memory until the server stops. */
export class CleanJobs {
  private readonly jobs = new Map<string, CleanJob>();
  /** Jobs waiting or running, by source and settings. */
  private readonly pending = new Map<string, CleanJob>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly opts: CleanOptions;

  constructor(opts: CleanOptions) {
    this.opts = opts;
  }

  get(id: string): CleanJob | undefined {
    return this.jobs.get(id);
  }

  start(source: Entry, o: { targetLufs: number; peak: number }): CleanJob {
    const { store } = this.opts;
    const path = store.path(source);
    if (source.state !== 'received' || !path || !store.exists(source))
      throw new RecordError(409, 'pending', 'That recording hasn’t arrived yet.');
    const key = `${source.id}|${o.targetLufs}|${o.peak}`;
    const same = this.pending.get(key);
    if (same) return same;
    const waiting = [...this.pending.values()];
    if (
      waiting.length >= MAX_PENDING_CLEANS ||
      waiting.filter((j) => j.owner === source.owner).length >= MAX_PENDING_CLEANS_PER_OWNER
    )
      throw new RecordError(
        429,
        'queue',
        'Too many recordings are being cleaned. Try again when one finishes.',
      );
    const id = store.newId();
    const ext = source.kind === 'voice' ? '.wav' : extname(path).toLowerCase() === '.webm' ? '.webm' : '.mp4';
    const rel = `${source.owner}/${id}${ext}`;
    const job: CleanJob = {
      id: `rcj_${randomBytes(8).toString('hex')}`,
      owner: source.owner,
      from: source.id,
      status: 'running',
      stage: 'Waiting',
      recording: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.pending.set(key, job);
    const out = join(store.dir(source.owner), `${id}${ext}`);
    const run = this.opts.run ?? ((s, st) => runClean(this.opts.dataDir, s, st));
    this.tail = this.tail.then(async () => {
      job.stage = 'Cleaning';
      try {
        const r = await run({ src: path, out, target_lufs: o.targetLufs, peak: o.peak }, (name) => {
          job.stage = name;
        });
        const e = store.addCleaned(
          source,
          {
            file: rel,
            bytes: statSync(out).size,
            seconds: r.seconds,
            clean: {
              lufs: r.lufs,
              truePeak: r.true_peak,
              targetLufs: o.targetLufs,
              peak: o.peak,
              backend: r.backend,
            },
          },
          id,
        );
        job.recording = store.view(e);
        job.status = 'done';
        job.stage = null;
      } catch (err) {
        rmSync(out, { force: true });
        job.status = 'failed';
        job.stage = null;
        job.error =
          err instanceof RecordError ? err.message : 'Cleaning failed. The server log has the details.';
        if (!(err instanceof RecordError)) console.error(err);
      } finally {
        this.pending.delete(key);
      }
    });
    return job;
  }
}
