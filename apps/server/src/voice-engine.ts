// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The voice engine: Python workers (voice-engine/hildegard_voice), one per environment, that speak, clone, convert
 * and transcribe on this computer's GPU. Each speaks JSON lines over stdin and stdout and reads and writes only the
 * files named in its requests. `FakeVoiceEngine` stands in for them in tests and in `--fake-gpu`, in plain TypeScript.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type VoiceEnv = 'speech' | 'chatterbox' | 'qwen';
export const VOICE_ENVS: readonly VoiceEnv[] = ['speech', 'chatterbox', 'qwen'];

/** The Python each environment wants: Chatterbox pins a torch that has no 3.12 wheels on every platform. */
export const VOICE_PYTHON: Record<VoiceEnv, string> = { speech: '3.12', chatterbox: '3.11', qwen: '3.12' };

export interface CallOpts {
  onProgress?: (p: { done: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface VoiceEngine {
  readonly fake: boolean;
  /** Whether this environment is set up here. */
  ready(env: VoiceEnv): boolean;
  /** Run one op in one environment's worker. */
  call<T>(env: VoiceEnv, op: string, args: Record<string, unknown>, opts?: CallOpts): Promise<T>;
  /** Let go of the GPU memory every worker holds; they stay running. */
  release(): Promise<void>;
  close(): Promise<void>;
}

export class VoiceEngineError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(code: string, message: string, detail = '') {
    super(message);
    this.name = 'VoiceEngineError';
    this.code = code;
    this.detail = detail;
  }
}

/** Ops that load a model onto the GPU: before one runs, the other workers let go of theirs. */
const HEAVY = new Set(['speak', 'convert', 'transcribe', 'embed']);

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: CallOpts['onProgress'];
}

/** One running `python -m hildegard_voice`. */
class Worker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private buf = '';
  private stderr = '';
  private next = 1;
  readonly started: Promise<void>;
  exited = false;
  /** Holds a model in GPU memory. */
  loaded = false;
  lastUsed = Date.now();

