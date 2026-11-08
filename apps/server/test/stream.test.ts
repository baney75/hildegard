// SPDX-License-Identifier: AGPL-3.0-only
// Go live against a real FFmpeg. A local RTMP server (FFmpeg listening) takes a ten second stream made from a pattern
// and a tone, since CI has no camera, and the file it receives is measured: bit rate, keyframes, sound against
// picture, dropped frames. A second stream goes to two servers with one dead. The stream key is looked for in the
// command line, the environment, every answer, every log and every file. Stop is timed.
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net, { createServer } from 'node:net';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { type Running, startServer } from '../src/server.ts';
import { findFont, Streamer, type StreamerDeps } from '../src/stream.ts';
import { buildPlan } from '../src/stream-plan.ts';
import { memoryStore } from './helpers.ts';

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return execFileSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' }).includes(
      'streamselect',
    );
  } catch {
    return false;
  }
})();
const FFMPEG = describe.skipIf(!hasFfmpeg);

const work = mkdtempSync(join(tmpdir(), 'hg-stream-'));
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
async function until(fn: () => boolean | Promise<boolean>, ms = 30_000, what = 'a condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stream key as a service would hand one out, unique to this run. */
const makeKey = () => `live_${Math.floor(Math.random() * 1e9)}_${Math.random().toString(36).slice(2)}Qz9`;

/** A local RTMP server: FFmpeg listening for one publisher, writing what it gets to a file. */
function receiver(
  port: number,
  out: string,
): { child: ChildProcess; log: () => string; done: Promise<void> } {
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-listen',
      '1',
      '-i',
      `rtmp://127.0.0.1:${port}/live/x`,
      '-c',
      'copy',
      '-f',
      'matroska',
      '-y',
      out,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let log = '';
  child.stderr?.on('data', (d: Buffer) => {
    log += d.toString();
  });
  const done = new Promise<void>((r) => child.once('exit', () => r()));
  return { child, log: () => log, done };
}

/**
 * The service. FFmpeg's own listener takes any stream name, so this stands in front of it as a service that checks the
 * key: it writes down every byte it is sent, and hangs up on a publish that doesn't carry the key it expects.
 */
function gate(port: number, upstream: number, key: string) {
  const seen: Buffer[] = [];
  const server = createServer((c) => {
    const up = net.connect({ host: '127.0.0.1', port: upstream });
    let acc: Buffer = Buffer.alloc(0);
    let refused = false;
    c.on('data', (d) => {
      seen.push(d);
      acc = Buffer.concat([acc, d]);
      if (!refused && acc.includes('publish') && !acc.includes(key)) {
        refused = true;
        c.destroy();
        up.destroy();
        return;
      }
      up.write(d);
    });
    up.on('data', (d) => c.write(d));
    for (const x of [c, up]) x.on('error', () => {});
    c.on('close', () => up.destroy());
    up.on('close', () => c.destroy());
  }).listen(port, '127.0.0.1');
  return {
    sent: () => Buffer.concat(seen),
    close: () => server.close(),
  };
}

/** A service with a key to check and a receiver behind it. */
async function ingest(key: string, out: string) {
  const behind = await freePort();
  const r = receiver(behind, out);
  const port = await freePort();
  const g = gate(port, behind, key);
  await sleep(900);
  return { port, r, g };
}

interface Pkt {
  type: 'video' | 'audio';
  pts: number;
  size: number;
  key: boolean;
}
function packets(file: string): Pkt[] {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time,size,flags', '-of', 'csv=p=0', file],
    { encoding: 'utf8' },
  );
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [type, pts, size, flags] = l.split(',');
      return {
        type: type as Pkt['type'],
        pts: Number(pts),
        size: Number(size),
        key: (flags ?? '').startsWith('K'),
      };
    })
    .filter((p) => Number.isFinite(p.pts));
}

