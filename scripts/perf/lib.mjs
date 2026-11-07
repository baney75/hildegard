// SPDX-License-Identifier: AGPL-3.0-only
// Shared helpers for the performance bench: a throwaway server, timers, percentiles and bundle sizes.
import { spawn } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { brotliCompressSync, constants, deflateSync, gzipSync } from 'node:zlib';

export const ROOT = join(import.meta.dirname, '..', '..');
export const SERVER_MAIN = join(ROOT, 'apps/server/src/main.ts');
export const CLI_MAIN = join(ROOT, 'apps/cli/src/main.ts');
export const DIST = join(ROOT, 'apps/studio/dist');

/** A PATH without ~/.local/bin: its google-chrome starts the owner's own browser. */
export function safePath() {
  return (process.env.PATH ?? '')
    .split(':')
    .filter((p) => !p.includes('/.local/bin'))
    .join(':');
}

/** An environment that cannot touch the owner's Hildegard, keys, browser or config. */
export function isolatedEnv(home, extra = {}) {
  return {
    ...process.env,
    PATH: safePath(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    HILDEGARD_SECRETS: 'file',
    ...extra,
  };
}

const made = [];
process.on('exit', () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A throwaway folder with a home and a data folder, removed when the bench ends. */
export function scratch(prefix = 'hg-perf-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  return { dir, home, data: join(dir, 'data') };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const now = () => performance.now();

export function pct(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
export const median = (v) => pct(v, 50);
export const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Start `main.ts --fake-gpu` and resolve when /api/health first answers, with the time that took. */
export async function startServer({ port, data, home, ui = DIST, env = {}, args = [] }) {
  const t0 = now();
  const proc = spawn(
    process.execPath,
    [SERVER_MAIN, '--fake-gpu', '--port', String(port), '--data', data, '--ui', ui, ...args],
    { env: isolatedEnv(home, { HILDEGARD_FAKE_TICK_MS: '40', ...env }), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const exited = new Promise((r) => proc.once('exit', r));
  const url = `http://127.0.0.1:${port}`;
  let coldMs = null;
  for (let i = 0; i < 2000; i++) {
    if (proc.exitCode !== null) throw new Error(`Server exited early:\n${log}`);
    try {
      const r = await fetch(`${url}/api/health`);
      if (r.ok) {
        coldMs = now() - t0;
        break;
      }
    } catch {}
    await sleep(5);
  }
  if (coldMs === null) throw new Error(`Server did not answer in time:\n${log}`);
  return {
    url,
    proc,
    coldMs,
    rssMb: () => rssMb(proc.pid),
    async stop() {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(t);
    },
  };
}

/** Resident memory in MB, read from /proc where it exists and from ps elsewhere. */
export function rssMb(pid) {
  try {
    const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    if (m) return Number(m[1]) / 1024;
  } catch {}
  return null;
}

/** Wall time of a command in ms, with its exit code and output. */
export function timeCommand(cmd, args, { env, cwd, input, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const t0 = now();
    const p = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ ms: now() - t0, code, out, err });
    });
    p.stdin.end(input ?? '');
  });
}

/** Every file under dir, as paths relative to it with forward slashes. */
export function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : [relative(DIST, p).split(sep).join('/')];
  });
}

const sizeCache = new Map();
/** Raw, gzip and brotli bytes of a built file (the .br and .gz the build wrote, else compressed here). */
export function fileSizes(rel) {
  if (sizeCache.has(rel)) return sizeCache.get(rel);
  const file = join(DIST, rel);
  const raw = statSync(file).size;
  const size = (ext, make) => {
    try {
      return statSync(file + ext).size;
    } catch {
      return make(readFileSync(file)).length;
    }
  };
  const out = {
    raw,
    gzip: size('.gz', (b) => gzipSync(b, { level: 9 })),
    brotli: size('.br', (b) => brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })),
  };
  sizeCache.set(rel, out);
  return out;
}

