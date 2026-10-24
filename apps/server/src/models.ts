// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type Catalog,
  loadSafety,
  lockKey,
  type Model,
  type ModelFile,
  type ModelLock,
  type ModelState,
  type SafetyCheck,
} from '@hildegard/presets';
import { fit, fitWhy, type Gpu } from '@hildegard/runtime';
import { type FetchJob, FileFetcher, ModelError, type TokenSource } from './fetcher.ts';

export { ModelError, type TokenSource };

/** What the user agreed to, and when: kept so a changed license is asked about again. */
interface Acceptance {
  license: string;
  licenseUrl: string;
  acceptedAt: string;
}

type Job = FetchJob;

/**
 * Installs model weights into ComfyUI's models folder, straight from each file's Hugging Face repo. Downloads resume
 * after an interruption, check free space first, and are verified against the SHA-256 pinned in models.lock.json; for a
 * file not yet in the lock, against the hash Hugging Face publishes for it, pinned on first install.
 */
export class ModelManager {
  private readonly jobs = new Map<string, Job>();
  private readonly errors = new Map<string, string>();
  private readonly fetcher: FileFetcher;
  private accepted: Record<string, Acceptance>;
  private readonly acceptFile: string;
  private lastEmit = 0;
  private readonly modelsDir: string;
  private readonly catalog: Catalog;
  private readonly onChange: (s: ModelState[]) => void;
  private readonly gpu: Gpu | null;

  constructor(opts: {
    comfyDir: string;
    dataDir: string;
    catalog: Catalog;
    lock: ModelLock;
    tokens: TokenSource;
    onChange: (s: ModelState[]) => void;
    fetch?: typeof fetch;
    endpoint?: string;
    /** This computer's GPU, to say which models fit it. */
    gpu?: Gpu | null;
    /** What may be installed; presets/safety.toml unless a test says otherwise. */
    safety?: SafetyCheck;
  }) {
    this.gpu = opts.gpu ?? null;
    this.modelsDir = join(opts.comfyDir, 'models');
    this.acceptFile = join(opts.dataDir, 'licenses.json');
    this.catalog = opts.catalog;
    this.onChange = opts.onChange;
    this.fetcher = new FileFetcher({
      recordFile: join(opts.dataDir, 'models.json'),
      lock: opts.lock,
      tokens: opts.tokens,
      safety: opts.safety ?? loadSafety(),
      fetch: opts.fetch,
      endpoint: opts.endpoint,
      onProgress: () => this.emit(),
    });
    try {
      this.accepted = JSON.parse(readFileSync(this.acceptFile, 'utf8')) as Record<string, Acceptance>;
    } catch {
      this.accepted = {};
    }
  }

  licenseAccepted(id: string): boolean {
    const m = this.model(id);
    const a = this.accepted[id];
    return !!a && a.license === m.license && a.licenseUrl === m.licenseUrl;
  }

  /** Record that the user accepted this model's license, as shown to them. */
  acceptLicense(id: string) {
    const m = this.model(id);
    this.accepted[id] = {
      license: m.license,
      licenseUrl: m.licenseUrl,
      acceptedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(this.acceptFile), { recursive: true });
    const tmp = `${this.acceptFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.accepted, null, 2));
    renameSync(tmp, this.acceptFile);
    this.emit(true);
  }

  private model(id: string): Model {
    const m = this.catalog.models.find((x) => x.id === id);
    if (!m) throw new ModelError('missing', 'No such model.');
    return m;
  }

  /** Every file a model needs: its own, its camera LoRAs, and the safety classifier every render passes through. */
  filesOf(m: Model): ModelFile[] {
    const all = [...m.files, ...Object.values(m.loras), this.catalog.safety.classifier];
    return all.filter((f, i) => all.findIndex((g) => lockKey(g) === lockKey(f)) === i);
  }

  /**
   * A model installed before the safety check came (0.1.1) has its own files but not the classifier, so it read as not
   * installed and nothing rendered after an upgrade. This fetches just the classifier for the first such model.
   */
  async completeSafety(): Promise<void> {
    if (this.isInstalled(this.catalog.safety.classifier)) return;
    const m = this.catalog.models.find(
      (x) =>
        this.licenseAccepted(x.id) &&
        [...x.files, ...Object.values(x.loras)].every((f) => this.isInstalled(f)),
    );
    if (m) await this.install(m.id);
  }

  pathOf(f: ModelFile): string {
    return join(this.modelsDir, f.dir, basename(f.path));
  }

  private expectedSize(f: ModelFile): number | null {
    return this.fetcher.expectedSize(f);
  }

  /** On disk, complete, and matching what was verified. Checks size only; hashing happens once, at download. */
  isInstalled(f: ModelFile): boolean {
    return this.fetcher.isInstalled(f, this.pathOf(f));
  }

  states(): ModelState[] {
    return this.catalog.models.map((m) => {
      const files = this.filesOf(m);
      const missing = files.filter((f) => !this.isInstalled(f));
      const job = this.jobs.get(m.id);
      return {
        id: m.id,
        installed: missing.length === 0,
        missingBytes: missing.reduce((n, f) => n + (this.expectedSize(f) ?? f.size), 0),
        downloading: job
          ? { done: job.done, total: job.total, file: job.file, bytesPerSec: Math.round(job.bytesPerSec) }
          : null,
        gated: m.gated,
        licenseAccepted: this.licenseAccepted(m.id),
        fit: this.gpu ? fit(this.gpu, m) : null,
        fitWhy: this.gpu ? fitWhy(this.gpu, m) : null,
        error: this.errors.get(m.id) ?? null,
      };
    });
  }

  private emit(force = false) {
    const now = Date.now();
    if (!force && now - this.lastEmit < 250) return;
    this.lastEmit = now;
    this.onChange(this.states());
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    job.abort.abort();
    return true;
  }

  /** Start installing; progress arrives through onChange. Resolves when the model is ready or the install stops. */
  async install(id: string): Promise<void> {
    const m = this.model(id);
    if (!this.licenseAccepted(id))
      throw new ModelError(
        'needs-license',
        `Accept the ${m.license} in Hildegard before ${m.name} downloads.`,
      );
    if (this.jobs.has(id)) return;
    const todo = this.filesOf(m).filter((f) => !this.isInstalled(f));
    if (!todo.length) return;
    const job: Job = {
      abort: new AbortController(),
      done: 0,
      total: todo.reduce((n, f) => n + (this.expectedSize(f) ?? f.size), 0),
      file: basename(todo[0]!.path),
      bytesPerSec: 0,
    };
    this.jobs.set(id, job);
    this.errors.delete(id);
    this.emit(true);
    try {
      await this.fetcher.checkSpace(
        this.modelsDir,
        todo.map((f) => ({ file: f, path: this.pathOf(f) })),
      );
      for (const f of todo) {
        job.file = basename(f.path);
        await this.fetcher.fetchFile(f, this.pathOf(f), job);
      }
    } catch (e) {
      const err =
        e instanceof ModelError
          ? e
          : job.abort.signal.aborted
            ? new ModelError('canceled', 'Download stopped.')
            : new ModelError(
                'network',
                `The download stopped: ${(e as Error).message}. Start it again to resume.`,
              );
      if (err.code !== 'canceled') this.errors.set(id, err.message);
    } finally {
      this.jobs.delete(id);
      this.emit(true);
    }
  }
}