/** Every process on this computer whose command line carries our marker: ours, never the receiver's. */
function ourFfmpeg(): { pid: number; args: string }[] {
  const out = execFileSync('ps', ['-ww', '-eo', 'pid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && m[2]!.includes('comment=hildegard-stream'))
    .map((m) => ({ pid: Number(m[1]), args: m[2]! }));
}

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const logged: string[] = [];
beforeAll(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
});

function streamer(extra: Partial<StreamerDeps> = {}) {
  const dir = mkdtempSync(join(work, 'data-'));
  const keys = new Map<string, string>();
  const changes: string[] = [];
  const s = new Streamer({
    dataDir: dir,
    secrets: (a) => ({
      kind: 'keychain',
      get: () => keys.get(a) ?? null,
      set: (v) => void keys.set(a, v),
      delete: () => void keys.delete(a),
    }),
    onChange: (st) => changes.push(JSON.stringify(st)),
    // A software encoder and no probing: these tests never touch a video card.
    encoders: async () => ['libx264'],
    countdownSeconds: 0,
    kbps: 2500,
    ...extra,
  });
  return { s, dir, keys, changes };
}

const TEST_SOURCES = { screen: 'test', camera: 'test', mic: 'test' };

FFMPEG('the graph', () => {
  const dir = mkdtempSync(join(work, 'graph-'));
  const text = join(dir, 'text');
  mkdirSync(text);
  for (const [f, t] of [
    ['name', 'Ada Lovelace'],
    ['title', 'Analyst'],
    ['caption', 'Hello'],
    ['st', 'Starting soon'],
    ['brb', 'Be right back'],
  ])
    writeFileSync(join(text, `${f}.txt`), t ?? '');

  for (const scene of ['screen', 'camera', 'pip', 'starting', 'brb'] as const) {
    it(`renders the ${scene} scene, with a lower third, a caption and a logo, and switches to every other`, async () => {
      // A logo to overlay.
      const logo = join(dir, 'logo.png');
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x64',
        '-frames:v',
        '1',
        logo,
      ]);
      const { StreamSettings } = await import('@hildegard/presets');
      const settings = StreamSettings.parse({
        quality: '720p30',
        scene,
        sources: TEST_SOURCES,
        lowerThird: { on: true, name: 'Ada', title: 'Host' },
        caption: { on: true, text: 'Hello' },
        logo,
        record: true,
      });
      const file = join(dir, `${scene}.mkv`);
      const plan = buildPlan({
        settings,
        platform: process.platform,
        encoder: 'libx264',
        kbps: 1500,
        rtmp: [],
        recordFile: file,
        textDir: text,
        font: findFont(),
        progressPort: 9,
        preview: true,
      });
      // The progress port isn't listened on in this test; FFmpeg only warns.
      const args = plan.args.filter(
        (_, i, a) =>
          a[i - 1] !== '-progress' &&
          a[i] !== '-progress' &&
          a[i - 1] !== '-stats_period' &&
          a[i] !== '-stats_period',
      );
      const p = spawn('ffmpeg', ['-y', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d: Buffer) => {
        err += d.toString();
      });
      let jpegs = 0;
      p.stdout.on('data', (d: Buffer) => {
        if (d.includes(Buffer.from([0xff, 0xd8]))) jpegs++;
      });
      await sleep(1200);
      for (let i = 0; i < plan.scenes.length; i++) {
        p.stdin.write(`cstreamselect@scene -1 map ${i}\n`);
        await sleep(150);
      }
      p.stdin.write('cvolume@mic -1 volume 0\n');
      p.stdin.write('cdrawbox@ltbox -1 enable 0\n');
      p.stdin.write('q');
      await new Promise<void>((r) => p.once('exit', () => r()));
      expect(err, err).not.toMatch(
        /Parse error|No such filter|Error initializing|Error reinitializing|Invalid argument|Cannot find|Option not found/i,
      );
      expect((err.match(/Command reply for stream 0: ret:0/g) ?? []).length).toBeGreaterThanOrEqual(
        plan.scenes.length,
      );
      expect(jpegs).toBeGreaterThan(0);
      const v = execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-select_streams',
          'v',
          '-show_entries',
          'stream=codec_name,width,height',
          '-of',
          'csv=p=0',
          file,
        ],
        { encoding: 'utf8' },
      ).trim();
      expect(v).toBe('h264,1280,720');
    }, 30_000);
  }
});

