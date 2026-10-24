// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Fetching one model file from its Hugging Face repo: resumable, checked for space first, and verified. A file pinned
 * in models.lock.json must match its SHA-256 there; one that isn't pinned yet is verified against the hash Hugging Face
 * publishes for it (an LFS file's SHA-256, or a small file's git object id) and pinned on first install. Shared by
 * video models (`ModelManager`) and voice models (`VoiceModels`).
 */
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
import { basename, dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LockedFile, ModelLock, SafetyCheck } from '@hildegard/presets';

/** A file's identity once checked: what we verified it against, so a restart does not hash 20 GB again. */
export type Verified = LockedFile;

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

/** One download in progress, which may span several files. */
export interface FetchJob {
  abort: AbortController;
  done: number;
  total: number;
  file: string;
  bytesPerSec: number;
}

export interface RemoteFile {
  repo: string;
  path: string;
  gated?: boolean;
}

const HEADROOM = 2 * 1024 ** 3;
/** Small files Hugging Face keeps in git rather than LFS: it publishes their git object id, not a SHA-256. */
const GIT_FILE_MAX = 50 * 1024 * 1024;
const lockKey = (f: { repo: string; path: string }) => `${f.repo}/${f.path}`;

/** The id git gives a file's contents: SHA-1 of "blob <size>\0" and the bytes. */
export function gitBlobId(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export class FileFetcher {
  private verified: Record<string, Verified>;
  private readonly recordFile: string;
  private readonly lock: ModelLock;
  private readonly tokens: TokenSource;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;
  private readonly safety: SafetyCheck;
  private readonly onProgress: () => void;

  constructor(opts: {
    /** Where verified files are recorded (models.json). */
    recordFile: string;
    lock: ModelLock;
    tokens: TokenSource;
    safety: SafetyCheck;
    fetch?: typeof fetch;
    endpoint?: string;
    /** Called as bytes arrive; callers throttle. */
    onProgress?: () => void;
  }) {
    this.recordFile = opts.recordFile;
    this.lock = opts.lock;
    this.tokens = opts.tokens;
    this.safety = opts.safety;
    this.fetchFn = opts.fetch ?? fetch;
    this.endpoint = (opts.endpoint ?? process.env.HF_ENDPOINT ?? 'https://huggingface.co').replace(/\/$/, '');
    this.onProgress = opts.onProgress ?? (() => {});
    try {
      this.verified = JSON.parse(readFileSync(this.recordFile, 'utf8')) as Record<string, Verified>;
    } catch {
      this.verified = {};
    }
  }

  expectedSize(f: RemoteFile): number | null {
    return this.lock.files[lockKey(f)]?.size ?? this.verified[lockKey(f)]?.size ?? null;
  }

  /** On disk at `path`, complete, and matching what was verified. Checks size only; hashing happens once, at download. */
  isInstalled(f: RemoteFile, path: string): boolean {
    if (!existsSync(path)) return false;
    const size = statSync(path).size;
    const want = this.expectedSize(f);
    const rec = this.verified[lockKey(f)];
    const pin = this.lock.files[lockKey(f)];
    if (pin && rec && rec.sha256 !== pin.sha256) return false;
    return want === null ? size > 0 : size === want;
  }

  /** Room for what is left to fetch, plus headroom, on the drive `dir` is on. */
  async checkSpace(dir: string, todo: Array<{ file: RemoteFile & { size: number }; path: string }>) {
    mkdirSync(dir, { recursive: true });
    const need = todo.reduce((n, { file, path }) => {
      const part = `${path}.part`;
      const have = existsSync(part) ? statSync(part).size : 0;
      return n + Math.max(0, (this.expectedSize(file) ?? file.size) - have);
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

  private record(f: RemoteFile, v: Verified) {
    this.verified[lockKey(f)] = v;
    mkdirSync(dirname(this.recordFile), { recursive: true });
    const tmp = `${this.recordFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.verified, null, 2));
    renameSync(tmp, this.recordFile);
  }

  private headers(token: string | null): Record<string, string> {
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /** Ask Hugging Face where a file is, what it hashes to, and whether this account may read it. */
  private async resolve(f: RemoteFile, revision: string, token: string | null, signal: AbortSignal) {
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
    const linked = res.headers.get('x-linked-etag');
    const etag = (linked ?? res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '');
    const size = Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length') ?? 0) || null;
    return {
      url,
      // Where the repo lives now, which differs from the catalog's name after a rename.
      repoUrl: url.slice(0, url.indexOf('/resolve/')),
      commit: res.headers.get('x-repo-commit') ?? revision,
      sha256: /^[0-9a-f]{64}$/.test(etag) ? etag : null,
      // A file kept in git: its etag is the git object id, which is a hash of its bytes too.
      gitId: !linked && /^[0-9a-f]{40}$/.test(etag) ? etag : null,
      size,
    };
  }

  /**
   * What Hugging Face's model page says against a repo: its tags (not-for-all-audiences and the like) and its card.
   * A page that can't be read refuses nothing here, since every catalog file passed the same check when it was added.
   */
  private async hubVerdict(f: RemoteFile, revision: string, token: string | null, signal: AbortSignal) {
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

  /** Fetch `f` to `dest`, counting bytes into `job`. Resolves once the file is verified and in place. */
  async fetchFile(f: RemoteFile, dest: string, job: FetchJob): Promise<void> {
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
    const git = !pin && !info.sha256 && info.gitId && info.size && info.size <= GIT_FILE_MAX;
    const want =
      pin ??
      (info.sha256 && info.size
        ? { revision: info.commit, sha256: info.sha256, size: info.size }
        : git
          ? { revision: info.commit, sha256: null, size: info.size! }
          : null);
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
    if (
      this.safety.blockedHash(want.sha256 ?? undefined) ||
      this.safety.blockedHash(info.sha256 ?? undefined)
    )
      throw refused('it’s a known sexual model file');
    // A file not pinned in models.lock.json: ask what Hugging Face says about its repo now, too.
    if (!pin) {
      const why = await this.hubVerdict(f, want.revision, token, signal);
      if (why.length) throw refused(why.join('; '));
    }

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
        return this.fetchFile(f, dest, job);
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
          this.onProgress();
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
    const matches =
      size === want.size &&
      (want.sha256 ? sha256 === want.sha256 : gitBlobId(readFileSync(part)) === info.gitId);
    if (!matches) {
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