export function sumSizes(rels) {
  const t = { files: rels.length, raw: 0, gzip: 0, brotli: 0 };
  for (const r of rels) {
    const s = fileSizes(r);
    t.raw += s.raw;
    t.gzip += s.gzip;
    t.brotli += s.brotli;
  }
  return t;
}

/** Seed a data folder with a large Queue and Images history, so lists of 500 render on first load. */
export function seedLargeState(data, { takes = 500, stills = 500 } = {}) {
  mkdirSync(data, { recursive: true });
  const day = new Date();
  const iso = (i) => new Date(day.getTime() - i * 1000).toISOString();
  const projectId = 'film-seed';
  const shots = [];
  const takeList = [];
  for (let i = 0; i < takes; i++) {
    const shotId = `shot-seed-${i}`;
    const id = `take-seed-${i}`;
    shots.push({
      id: shotId,
      projectId,
      title: `Seed shot ${i}`,
      prompt: `A slow dolly across a harbor at dawn, frame ${i}.`,
      createdAt: iso(i),
      takeIds: [id],
    });
    takeList.push({
      id,
      shotId,
      projectId,
      number: 1,
      status: 'done',
      priority: 'normal',
      source: { kind: 'studio' },
      request: {},
      seed: i,
      model: 'ltx-2.3-distilled',
      summary: 'seed',
      prompt: `A slow dolly across a harbor at dawn, frame ${i}.`,
      width: 768,
      height: 432,
      seconds: 3,
      fps: 24,
      quality: 'draft',
      queuePosition: null,
      progress: null,
      previewVersion: 0,
      createdAt: iso(i),
      startedAt: iso(i),
      finishedAt: iso(i),
      renderMs: 4000,
      error: null,
      kept: false,
      video: `/media/${id}.mp4`,
      poster: `/media/${id}.jpg`,
      bytes: 1000,
    });
  }
  const stillList = [];
  for (let i = 0; i < stills; i++) {
    stillList.push({
      id: `still-seed-${i}`,
      characterId: null,
      view: null,
      aspect: '16:9',
      quality: 'draft',
      summary: 'seed',
      status: 'done',
      priority: 'normal',
      source: { kind: 'studio' },
      seed: i,
      model: 'flux',
      prompt: `A lantern on a wet cobblestone street, image ${i}.`,
      references: [],
      width: 1024,
      height: 576,
      queuePosition: null,
      progress: null,
      previewVersion: 0,
      createdAt: iso(i),
      startedAt: iso(i),
      finishedAt: iso(i),
      renderMs: 2000,
      error: null,
      image: `/media/stills/still-seed-${i}.png`,
    });
  }
  const project = {
    id: projectId,
    title: 'Seed film',
    createdAt: iso(0),
    updatedAt: iso(0),
    shotIds: shots.map((s) => s.id),
  };
  writeFileSync(
    join(data, 'state.json'),
    JSON.stringify({
      version: 1,
      projects: [project],
      shots,
      takes: takeList,
      characters: [],
      stills: stillList,
    }),
  );
  // Small real images for the posters and stills, so the browser decodes them like it would real ones.
  const media = join(data, 'media');
  mkdirSync(join(media, 'stills'), { recursive: true });
  // One image, linked under every name, so a thousand posters cost one file's space.
  const first = join(media, 'take-seed-0.jpg');
  writeFileSync(first, gradientPng(320, 180));
  for (let i = 1; i < takes; i++) linkSync(first, join(media, `take-seed-${i}.jpg`));
  for (let i = 0; i < stills; i++) linkSync(first, join(media, 'stills', `still-seed-${i}.png`));
  return { media, takes, stills };
}

let crcTable;
function crc32(buf) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A small valid RGB PNG with a gradient, made without a library. */
function gradientPng(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = (x * 255) / w;
      raw[row + 2 + x * 3] = (y * 255) / h;
      raw[row + 3 + x * 3] = ((x ^ y) * 3) & 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