FFMPEG('a ten second stream to a local RTMP server', () => {
  const KEY = makeKey();
  let r: ReturnType<typeof receiver>;
  let g: ReturnType<typeof gate>;
  let port: number;
  const out = join(work, 'received.mkv');
  const checks: Record<string, unknown> = {};
  const { s, dir, changes } = streamer();
  let argv = '';
  let environ = '';
  let pidSeen = 0;
  let stopMs = 0;
  let dropped = 0;
  let sawFrame = false;

  beforeAll(async () => {
    ({ port, r, g } = await ingest(KEY, out));
    await s.update({
      quality: '720p30',
      scene: 'screen',
      sources: TEST_SOURCES,
      destinations: { custom: { enabled: true, server: `rtmp://127.0.0.1:${port}/live` } },
      lowerThird: { on: true, name: 'Ada Lovelace', title: 'Analyst' },
      record: true,
    });
    s.setKey('custom', KEY);
    await s.goLive();
    await until(
      () => s.state().destinations.find((d) => d.id === 'custom')?.state === 'live',
      20_000,
      'the server to take the stream',
    );
    const started = Date.now();
    // Look at the process while it streams.
    await sleep(2000);
    const mine = ourFfmpeg();
    argv = mine.map((m) => m.args).join('\n');
    pidSeen = s.pid() ?? 0;
    if (process.platform === 'linux' && pidSeen) {
      environ = readFileSync(`/proc/${pidSeen}/environ`, 'utf8');
      checks.cmdline = readFileSync(`/proc/${pidSeen}/cmdline`, 'utf8');
    }
    // Change the scene, the lower third and the microphone while live.
    await sleep(1500);
    await s.update({ scene: 'camera' });
    await sleep(1500);
    await s.update({ scene: 'pip', mute: true });
    await s.update({ lowerThird: { on: false, name: 'Ada', title: 'x' } });
    sawFrame = !!s.latestFrame() && s.latestFrame()![0] === 0xff && s.latestFrame()![1] === 0xd8;
    await sleep(Math.max(0, 10_500 - (Date.now() - started)));
    dropped = s.state().stats.dropped;
    checks.stats = s.state().stats;
    checks.state = s.state();
    const t0 = Date.now();
    await s.stop();
    stopMs = Date.now() - t0;
    await Promise.race([r.done, sleep(8000)]);
  }, 90_000);
  afterAll(async () => {
    await s.dispose();
    r?.child.kill('SIGKILL');
    g?.close();
  });

  it('is accepted by a server that checks the stream key, though FFmpeg was never given it', () => {
    expect(r.log()).not.toMatch(/rejected|Cannot|failed/i);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(50_000);
    expect(packets(out).filter((p) => p.type === 'video').length).toBeGreaterThan(200);
  });

  it('runs at the bit rate asked for, within 15 percent', () => {
    const video = packets(out).filter((p) => p.type === 'video');
    const span = video.at(-1)!.pts - video[0]!.pts;
    expect(span).toBeGreaterThan(8);
    const kbps = (video.reduce((n, p) => n + p.size, 0) * 8) / span / 1000;
    expect(Math.abs(kbps / 2500 - 1), `measured ${Math.round(kbps)} kbps`).toBeLessThan(0.15);
  });

  it('puts a keyframe every two seconds', () => {
    const keys = packets(out).filter((p) => p.type === 'video' && p.key);
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < keys.length; i++)
      expect(keys[i]!.pts - keys[i - 1]!.pts, `gap ${i}`).toBeCloseTo(2, 1);
  });

  it('keeps sound and picture within 100 ms of each other from start to end', () => {
    const p = packets(out);
    const v = p.filter((x) => x.type === 'video');
    const a = p.filter((x) => x.type === 'audio');
    const start = v[0]!.pts - a[0]!.pts;
    const end = v.at(-1)!.pts - a.at(-1)!.pts;
    expect(Math.abs(end - start), `start ${start.toFixed(3)}, end ${end.toFixed(3)}`).toBeLessThan(0.1);
    expect(Math.abs(start)).toBeLessThan(0.25);
  });

  it('drops no frames on a quiet computer', () => {
    const quiet = loadavg()[0]! / cpus().length < 0.6;
    if (quiet) expect(dropped).toBe(0);
    else expect(dropped, 'the computer is busy, so only a runaway count fails').toBeLessThan(150);
  });

  it('reports bit rate, frame rate, the encoder’s share of a core and how long it has been live', () => {
    const st = checks.state as ReturnType<Streamer['state']>;
    expect(st.phase).toBe('live');
    expect(st.seconds).toBeGreaterThanOrEqual(8);
    expect(st.stats.kbps).toBeGreaterThan(300);
    expect(st.stats.fps).toBeGreaterThan(5);
    expect(st.stats.cpu).not.toBeNull();
    expect(st.encoder).toBe('Software (x264)');
    expect(st.recording).toBe(true);
    expect(sawFrame, 'a JPEG preview picture came out of the same graph').toBe(true);
  });

  it('shows the key nowhere on this computer: not in a command line, an environment, a log, a state or a file', () => {
    expect(argv).toContain('comment=hildegard-stream');
    expect(argv).not.toContain(KEY);
    const stand = new RegExp(`rtmp://127\\.0\\.0\\.1:\\d+/live/([A-Za-z0-9]{${KEY.length}})(\\||\\s)`).exec(
      argv,
    )?.[1];
    expect(stand, 'FFmpeg publishes under a stand-in as long as the key').toBeTruthy();
    // The service got the key and never saw the stand-in.
    expect(g.sent().includes(Buffer.from(KEY))).toBe(true);
    expect(g.sent().includes(Buffer.from(stand!))).toBe(false);
    // Not even a piece of it: the stand-in is random.
    for (let i = 0; i + 12 <= KEY.length; i += 6) expect(argv).not.toContain(KEY.slice(i, i + 12));
    expect(environ).not.toContain(KEY);
    expect(String(checks.cmdline)).not.toContain(KEY);
    expect(changes.join('\n')).not.toContain(KEY);
    expect(JSON.stringify(s.state())).not.toContain(KEY);
    expect(s.log().join('\n')).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(KEY);
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p, acc);
        else acc.push(p);
      }
      return acc;
    };
    for (const f of walk(dir)) {
      if (f.endsWith('.mkv')) continue;
      expect(readFileSync(f, 'utf8'), f).not.toContain(KEY);
    }
    // The recording on this computer holds the picture and sound, not the key.
    const rec = walk(join(dir, 'stream', 'recordings'))[0]!;
    expect(statSync(rec).size).toBeGreaterThan(50_000);
    expect(readFileSync(rec).includes(Buffer.from(KEY))).toBe(false);
  });

  it('stops within two seconds and leaves no process behind', () => {
    expect(stopMs).toBeLessThan(2000);
    expect(s.state().phase).toBe('idle');
    expect(pidSeen).toBeGreaterThan(0);
    expect(gone(pidSeen)).toBe(true);
    expect(ourFfmpeg()).toEqual([]);
  });
});