  constructor(python: string, engineDir: string, env: NodeJS.ProcessEnv, onExit: () => void) {
    this.child = spawn(python, ['-m', 'hildegard_voice'], {
      cwd: engineDir,
      env: {
        ...process.env,
        ...env,
        PYTHONPATH: engineDir,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        PYTHONNOUSERSITE: '1',
      },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let ready: () => void;
    let failed: (e: unknown) => void;
    this.started = new Promise((res, rej) => {
      ready = res;
      failed = rej;
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (s: string) => {
      this.buf += s;
      let i = this.buf.indexOf('\n');
      while (i >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        i = this.buf.indexOf('\n');
        if (!line) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.ready === true) {
          ready();
          continue;
        }
        const p = this.pending.get(String(msg.id ?? ''));
        if (!p) continue;
        if (msg.progress && typeof msg.progress === 'object') {
          p.onProgress?.(msg.progress as { done: number; total: number });
          continue;
        }
        this.pending.delete(String(msg.id));
        if (msg.ok === true) p.resolve(msg.result);
        else {
          const e = (msg.error ?? {}) as { code?: string; message?: string; detail?: string };
          p.reject(
            new VoiceEngineError(
              e.code ?? 'engine_failed',
              e.message ?? 'The voice engine failed.',
              e.detail,
            ),
          );
        }
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (s: string) => {
      this.stderr = (this.stderr + s).slice(-8000);
    });
    const gone = (why: string) => {
      if (this.exited) return;
      this.exited = true;
      const err = new VoiceEngineError(
        'engine_failed',
        'The voice engine stopped.',
        `${why}\n${this.stderr.trim().split('\n').slice(-12).join('\n')}`,
      );
      failed(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      onExit();
    };
    this.child.on('error', (e) =>
      gone(`couldn’t start ${python}: ${(e as NodeJS.ErrnoException).code ?? e.message}`),
    );
    this.child.on('exit', (code, signal) => gone(`exit ${signal ?? code}`));
  }

  async call(op: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<unknown> {
    await this.started;
    if (this.exited) throw new VoiceEngineError('engine_failed', 'The voice engine stopped.');
    const id = String(this.next++);
    this.lastUsed = Date.now();
    if (HEAVY.has(op)) this.loaded = true;
    if (op === 'release') this.loaded = false;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress: opts.onProgress });
      this.child.stdin.write(`${JSON.stringify({ ...args, id, op })}\n`);
    });
  }

  kill() {
    if (!this.exited) this.child.kill();
  }

  /** Close stdin so the worker frees the GPU and ends on its own; kill it if it doesn't. */
  async end(ms = 5000): Promise<void> {
    if (this.exited) return;
    const done = new Promise<void>((r) => this.child.once('exit', () => r()));
    this.child.stdin.end();
    const t = setTimeout(() => this.kill(), ms);
    await done;
    clearTimeout(t);
  }
}

const win = process.platform === 'win32';

/** Where voice lives in Hildegard's data folder. */
export function voiceLayout(dataDir: string) {
  const root = join(dataDir, 'voice');
  return {
    root,
    models: join(root, 'models'),
    envs: join(root, 'envs'),
    /** The worker's code, copied from the release so an update doesn't change it under a running worker. */
    engine: join(root, 'engine'),
    python: (env: VoiceEnv) =>
      win ? join(root, 'envs', env, 'Scripts', 'python.exe') : join(root, 'envs', env, 'bin', 'python'),
    /** Written last by the installer: its presence means the environment is ready. */
    manifest: (env: VoiceEnv) => join(root, 'envs', env, 'hildegard-voice.json'),
  };
}

export class LocalVoiceEngine implements VoiceEngine {
  readonly fake = false;
  private readonly workers = new Map<VoiceEnv, Worker>();
  private readonly python: (env: VoiceEnv) => string;
  private readonly isReady: (env: VoiceEnv) => boolean;
  private readonly engineDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly idleMs: number;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(opts: {
    dataDir: string;
    /** Where hildegard_voice is; the copy in the data folder by default. */
    engineDir?: string;
    /** Each environment's Python; the installer's by default. */
    python?: (env: VoiceEnv) => string;
    ready?: (env: VoiceEnv) => boolean;
    /** Extra environment for the workers (tests: HILDEGARD_VOICE_FAKE_MARK). */
    env?: NodeJS.ProcessEnv;
    /** After this long with nothing to do, workers let go of the GPU; after ten times it, they end. */
    idleMs?: number;
  }) {
    const L = voiceLayout(opts.dataDir);
    this.engineDir = opts.engineDir ?? L.engine;
    this.python = opts.python ?? L.python;
    this.isReady =
      opts.ready ??
      ((env) => existsSync(L.manifest(env)) && existsSync(join(this.engineDir, 'hildegard_voice')));
    this.env = opts.env ?? {};
    this.idleMs = opts.idleMs ?? 120_000;
  }

  ready(env: VoiceEnv): boolean {
    return this.isReady(env);
  }

  private worker(env: VoiceEnv): Worker {
    let w = this.workers.get(env);
    if (!w || w.exited) {
      if (!this.ready(env))
        throw new VoiceEngineError(
          'not_installed',
          'The voice engine isn’t installed on this computer yet.',
          `Run \`hildegard voice install\` (environment: ${env}).`,
        );
      w = new Worker(this.python(env), this.engineDir, this.env, () => {
        if (this.workers.get(env) === w) this.workers.delete(env);
      });
      this.workers.set(env, w);
    }
    return w;
  }

  async call<T>(env: VoiceEnv, op: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<T> {
    if (opts.signal?.aborted) throw new VoiceEngineError('canceled', 'Canceled.');
    // One model family on the GPU at a time.
    if (HEAVY.has(op))
      await Promise.all(
        [...this.workers].filter(([e, w]) => e !== env && w.loaded).map(([, w]) => w.call('release', {})),
      );
    const w = this.worker(env);
    // A request stops only by ending its worker; the next call starts a fresh one.
    const onAbort = () => w.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return (await w.call(op, args, opts)) as T;
    } catch (e) {
      if (opts.signal?.aborted) throw new VoiceEngineError('canceled', 'Canceled.');
      throw e;
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      this.armIdle();
    }
  }

  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.idle(), this.idleMs);
    this.idleTimer.unref();
  }

  private async idle() {
    const now = Date.now();
    for (const [env, w] of this.workers) {
      if (now - w.lastUsed >= this.idleMs * 10) {
        this.workers.delete(env);
        await w.end();
      } else if (w.loaded && now - w.lastUsed >= this.idleMs) await w.call('release', {}).catch(() => {});
    }
    if (this.workers.size) this.armIdle();
  }

