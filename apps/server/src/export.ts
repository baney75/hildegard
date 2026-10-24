// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Export film: joins each shot's chosen take, in order, into one MP4 with tools/export_film.py. It runs on the Python
 * that `hildegard install` set up for ComfyUI, whose PyAV brings its own FFmpeg, so there is nothing more to install.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type Review, type ReviewSpec, reviewMedia } from '@hildegard/craft';
import type { Catalog, ExportState, Take } from '@hildegard/presets';
import { layout, resource } from '@hildegard/runtime';
import type { Store } from './store.ts';

export class ExportError extends Error {
  readonly status: 404 | 409;
  constructor(message: string, status: 404 | 409) {
    super(message);
    this.status = status;
  }
}

/** The take each shot shows in the film: the newest kept take that finished, or else the newest that finished. */
export function chosenTakes(store: Store, projectId: string): Take[] {
  const p = store.projects.get(projectId);
  if (!p) return [];
  const out: Take[] = [];
  for (const shotId of p.shotIds) {
    const takes = (store.shots.get(shotId)?.takeIds ?? [])
      .map((id) => store.takes.get(id))
      .filter((t): t is Take => !!t && t.status === 'done' && !!t.video);
    const pick = takes.findLast((t) => t.kept) ?? takes.at(-1);
    if (pick) out.push(pick);
  }
  return out;
}

/** The Python with PyAV: Hildegard's own, then HILDEGARD_PYTHON, then the system's. */
export function exportPython(dataDir: string): string {
  const own = layout(dataDir).python;
  if (existsSync(own)) return own;
  return process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
}

/**
 * Writes a full-size poster for a finished take with tools/poster.py. Resolves false when that can't run (no PyAV on a
 * computer that only renders on other devices, say), and the caller keeps the sampler's smaller preview.
 */
export function makePoster(dataDir: string, video: string, out: string): Promise<boolean> {
  let script: string;
  try {
    script = resource(join('tools', 'poster.py'));
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const child = spawn(exportPython(dataDir), ['-I', script, video, out], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.once('error', () => resolve(false));
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/** Technical checks on finished media with tools/review_media.py, on the same Python; undefined if the script is missing. */
export function reviewer(dataDir: string): ((spec: ReviewSpec) => Promise<Review>) | undefined {
  let script: string;
  try {
    script = resource(join('tools', 'review_media.py'));
  } catch {
    return undefined;
  }
  return (spec) => reviewMedia(exportPython(dataDir), script, spec);
}

export interface ExporterOptions {
  store: Store;
  catalog: Catalog;
  mediaDir: string;
  dataDir: string;
  /** Written into the file, so what Hildegard made stays labeled as AI-generated wherever it goes. */
  credit: string;
  onChange: (e: ExportState) => void;
}

export class Exporter {
  private readonly jobs = new Map<string, ExportState>();
  private readonly dir: string;

  private readonly opts: ExporterOptions;

  constructor(opts: ExporterOptions) {
    this.opts = opts;
    this.dir = join(opts.mediaDir, 'exports');
  }

  list(): ExportState[] {
    return [...this.jobs.values()];
  }

  get(id: string): ExportState | undefined {
    return this.jobs.get(id);
  }

  file(e: ExportState): string {
    return join(this.dir, `${e.id}.mp4`);
  }

  start(projectId: string): ExportState {
    const { store, catalog } = this.opts;
    const project = store.projects.get(projectId);
    if (!project) throw new ExportError('No such film', 404);
    if ([...this.jobs.values()].some((j) => j.projectId === projectId && j.status === 'running'))
      throw new ExportError('This film is already exporting', 409);
    const takes = chosenTakes(store, projectId);
    if (!takes.length) throw new ExportError('No shot has a finished take yet', 409);

    const e: ExportState = {
      id: randomUUID(),
      projectId,
      title: project.title,
      status: 'running',
      done: 0,
      total: takes.length,
      takeIds: takes.map((t) => t.id),
      url: null,
      bytes: null,
      seconds: null,
      error: null,
      createdAt: new Date().toISOString(),
    };
    // Only the newest export of each film is kept.
    for (const [id, old] of this.jobs)
      if (old.projectId === projectId) {
        rmSync(this.file(old), { force: true });
        this.jobs.delete(id);
      }
    this.jobs.set(e.id, e);
    this.opts.onChange(e);

    mkdirSync(this.dir, { recursive: true });
    const models = [
      ...new Set(takes.map((t) => catalog.models.find((m) => m.id === t.model)?.name ?? t.model)),
    ];
    const spec = join(this.dir, `${e.id}.json`);
    writeFileSync(
      spec,
      JSON.stringify({
        out: this.file(e),
        inputs: takes.map((t) => join(this.opts.mediaDir, t.video!.replace(/^\/media\//, ''))),
        title: project.title,
        comment: `AI-generated video, made with ${models.join(' and ')}. ${this.opts.credit}`,
      }),
    );
    void this.run(e, spec);
    return e;
  }

  private async run(e: ExportState, spec: string) {
    const update = (patch: Partial<ExportState>) => {
      Object.assign(e, patch);
      this.opts.onChange({ ...e });
    };
    let script: string;
    try {
      script = resource(join('tools', 'export_film.py'));
    } catch (err) {
      update({ status: 'failed', error: (err as Error).message });
      return;
    }
    const py = exportPython(this.opts.dataDir);
    const child = spawn(py, ['-I', script, spec], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const exited = new Promise<number>((r) => {
      child.once('error', () => r(-1));
      child.once('close', (c) => r(c ?? -1));
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    let error: string | null = null;
    let seconds: number | null = null;
    for await (const line of createInterface({ input: child.stdout })) {
      try {
        const m = JSON.parse(line) as { done?: number; ok?: boolean; error?: string; seconds?: number };
        if (typeof m.done === 'number') update({ done: m.done });
        if (typeof m.seconds === 'number') seconds = m.seconds;
        if (m.ok === false) error = m.error ?? null;
      } catch {}
    }
    const code = await exited;
    rmSync(spec, { force: true });
    if (code === 0 && existsSync(this.file(e))) {
      update({
        status: 'done',
        done: e.total,
        url: `/media/exports/${e.id}.mp4`,
        bytes: statSync(this.file(e)).size,
        seconds,
      });
      return;
    }
    const noPython = code === -1 || /No module named|ModuleNotFoundError/.test(`${error ?? ''}${stderr}`);
    if (stderr) console.error(`Export ${e.id} failed:\n${stderr}`);
    update({
      status: 'failed',
      error: noPython
        ? 'Exporting uses the Python that `hildegard install` sets up. Run `hildegard install`, then try again.'
        : (error ?? 'The export failed. The server log has the details.'),
    });
  }
}