FFMPEG('a stream to two servers, one of them dead', () => {
  const KEY = makeKey();
  const DEAD = makeKey();
  it('goes on to the one that is up, and says which one failed and why', async () => {
    const dead = await freePort();
    const out = join(work, 'two.mkv');
    const { port: live, r, g } = await ingest(KEY, out);
    const { s } = streamer({ backoff: [60_000] });
    await s.update({
      quality: '720p30',
      sources: TEST_SOURCES,
      scene: 'camera',
      destinations: {
        custom: { enabled: true, server: `rtmp://127.0.0.1:${live}/live` },
        kick: { enabled: true, server: `rtmp://127.0.0.1:${dead}/app` },
      },
    });
    s.setKey('custom', KEY);
    s.setKey('kick', DEAD);
    try {
      await s.goLive();
      await until(
        () => s.state().destinations.find((d) => d.id === 'kick')?.state === 'failed',
        20_000,
        'the dead one to fail',
      );
      const kick = s.state().destinations.find((d) => d.id === 'kick')!;
      expect(kick.detail).toMatch(/refused|reach|dropped|closed/i);
      await sleep(4500);
      // Still live to the other, and not restarting.
      expect(s.state().phase).toBe('live');
      expect(s.state().destinations.find((d) => d.id === 'custom')?.state).toBe('live');
      expect(s.state().attempt).toBe(0);
    } finally {
      await s.stop();
    }
    await Promise.race([r.done, sleep(8000)]);
    g.close();
    const video = packets(out).filter((p) => p.type === 'video');
    expect(video.length).toBeGreaterThan(60);
    expect(video.at(-1)!.pts - video[0]!.pts).toBeGreaterThan(2.5);
    expect(g.sent().includes(Buffer.from(KEY))).toBe(true);
    // The dead one’s key went nowhere: not to the live one.
    expect(g.sent().includes(Buffer.from(DEAD))).toBe(false);
  }, 60_000);

  it('is hung up on by a service that doesn’t know its key, and tries again later', async () => {
    const { port, r, g } = await ingest(KEY, join(work, 'wrong.mkv'));
    const { s } = streamer({ backoff: [60_000] });
    await s.update({
      quality: '720p30',
      sources: TEST_SOURCES,
      scene: 'screen',
      destinations: { custom: { enabled: true, server: `rtmp://127.0.0.1:${port}/live` } },
    });
    s.setKey('custom', DEAD);
    try {
      await s.goLive();
      await until(() => s.state().phase === 'reconnecting', 25_000, 'the stream to be turned down');
      expect(s.state().message).toMatch(/Lost the connection/);
    } finally {
      await s.stop();
      r.child.kill('SIGKILL');
      g.close();
    }
    // The service heard the wrong key, once it hung up on it, and not the right one.
    expect(g.sent().includes(Buffer.from(DEAD))).toBe(true);
    expect(g.sent().includes(Buffer.from(KEY))).toBe(false);
    expect(s.state().phase).toBe('idle');
  }, 60_000);
});

