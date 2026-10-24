// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Voice model weights, from each model's Hugging Face repo into `<data>/voice/models/<model>/`, with the same checks as
 * video models: free space first, resumable, verified against models.lock.json or the hash Hugging Face publishes.
 * A model that clones also brings the speaker check and Whisper, which consent needs.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  ModelLock,
  SafetyCheck,
  VoiceCatalog,
  VoiceFile,
  VoiceModel,
  VoiceModelState,
} from '@hildegard/presets';
import type { Gpu } from '@hildegard/runtime';
import { type FetchJob, FileFetcher, ModelError, type TokenSource } from './fetcher.ts';
import { type VoiceEnv, voiceLayout } from './voice-engine.ts';

interface Acceptance {
  license: string;
  licenseUrl: string;
  acceptedAt: string;
}

/** The transcriber consent and dubbing use. */
export const TRANSCRIBER = 'whisper-small';

/** How a voice model suits this computer: on the GPU, slowly on the CPU, or not at all. */
export function voiceFit(gpu: Gpu | null, m: VoiceModel): VoiceModelState['fit'] {
  if (!gpu) return null;
  if (m.minVramGb === 0) return 'good';
  if (gpu.backend === 'cpu' || gpu.vramGb === null) return gpu.backend === 'mps' ? 'good' : 'slow';
  if (gpu.backend === 'mps') return gpu.vramGb >= m.minVramGb * 1.5 ? 'good' : 'slow';
  return gpu.vramGb >= m.minVramGb ? 'good' : gpu.vramGb >= m.minVramGb * 0.6 ? 'slow' : 'no';
}

export class VoiceModels {
  private readonly fetcher: FileFetcher;
  private readonly catalog: VoiceCatalog;
  private readonly dir: string;
  private readonly acceptFile: string;
  private accepted: Record<string, Acceptance>;
  private readonly jobs = new Map<string, FetchJob>();
  private readonly errors = new Map<string, string>();
  private readonly gpu: Gpu | null;
  private readonly envReady: (env: VoiceEnv) => boolean;
  private readonly onChange: (s: VoiceModelState[]) => void;
  /** The stand-in GPU: every model counts as installed, as video models do there, since nothing real runs. */
  private readonly standIn: boolean;
  private lastEmit = 0;

  constructor(opts: {
    dataDir: string;
    catalog: VoiceCatalog;
    lock: ModelLock;
    tokens: TokenSource;
    safety: SafetyCheck;
    gpu?: Gpu | null;
    envReady: (env: VoiceEnv) => boolean;
    onChange: (s: VoiceModelState[]) => void;
    fetch?: typeof fetch;
    endpoint?: string;
    standIn?: boolean;
  }) {
    const L = voiceLayout(opts.dataDir);
    this.dir = L.models;
    this.catalog = opts.catalog;
    this.gpu = opts.gpu ?? null;
    this.envReady = opts.envReady;
    this.onChange = opts.onChange;
    this.standIn = opts.standIn ?? false;
    this.acceptFile = join(L.root, 'licenses.json');
    try {
      this.accepted = JSON.parse(readFileSync(this.acceptFile, 'utf8')) as Record<string, Acceptance>;
    } catch {
      this.accepted = {};
    }
    this.fetcher = new FileFetcher({
      recordFile: join(L.root, 'models.json'),
      lock: opts.lock,
      tokens: opts.tokens,
      safety: opts.safety,
      fetch: opts.fetch,
      endpoint: opts.endpoint,
      onProgress: () => this.emit(),
    });
  }

  model(id: string): VoiceModel {
    const m = this.catalog.models.find((x) => x.id === id);
    if (!m) throw new ModelError('missing', 'No such voice model.');
    return m;
  }

  /** The models installing this one brings: the transcriber and speaker check for a model that clones. */
  needs(m: VoiceModel): VoiceModel[] {
    const t = this.catalog.models.find((x) => x.id === TRANSCRIBER);
    return m.can.includes('clone') && t && t.id !== m.id ? [t] : [];
  }