  async release(): Promise<void> {
    await Promise.all(
      [...this.workers.values()].filter((w) => w.loaded).map((w) => w.call('release', {}).catch(() => {})),
    );
  }

  async close(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const all = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(all.map((w) => w.end()));
  }
}

// ── The stand-in ───────────────────────────────────────────────────────────────────────────────────────────────

/** A mono 16-bit WAV. */
export function wavBytes(samples: Float32Array, sr: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return b;
}

/** A WAV's length in seconds, from its header; null for anything else. */
export function wavSeconds(b: Uint8Array): number | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE')
    return null;
  let at = 12;
  let rate = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') rate = buf.readUInt32LE(at + 16);
    if (id === 'data') return rate ? Math.min(size, buf.length - at - 8) / rate : null;
    at += 8 + size + (size % 2);
  }
  return null;
}

const SR = 24000;
const hash = (s: string) => createHash('sha256').update(s).digest();
const readSide = (path: string, ext: string) => {
  try {
    return readFileSync(`${path}${ext}`, 'utf8').trim();
  } catch {
    return null;
  }
};
const copySide = (from: string, to: string) => {
  for (const ext of ['.txt', '.speaker', '.marked'])
    if (existsSync(from + ext)) copyFileSync(from + ext, to + ext);
};

/**
 * The voice engine without Python or a GPU: a hum per voice, as long as the words would take to say. Tests steer it
 * with files next to a recording: `<file>.txt` is what it "hears", `<file>.speaker` whose voice it is, and
 * `<file>.marked` that it carries Hildegard's watermark. Everything it speaks carries the watermark. A script with
 * `[[fail:oom]` or `[[fail:engine]` (a literal bracket, since tags are never spoken) fails the way a real one would.
 */
export class FakeVoiceEngine implements VoiceEngine {
  readonly fake = true;
  /** Every op it ran, for tests. */
  readonly calls: Array<{ env: VoiceEnv; op: string; args: Record<string, unknown> }> = [];
  released = 0;
  private readonly made = new Set<string>();
  /** Milliseconds each segment takes, so tests can watch a job run. */
  delayMs: number;

  constructor(opts: { delayMs?: number } = {}) {
    this.delayMs = opts.delayMs ?? 0;
  }

  ready(): boolean {
    return true;
  }

  async release(): Promise<void> {
    this.released++;
  }

  async close(): Promise<void> {}