describe('stopping, with FFmpeg replaced by something stubborn', () => {
  it('ends the whole process group inside two seconds, even one that ignores the polite request', async () => {
    // A shell that ignores SIGTERM and has a child of its own, as a hung capture driver might.
    const pidFile = join(work, 'stubborn.pids');
    const fakeSpawn = ((_cmd: string, _args: string[], opts: Record<string, unknown>) =>
      spawn(
        'sh',
        ['-c', `trap '' TERM INT; (trap '' TERM INT; sleep 60) & echo "$$ $!" > ${pidFile}; sleep 60; wait`],
        opts,
      )) as unknown as typeof spawn;
    const { s } = streamer({ spawn: fakeSpawn, watchdogMs: 600_000 });
    await s.update({ sources: TEST_SOURCES, destinations: { custom: { enabled: false } }, record: true });
    await s.goLive();
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().split(' ').length === 2,
      10_000,
      'the stand-in to start',
    );
    const [parent, child] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number) as [number, number];
    expect(gone(parent) || gone(child)).toBe(false);
    const t0 = Date.now();
    await s.stop();
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(2000);
    await sleep(100);
    expect(gone(parent)).toBe(true);
    expect(gone(child)).toBe(true);
    expect(s.state().phase).toBe('idle');
  }, 30_000);

  it('ends what FFmpeg started even when FFmpeg itself leaves at once', async () => {
    // FFmpeg (the shell) goes on the first SIGTERM; something it started ignores it and would outlive it.
    const pidFile = join(work, 'leaver.pids');
    const fakeSpawn = ((_cmd: string, _args: string[], opts: Record<string, unknown>) =>
      spawn(
        'sh',
        ['-c', `(trap '' TERM INT; sleep 60) & echo "$$ $!" > ${pidFile}; wait`],
        opts,
      )) as unknown as typeof spawn;
    const { s } = streamer({ spawn: fakeSpawn, watchdogMs: 600_000 });
    await s.update({ sources: TEST_SOURCES, destinations: { custom: { enabled: false } }, record: true });
    await s.goLive();
    await until(
      () => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().split(' ').length === 2,
      10_000,
      'the stand-in to start',
    );
    const [parent, child] = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number) as [number, number];
    expect(gone(child)).toBe(false);
    const t0 = Date.now();
    await s.stop();
    expect(Date.now() - t0).toBeLessThan(2500);
    await until(() => gone(parent) && gone(child), 1000, 'the whole group to go');
    expect(s.state().phase).toBe('idle');
  }, 30_000);

  for (const press of ['stop', 'cancel'] as const)
    it(`starts nothing when ${press === 'stop' ? 'Stop' : 'Cancel'} is pressed while the count’s end closes the preview`, async () => {
      // The preview's FFmpeg is slow to go, so begin() is still waiting on it when the press comes.
      const spawned: string[] = [];
      const fakeSpawn = ((_c: string, args: string[], opts: Record<string, unknown>) => {
        spawned.push(args.join(' '));
        return spawn('sh', ['-c', `trap '' TERM INT; sleep 60`], opts);
      }) as unknown as typeof spawn;
      const { s } = streamer({ spawn: fakeSpawn, watchdogMs: 600_000, countdownSeconds: 1 });
      try {
        await s.update({ sources: TEST_SOURCES, record: true });
        await s.startPreview();
        expect(s.state().phase).toBe('preview');
        await s.goLive();
        // The count is over and the preview is being closed.
        await until(
          () => s.state().phase === 'countdown' && s.state().countdown === null,
          5000,
          'the count to end',
        );
        await sleep(100);
        await (press === 'stop' ? s.stop() : s.cancelCountdown());
        await sleep(2500);
        expect(spawned).toHaveLength(1);
        expect(s.state().phase).toBe('idle');
      } finally {
        await s.stop();
      }
    }, 20_000);

  it('takes a preview restart and Go live in turn, so no FFmpeg is left running after Stop', async () => {
    const kids: ChildProcess[] = [];
    const fakeSpawn = ((_c: string, _a: string[], opts: Record<string, unknown>) => {
      const k = spawn('sleep', ['60'], opts);
      kids.push(k);
      return k;
    }) as unknown as typeof spawn;
    const { s } = streamer({ spawn: fakeSpawn, watchdogMs: 600_000 });
    await s.update({ sources: TEST_SOURCES, record: true });
    await s.startPreview();
    // A picture change restarts the preview; Go live comes before that restart is done.
    await Promise.all([s.update({ quality: '720p30' }), s.goLive()]);
    expect(s.state().phase).toBe('live');
    await s.stop();
    await sleep(200);
    expect(kids.length).toBe(3);
    expect(kids.filter((k) => !gone(k.pid!)).map((k) => k.pid)).toEqual([]);
  }, 20_000);

  it('answers Stop at once while a start is still in flight, and the start does not come back', async () => {
    let spawned = 0;
    const fakeSpawn = ((_c: string, _a: string[], opts: Record<string, unknown>) => {
      spawned++;
      return spawn('sleep', ['60'], opts);
    }) as unknown as typeof spawn;
    const { s } = streamer({
      spawn: fakeSpawn,
      watchdogMs: 600_000,
      encoders: async () => {
        await sleep(300);
        return ['libx264'];
      },
    });
    await s.update({ sources: TEST_SOURCES, record: true });
    const starting = s.goLive();
    await sleep(50);
    await s.stop();
    await starting.catch(() => {});
    await sleep(600);
    expect(s.state().phase).toBe('idle');
    expect(spawned).toBe(0);
  }, 20_000);

  it('starts nothing from a Go live that waited behind a preview when Stop was pressed', async () => {
    let spawned = 0;
    const fakeSpawn = ((_c: string, _a: string[], o: object) =>
      spawn('sleep', ['60'], o).once('spawn', () => spawned++)) as never;
    const slow = () => sleep(300).then(() => ['libx264' as const]);
    const { s } = streamer({ spawn: fakeSpawn, watchdogMs: 600_000, encoders: slow });
    await s.update({ sources: TEST_SOURCES, record: true });
    const waits = [s.startPreview().catch(() => {}), s.goLive().catch(() => {})];
    await sleep(50);
    await s.stop();
    await Promise.all(waits);
    await sleep(300);
    expect([spawned, s.state().phase]).toEqual([0, 'idle']);
  }, 20_000);

  it('starts over when the one service drops, though a copy is being kept', async () => {
    // The service hangs up at once; the fake FFmpeg dials the relay as the real one would.
    const svc = createServer((c) => c.destroy()).listen(0, '127.0.0.1');
    const fakeSpawn = ((_c: string, args: string[], o: object) => {
      const port = /rtmp:\/\/127\.0\.0\.1:(\d+)/.exec(args.join(' '))?.[1];
      net.connect(Number(port), '127.0.0.1').on('error', () => {});
      return spawn('sleep', ['60'], o);
    }) as never;
    const relayConnect = () => net.connect((svc.address() as net.AddressInfo).port, '127.0.0.1');
    const { s } = streamer({ spawn: fakeSpawn, watchdogMs: 600_000, backoff: [60_000], relayConnect });
    await s.update({ sources: TEST_SOURCES, record: true, destinations: { youtube: { enabled: true } } });
    s.setKey('youtube', makeKey());
    try {
      await s.goLive();
      await until(() => s.state().phase === 'reconnecting', 5000, 'a restart');
    } finally {
      await s.stop();
      svc.close();
    }
  }, 20_000);

  it('ends a stream whose FFmpeg has gone quiet, and tries again with waits between', async () => {
    let spawned = 0;
    const fakeSpawn = ((_c: string, _a: string[], opts: Record<string, unknown>) => {
      spawned++;
      return spawn('sleep', ['60'], opts);
    }) as unknown as typeof spawn;
    const { s } = streamer({ spawn: fakeSpawn, watchdogMs: 1200, backoff: [300, 600], maxAttempts: 3 });
    await s.update({ sources: TEST_SOURCES, record: true });
    await s.goLive();
    try {
      await until(() => s.state().phase === 'reconnecting', 15_000, 'the watchdog');
      expect(s.state().message).toMatch(/Trying again in/);
      await until(() => spawned >= 2, 15_000, 'the second try');
      await until(() => s.state().message?.startsWith('Couldn’t keep') ?? false, 30_000, 'giving up');
      expect(s.state().phase).toBe('idle');
      expect(spawned).toBe(4);
    } finally {
      await s.stop();
    }
  }, 60_000);

  it('cancels a countdown without starting anything', async () => {
    let spawned = 0;
    const fakeSpawn = (() => {
      spawned++;
      return spawn('sleep', ['60']);
    }) as unknown as typeof spawn;
    const { s } = streamer({ spawn: fakeSpawn, countdownSeconds: 5 });
    await s.update({ sources: TEST_SOURCES, record: true });
    await s.goLive();
    expect(s.state()).toMatchObject({ phase: 'countdown', countdown: 5 });
    await sleep(1100);
    expect(s.state().countdown).toBe(4);
    await s.cancelCountdown();
    expect(s.state()).toMatchObject({ phase: 'idle', countdown: null });
    await sleep(1200);
    expect(spawned).toBe(0);
  }, 20_000);
});