  /** Where a model's file goes; the speaker check has a folder of its own. */
  pathOf(owner: string, f: VoiceFile): string {
    return join(this.dir, owner, ...f.path.split('/'));
  }

  /** The folder the worker loads a model from. */
  dirOf(id: string): string {
    return join(this.dir, id);
  }

  /** The speaker check's weights file. */
  encoderPath(): string {
    return this.pathOf('consent', this.catalog.consent.encoder);
  }

  /** Whether the speaker check can run: its weights are here, or the stand-in GPU needs none. */
  hasEncoder(): boolean {
    return this.standIn || existsSync(this.encoderPath());
  }

  private filesOf(m: VoiceModel): Array<{ file: VoiceFile; path: string }> {
    const own = m.files.map((f) => ({ file: f, path: this.pathOf(m.id, f) }));
    if (!m.can.includes('clone')) return own;
    const enc = this.catalog.consent.encoder;
    return [...own, { file: enc, path: this.pathOf('consent', enc) }];
  }

  licenseAccepted(id: string): boolean {
    const m = this.model(id);
    const a = this.accepted[id];
    return !!a && a.license === m.license && a.licenseUrl === m.licenseUrl;
  }

  /** Record that the owner accepted this model's license, and those of the models it brings, as shown to them. */
  acceptLicense(id: string) {
    for (const m of [this.model(id), ...this.needs(this.model(id))])
      this.accepted[m.id] = {
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

  installed(id: string): boolean {
    const m = this.catalog.models.find((x) => x.id === id);
    if (m && this.standIn) return true;
    return !!m && this.filesOf(m).every(({ file, path }) => this.fetcher.isInstalled(file, path));
  }

  /** Installed, and its Python environment is set up: it can run now. */
  usable(id: string): boolean {
    const m = this.catalog.models.find((x) => x.id === id);
    return !!m && this.installed(id) && this.envReady(m.env);
  }

  states(): VoiceModelState[] {
    return this.catalog.models.map((m) => {
      const missing = this.standIn
        ? []
        : this.filesOf(m).filter(({ file, path }) => !this.fetcher.isInstalled(file, path));
      const job = this.jobs.get(m.id);
      return {
        id: m.id,
        installed: missing.length === 0,
        missingBytes: missing.reduce((n, { file }) => n + (this.fetcher.expectedSize(file) ?? file.size), 0),
        downloading: job
          ? { done: job.done, total: job.total, file: job.file, bytesPerSec: Math.round(job.bytesPerSec) }
          : null,
        licenseAccepted: this.licenseAccepted(m.id),
        ready: this.envReady(m.env),
        fit: voiceFit(this.gpu, m),
        error: this.errors.get(m.id) ?? null,
      };
    });
  }

  emit(force = false) {
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

  /** Download a model and what it brings. Progress arrives through onChange; resolves when done or stopped. */
  async install(id: string): Promise<void> {
    const m = this.model(id);
    if (!this.licenseAccepted(id))
      throw new ModelError(
        'needs-license',
        `Accept the ${m.license} in Hildegard before ${m.name} downloads.`,
      );
    for (const dep of this.needs(m)) if (!this.installed(dep.id)) await this.install(dep.id);
    if (this.jobs.has(id) || this.standIn) return;
    const todo = this.filesOf(m).filter(({ file, path }) => !this.fetcher.isInstalled(file, path));
    if (!todo.length) return;
    const job: FetchJob = {
      abort: new AbortController(),
      done: 0,
      total: todo.reduce((n, { file }) => n + (this.fetcher.expectedSize(file) ?? file.size), 0),
      file: basename(todo[0]!.file.path),
      bytesPerSec: 0,
    };
    this.jobs.set(id, job);
    this.errors.delete(id);
    this.emit(true);
    try {
      await this.fetcher.checkSpace(this.dir, todo);
      for (const { file, path } of todo) {
        job.file = basename(file.path);
        await this.fetcher.fetchFile(file, path, job);
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