  private hum(text: string, key: string, speed = 1, seed = 0): Float32Array {
    const words = Math.max(1, text.split(/\s+/).filter(Boolean).length);
    const seconds = Math.max(0.4, words / (2.6 * speed));
    const f0 = 110 + (hash(key).readUInt16BE(0) % 140);
    const out = new Float32Array(Math.round(seconds * SR));
    let phase = 0;
    let rng = (seed * 2654435761) >>> 0 || 1;
    for (let i = 0; i < out.length; i++) {
      const t = i / SR;
      phase += (2 * Math.PI * f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 0.7 * t))) / SR;
      const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t - Math.PI / 2);
      rng = (rng * 1664525 + 1013904223) >>> 0;
      out[i] =
        0.25 * env * (Math.sin(phase) + Math.sin(2 * phase) / 2 + Math.sin(3 * phase) / 3) +
        0.003 * (rng / 2 ** 32 - 0.5);
    }
    return out;
  }

  private write(path: string, samples: Float32Array) {
    writeFileSync(path, wavBytes(samples, SR));
    this.made.add(path);
  }

  async call<T>(env: VoiceEnv, op: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<T> {
    this.calls.push({ env, op, args });
    const wait = () => new Promise((r) => setTimeout(r, this.delayMs));
    const stop = () => {
      if (opts.signal?.aborted) throw new VoiceEngineError('canceled', 'Canceled.');
    };
    stop();
    const s = (k: string) => String(args[k] ?? '');
    switch (op) {
      case 'speak': {
        const segs = args.segments as Array<{ text: string; pause?: number }>;
        const voice = (args.voice ?? {}) as Record<string, string>;
        const key = voice.name ?? voice.ref ?? voice.description ?? 'default';
        const settings = (args.settings ?? {}) as { speed?: number };
        const parts: Float32Array[] = [];
        const marks: Array<{ start: number; end: number }> = [];
        let at = 0;
        for (const [i, seg] of segs.entries()) {
          if (seg.text.includes('[fail:oom]'))
            throw new VoiceEngineError('out_of_memory', 'Your GPU ran out of memory.');
          if (seg.text.includes('[fail:engine]'))
            throw new VoiceEngineError('engine_failed', 'The voice engine stopped with an error.');
          if (this.delayMs) await wait();
          stop();
          const w = this.hum(seg.text, key, settings.speed ?? 1, Number(args.seed ?? 0) + i);
          parts.push(w);
          marks.push({
            start: Math.round(at * 1000) / 1000,
            end: Math.round((at + w.length / SR) * 1000) / 1000,
          });
          at += w.length / SR;
          const pause = Math.min(10, seg.pause ?? 0);
          if (pause > 0) {
            parts.push(new Float32Array(Math.round(pause * SR)));
            at += pause;
          }
          opts.onProgress?.({ done: i + 1, total: segs.length });
        }
        const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
          all.set(p, o);
          o += p.length;
        }
        this.write(s('out'), all);
        return { path: s('out'), seconds: all.length / SR, sampleRate: SR, segments: marks, ms: 1 } as T;
      }
      case 'convert': {
        const secs = wavSeconds(readFileSync(s('source'))) ?? 2;
        const w = this.hum('x '.repeat(Math.max(1, Math.round(secs * 2.6))), s('ref'));
        this.write(s('out'), w);
        return { path: s('out'), seconds: w.length / SR, sampleRate: SR, ms: 1 } as T;
      }
      case 'decode': {
        const bytes = readFileSync(s('path'));
        const secs = wavSeconds(bytes);
        if (secs === null && bytes.length < 64)
          throw new VoiceEngineError('audio_unreadable', 'That recording couldn’t be read.');
        if (secs !== null) copyFileSync(s('path'), s('out'));
        else
          writeFileSync(
            s('out'),
            wavBytes(this.hum('one two three four five six seven eight', 'upload'), SR),
          );
        copySide(s('path'), s('out'));
        const seconds = wavSeconds(readFileSync(s('out'))) ?? 0;
        return { path: s('out'), sampleRate: SR, ...this.analysis(seconds) } as T;
      }
      case 'analyze': {
        const seconds = wavSeconds(readFileSync(s('path'))) ?? 0;
        return this.analysis(seconds) as T;
      }
      case 'transcribe': {
        const path = s('path');
        const heard = readSide(path, '.txt') ?? (typeof args.expect === 'string' ? args.expect : '');
        const seconds = wavSeconds(readFileSync(path)) ?? 1;
        const words = heard.split(/\s+/).filter(Boolean);
        const step = seconds / Math.max(1, words.length);
        return {
          language: (args.language as string) || 'en',
          seconds,
          segments: words.length
            ? [
                {
                  start: 0,
                  end: seconds,
                  text: heard,
                  words: words.map((w, i) => ({ start: i * step, end: (i + 1) * step, word: w, p: 0.99 })),
                },
              ]
            : [],
        } as T;
      }
      case 'embed': {
        const paths = args.paths as string[];
        return {
          embeddings: paths.map((p) => {
            const who = readSide(p, '.speaker') ?? 'you';
            const v = Array.from({ length: 64 }, (_, i) => hash(`${who}:${i}`).readInt16BE(0) / 32768);
            const n = Math.hypot(...v);
            return v.map((x) => x / n);
          }),
        } as T;
      }
      case 'mark': {
        const p = s('path');
        const marked = this.made.has(p) || readSide(p, '.marked') !== null;
        return { score: marked ? 0.97 : 0.02, seconds: wavSeconds(readFileSync(p)) ?? 0 } as T;
      }
      case 'dub': {
        const lines = args.lines as Array<{ start: number; seconds: number }>;
        const end = Math.max(1, ...lines.map((l) => l.start + l.seconds));
        const w = this.hum('dub '.repeat(Math.round(end * 2.6)), 'dub');
        this.write(s('out'), w);
        return { path: s('out'), seconds: w.length / SR, sampleRate: SR } as T;
      }
      case 'hello':
        return { version: 'fake', device: 'cpu', watermark: true } as T;
      default:
        throw new VoiceEngineError('bad_request', `Unknown op ${op}.`);
    }
  }

  private analysis(seconds: number) {
    return { seconds, peakDb: -3, rmsDb: -20, noiseDb: -60, snrDb: 40, clipping: 0, speech: seconds * 0.9 };
  }
}