describe('the preflight', () => {
  const run =
    (code: number, out = '', err = '') =>
    async () => ({ code, out, err });
  const base = {
    encoders: async () => ['libx264' as const],
    font: '/f.ttf',
    devices: async () => ({
      platform: 'linux',
      screens: [
        { id: 'x11', label: 'Whole screen' },
        { id: 'test', label: 'Test pattern' },
      ],
      cameras: [{ id: 'test', label: 'Test pattern' }],
      mics: [{ id: 'test', label: 'Test pattern' }],
      notes: [],
    }),
  };

  it('says in plain words what is wrong, and passes when everything is there', async () => {
    const none = streamer({ ...base, run: run(1) });
    const r0 = await none.s.preflight();
    expect(r0.ok).toBe(false);
    expect(r0.checks[0]).toMatchObject({ id: 'ffmpeg', status: 'fail' });

    const good = streamer({
      ...base,
      run: run(0, 'ffmpeg version 8.0.1'),
      reach: async () => 42,
      speedTest: async () => 40,
      probeSource: async () => null,
    });
    await good.s.update({
      sources: TEST_SOURCES,
      scene: 'pip',
      destinations: { youtube: { enabled: true } },
    });
    const missing = await good.s.preflight();
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((c) => c.id === 'dest-youtube')).toMatchObject({
      status: 'fail',
      detail: 'No stream key yet.',
    });
    good.s.setKey('youtube', makeKey());
    const r = await good.s.preflight();
    expect(r.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.encoder).toBe('libx264');
    expect(r.uploadMbps).toBe(40);
  });

  it('fails a device that isn’t there or that the computer won’t open, and an upload that is too slow', async () => {
    const t = streamer({
      ...base,
      run: run(0, 'ffmpeg version 8.0.1'),
      reach: async (h) => (h.includes('youtube') ? 30 : null),
      speedTest: async () => 3,
      probeSource: async (k) =>
        k === 'screen' ? 'macOS didn’t let Hildegard use the camera, microphone or screen.' : null,
    });
    await t.s.update({
      scene: 'pip',
      sources: { screen: 'x11', camera: '/dev/video9', mic: 'test' },
      destinations: { youtube: { enabled: true }, twitch: { enabled: true } },
    });
    t.s.setKey('youtube', makeKey());
    t.s.setKey('twitch', makeKey());
    const r = await t.s.preflight();
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    expect(by.screen).toMatchObject({ status: 'fail' });
    expect(by.screen!.detail).toMatch(/didn’t let Hildegard/);
    expect(by.camera).toMatchObject({ status: 'fail' });
    expect(by.camera!.detail).toMatch(/isn’t here any more/);
    expect(by['dest-twitch']).toMatchObject({ status: 'fail' });
    expect(by['dest-youtube']).toMatchObject({ status: 'pass' });
    expect(by.upload).toMatchObject({ status: 'fail' });
    expect(by.upload!.detail).toMatch(/Lower the quality/);
    expect(r.ok).toBe(false);
  });
  it('passes a camera the preview has open without opening it a second time', async () => {
    const probed: string[] = [];
    const t = streamer({
      ...base,
      platform: 'linux',
      spawn: ((_c: string, _a: string[], o: object) => spawn('sleep', ['60'], o)) as never,
      run: run(0, 'ffmpeg version 8.0.1'),
      devices: async () => ({ ...(await base.devices()), cameras: [{ id: '/dev/video0', label: 'Webcam' }] }),
      probeSource: async (k) => (probed.push(k) ? 'Another app is using the camera or microphone.' : null),
    });
    await t.s.update({
      scene: 'camera',
      sources: { screen: null, camera: '/dev/video0', mic: null },
      record: true,
    });
    await t.s.startPreview();
    const r = await t.s.preflight().finally(() => t.s.stop());
    expect([r.checks.find((c) => c.id === 'camera')?.status, probed]).toEqual(['pass', []]);
  });
});

