// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rm, statfs } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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

/** A file's identity once checked: what we verified it against, so a restart does not hash 20 GB again. */
interface Verified {
  revision: string;
  sha256: string;
  size: number;
}

export class ModelError extends Error {
  readonly code:
    | 'needs-login'
    | 'needs-license'
    | 'missing'
    | 'disk-full'
    | 'corrupt'
    | 'network'
    | 'canceled'
    | 'blocked';
  constructor(code: ModelError['code'], message: string) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
  }
}

/** What a download needs from the Hugging Face link. */
export interface TokenSource {
  accessToken(): Promise<string | null>;
}

/** What the user agreed to, and when: kept so a changed license is asked about again. */
interface Acceptance {
  license: string;
  licenseUrl: string;
  acceptedAt: string;
}

interface Job {
  abort: AbortController;
  done: number;
  total: number;
  file: string;
  bytesPerSec: number;
}

const HEADROOM = 2 * 1024 ** 3;

/**
 * Installs model weights into ComfyUI's models folder, straight from each file's Hugging Face repo. Downloads resume
 * after an interruption, check free space first, and are verified against the SHA-256 pinned in models.lock.json; for a
 * file not yet in the lock, against the hash Hugging Face publishes for it, pinned on first install.
 */
export class ModelManager {
  private readonly jobs = new Map<string, Job>();
  private readonly errors = new Map<string, string>();
  private verified: Record<string, Verified>;
  private accepted: Record<string, Acceptance>;
  private readonly acceptFile: string;
  private lastEmit = 0;
  private readonly recordFile: string;
  private readonly modelsDir: string;
  private readonly catalog: Catalog;
  private readonly lock: ModelLock;
  private readonly tokens: TokenSource;
  private readonly onChange: (s: ModelState[]) => void;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;
  private readonly gpu: Gpu | null;
  private readonly safety: SafetyCheck;

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
    this.safety = opts.safety ?? loadSafety();
    this.modelsDir = join(opts.comfyDir, 'models');
    this.recordFile = join(opts.dataDir, 'models.json');
    this.acceptFile = join(opts.dataDir, 'licenses.json');
    this.catalog = opts.catalog;
    this.lock = opts.lock;
    this.tokens = opts.tokens;
    this.onChange = opts.onChange;
    this.fetchFn = opts.fetch ?? fetch;
    this.endpoint = (opts.endpoint ?? process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/$/, '');
    try {
      this.verified = JSON.parse(readFileSync(this.recordFile, 'utf8')) as Record<string, Verified>;
    } catch {
      this.verified = {};
    }
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
    return this.lock.files[lockKey(f)]?.size ?? this.verified[lockKey(f)]?.size ?? null;
  }

  /** On disk, complete, and matching what was verified. Checks size only; hashing happens once, at download. */
  isInstalled(f: ModelFile): boolean {
    const p = this.pathOf(f);
    if (!existsSync(p)) return false;
    const size = statSync(p).size;
    const want = this.expectedSize(f);
    const rec = this.verified[lockKey(f)];
    const pin = this.lock.files[lockKey(f)];
    if (pin && rec && rec.sha256 !== pin.sha256) return false;
    return want === null ? size > 0 : size === want;
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

  private record(f: ModelFile, v: Verified) {
    this.verified[lockKey(f)] = v;
    mkdirSync(dirname(this.recordFile), { recursive: true });
    const tmp = `${this.recordFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.verified, null, 2));
    renameSync(tmp, this.recordFile);
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
      await this.checkSpace(todo);
      for (const f of todo) {
        job.file = basename(f.path);
        await this.download(f, job);
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

  private async checkSpace(todo: ModelFile[]) {
    const dir = this.modelsDir;
    mkdirSync(dir, { recursive: true });
    const need = todo.reduce((n, f) => {
      const part = `${this.pathOf(f)}.part`;
      const have = existsSync(part) ? statSync(part).size : 0;
      return n + Math.max(0, (this.expectedSize(f) ?? f.size) - have);
    }, 0);
    const fs = await statfs(dir);
    const free = Number(fs.bavail) * Number(fs.bsize);
    if (free < need + HEADROOM) {
      const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
      throw new ModelError(
        'disk-full',
        `This needs ${gb(need)} and ${gb(free)} is free. Free up ${gb(need + HEADROOM - free)}, then try again.`,
      );
    }
  }

  private headers(token: string | null): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /** Ask Hugging Face where a file is, what it hashes to, and whether this account may read it. */
  private async resolve(f: ModelFile, revision: string, token: string | null, signal: AbortSignal) {
    let url = `${this.endpoint}/${f.repo}/resolve/${revision}/${f.path.split('/').map(encodeURIComponent).join('/')}`;
    const head = (u: string) =>
      this.fetchFn(u, { method: 'HEAD', redirect: 'manual', headers: this.headers(token), signal });
    let res = await head(url);
    // A renamed repo answers 307 or 308 to its new name on the same host; the file's hash is on that answer's answer.
    const moved = res.headers.get('location');
    if ((res.status === 307 || res.status === 308) && moved) {
      const next = new URL(moved, url);
      if (next.origin === new URL(url).origin) {
        url = next.href;
        res = await head(url);
      }
    }
    if (res.status === 401)
      throw token
        ? new ModelError('needs-license', `Accept the license on huggingface.co/${f.repo}, then try again.`)
        : new ModelError(
            'needs-login',
            'This model needs a Hugging Face account. Link one in Settings, then try again.',
          );
    if (res.status === 403)
      throw new ModelError(
        'needs-license',
        `Accept the license on huggingface.co/${f.repo}, then try again.`,
      );
    if (res.status === 404) throw new ModelError('missing', `${f.repo} no longer has ${basename(f.path)}.`);
    if (res.status >= 400) throw new Error(`Hugging Face answered ${res.status}`);
    const etag = (res.headers.get('x-linked-etag') ?? res.headers.get('etag') ?? '')
      .replace(/^W\//, '')
      .replace(/"/g, '');
    return {
      url,
      // Where the repo lives now, which differs from the catalog's name after a rename.
      repoUrl: url.slice(0, url.indexOf('/resolve/')),
      commit: res.headers.get('x-repo-commit') ?? revision,
      sha256: /^[0-9a-f]{64}$/.test(etag) ? etag : null,
      size: Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length') ?? 0) || null,
    };
  }

  /**
   * What Hugging Face's model page says against a repo: its tags (not-for-all-audiences and the like) and its card.
   * A page that can't be read refuses nothing here, since every catalog file passed the same check when it was added.
   */
  private async hubVerdict(f: ModelFile, revision: string, token: string | null, signal: AbortSignal) {
    try {
      const res = await this.fetchFn(`${this.endpoint}/api/models/${f.repo}/revision/${revision}`, {
        headers: this.headers(token),
        signal,
      });
      if (!res.ok) return [];
      const m = (await res.json()) as { tags?: unknown; cardData?: { tags?: unknown; base_model?: unknown } };
      const strings = (v: unknown) =>
        Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
      return this.safety.model({
        repo: f.repo,
        tags: [...strings(m.tags), ...strings(m.cardData?.tags)],
        files: [{ name: f.path }],
      });
    } catch (e) {
      if (signal.aborted) throw e;
      return [];
    }
  }

  private async download(f: ModelFile, job: Job): Promise<void> {
    const signal = job.abort.signal;
    const pin = this.lock.files[lockKey(f)];
    const token = f.gated
      ? await this.tokens.accessToken()
      : await this.tokens.accessToken().catch(() => null);
    if (f.gated && !token)
      throw new ModelError(
        'needs-login',
        'This model needs a Hugging Face account. Link one in Settings, then try again.',
      );
    const info = await this.resolve(f, pin?.revision ?? 'main', token, signal);
    const want =
      pin ??
      (info.sha256 && info.size ? { revision: info.commit, sha256: info.sha256, size: info.size } : null);
    if (!want)
      throw new ModelError(
        'corrupt',
        `Hugging Face gave no checksum for ${basename(f.path)}, so it cannot be verified.`,
      );
    const refused = (why: string) =>
      new ModelError(
        'blocked',
        `Hildegard won’t install ${basename(f.path)}: ${why}. It doesn’t load sexual models.`,
      );
    if (this.safety.blockedHash(want.sha256) || this.safety.blockedHash(info.sha256))
      throw refused('it’s a known sexual model file');
    // A file not pinned in models.lock.json: ask what Hugging Face says about its repo now, too.
    if (!pin) {
      const why = await this.hubVerdict(f, want.revision, token, signal);
      if (why.length) throw refused(why.join('; '));
    }

    const dest = this.pathOf(f);
    const part = `${dest}.part`;
    mkdirSync(dirname(dest), { recursive: true });
    const hash = createHash('sha256');
    let have = 0;
    if (existsSync(part)) {
      have = statSync(part).size;
      if (have > want.size) {
        await rm(part, { force: true });
        have = 0;
      } else if (have > 0) {
        for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
      }
    }
    job.done += have;

    if (have < want.size) {
      const res = await this.fetchFn(
        `${info.repoUrl}/resolve/${want.revision}/${f.path.split('/').map(encodeURIComponent).join('/')}`,
        {
          headers: { ...this.headers(token), ...(have ? { range: `bytes=${have}-` } : {}) },
          signal,
        },
      );
      if (!res.ok || !res.body) throw new Error(`Hugging Face answered ${res.status}`);
      if (have && res.status !== 206) {
        // The server ignored the range: start over.
        job.done -= have;
        await res.body.cancel();
        await rm(part, { force: true });
        return this.download(f, job);
      }
      let windowStart = Date.now();
      let windowBytes = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _e, cb) => {
          hash.update(chunk);
          job.done += chunk.length;
          windowBytes += chunk.length;
          const t = Date.now();
          if (t - windowStart >= 1000) {
            const rate = (windowBytes * 1000) / (t - windowStart);
            job.bytesPerSec = job.bytesPerSec ? job.bytesPerSec * 0.6 + rate * 0.4 : rate;
            windowStart = t;
            windowBytes = 0;
          }
          this.emit();
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body as never),
        meter,
        createWriteStream(part, { flags: have ? 'a' : 'w' }),
        { signal },
      );
    }

    const size = statSync(part).size;
    const sha256 = hash.digest('hex');
    if (this.safety.blockedHash(sha256)) {
      await rm(part, { force: true });
      throw refused('it’s a known sexual model file');
    }
    if (size !== want.size || sha256 !== want.sha256) {
      await rm(part, { force: true });
      throw new ModelError(
        'corrupt',
        `${basename(f.path)} did not match its checksum and was deleted. Try again.`,
      );
    }
    renameSync(part, dest);
    this.record(f, { revision: want.revision, sha256, size });
  }
}