// ── Through the whole server ────────────────────────────────────────────────────────────────────────────────────

describe('through the server', () => {
  const dir = mkdtempSync(join(work, 'srv-'));
  const uiDir = join(dir, 'ui');
  const dataDir = join(dir, 'data');
  const secrets = new Map<string, string>();
  const KEY = makeKey();
  let srv: Running;
  const H = { 'x-hildegard': '1', 'content-type': 'application/json' };
  const api = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${srv.url}/api/stream${path}`, {
      method,
      headers: method === 'GET' ? {} : H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeAll(async () => {
    mkdirSync(uiDir, { recursive: true });
    writeFileSync(join(uiDir, 'index.html'), '<!doctype html><title>Studio</title>');
    const hostPort = await freePort();
    srv = await startServer(
      { ...parseArgs(['--fake-gpu', '--data', dataDir, '--ui', uiDir]), port: 0, hostPort },
      {
        fakeTickMs: 20,
        secrets: memoryStore(),
        exec: async () => ({ ok: false, out: 'Tailscale is stopped.' }),
        stream: {
          secrets: (a) => ({
            kind: 'keychain',
            get: () => secrets.get(a) ?? null,
            set: (v) => void secrets.set(a, v),
            delete: () => void secrets.delete(a),
          }),
          encoders: async () => ['libx264'],
          countdownSeconds: 0,
          kbps: 2500,
          font: null,
        },
      },
    );
  }, 30_000);
  afterAll(() => srv.close());

  it('keeps a key in the keychain and in no answer, from any route', async () => {
    const put = await api('/keys/custom', 'PUT', { key: KEY });
    expect(put.status).toBe(200);
    expect(secrets.get('stream-custom')).toBe(KEY);
    for (const path of ['', '/devices', '/log', '/obs'])
      expect(await (await api(path)).text(), path).not.toContain(KEY);
    const settings = await api('/settings', 'PUT', {
      quality: '720p30',
      destinations: { custom: { enabled: true, server: 'rtmp://127.0.0.1:1/live' } },
    });
    expect(await settings.text()).not.toContain(KEY);
    // Nothing the server wrote to its data folder holds it.
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    for (const f of walk(dataDir)) expect(readFileSync(f, 'utf8'), f).not.toContain(KEY);
    expect(logged.join('\n')).not.toContain(KEY);
  });

  it('gives an AI app stream_status, and needs-owner for starting and stopping, with nothing started', async () => {
    const c = new Client({ name: 'test-chatbot', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${srv.url}/mcp`)));
    try {
      const text = (r: CallToolResult) => r.content.map((x) => (x as { text: string }).text).join('\n');
      const status = (await c.callTool({ name: 'stream_status', arguments: {} })) as CallToolResult;
      expect(status.isError).toBeFalsy();
      expect(text(status)).toMatch(/Not live/);
      expect(text(status)).toMatch(/Custom RTMP \(/);
      expect(text(status)).not.toContain(KEY);
      expect(text(status)).not.toContain('rtmp://');
      const start = (await c.callTool({ name: 'stream_start', arguments: {} })) as CallToolResult;
      expect(text(start)).toContain('needs-owner');
      expect(text(start)).toMatch(/Go live/);
      expect(text(start)).not.toContain(KEY);
      const stop = (await c.callTool({ name: 'stream_stop', arguments: {} })) as CallToolResult;
      expect(text(stop)).toContain('needs-owner');
      const tools = (await c.listTools()).tools.map((t) => t.name);
      expect(tools.filter((n) => n.startsWith('stream'))).toEqual([
        'stream_status',
        'stream_start',
        'stream_stop',
      ]);
      // No tool takes or returns a key.
      for (const t of (await c.listTools()).tools.filter((x) => x.name.startsWith('stream')))
        expect(JSON.stringify(t.inputSchema)).not.toMatch(/key|password|token/i);
      // The state of the stream is unchanged by all of it.
      expect(((await (await api('')).json()) as { phase: string }).phase).toBe('idle');
      expect(logged.join('\n')).not.toContain(KEY);
    } finally {
      await c.close();
    }
  });

  it('shows the person at this computer the preview picture, and a reason when there isn’t one', async () => {
    const none = await api('/preview.jpg');
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toMatch(/No picture yet/);
  });

  it('starts and stops a stream of the test pattern through the routes, recording it, and answers Stop from here', async () => {
    if (!hasFfmpeg) return;
    const rec = await api('/settings', 'PUT', {
      record: true,
      destinations: { custom: { enabled: false } },
      sources: TEST_SOURCES,
      scene: 'screen',
    });
    expect(rec.status).toBe(200);
    const go = await api('/go-live', 'POST', {});
    expect(go.status, await go.clone().text()).toBe(200);
    await until(
      async () => ((await (await api('')).json()) as { phase: string }).phase === 'live',
      15_000,
      'live',
    );
    await until(async () => (await api('/preview.jpg')).status === 200, 15_000, 'a picture');
    const pic = Buffer.from(await (await api('/preview.jpg')).arrayBuffer());
    expect(pic[0]).toBe(0xff);
    expect(pic[1]).toBe(0xd8);
    const cmds = ourFfmpeg();
    expect(cmds.length).toBe(1);
    const t0 = Date.now();
    const stop = await api('/stop', 'POST', {});
    expect(stop.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(((await stop.json()) as { phase: string }).phase).toBe('idle');
    expect(ourFfmpeg()).toEqual([]);
  }, 60_000);
});
