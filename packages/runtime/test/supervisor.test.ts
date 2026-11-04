// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComfyRuntime, layout, pidDir, pidFile, processStart, reapStale } from '../src/index.ts';

// A stand-in ComfyUI: this folder's "python" is a shell script that never ends, so its command line names the
// folder's Python just as the real ComfyUI's does.
const installs: string[] = [];
function fakeInstall(script = 'while :; do sleep 1; done'): string {
  const dir = mkdtempSync(join(tmpdir(), 'hildegard-supervisor-'));
  installs.push(dir);
  const L = layout(dir);
  mkdirSync(join(L.venv, 'bin'), { recursive: true });
  mkdirSync(L.comfyDir, { recursive: true });
  writeFileSync(L.python, `#!/bin/sh\n${script}\n`);
  chmodSync(L.python, 0o755);
  writeFileSync(
    L.manifest,
    JSON.stringify({
      comfyui: '0',
      backend: 'cpu',
      torchBackend: null,
      gpu: 'none',
      torch: '0',
      installedAt: '',
    }),
  );
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A killed process whose parent already exited is reaped by init a moment later.
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

const started: ChildProcess[] = [];
const forever = () => spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' });
/** A start time as an older Hildegard read it: in this shell's own locale and time zone (Linux: /proc, unchanged). */
const startedHere = (pid: number) =>
  process.platform === 'linux'
    ? processStart(pid)
    : spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
        encoding: 'utf8',
        env: process.env,
      }).stdout.trim();
/** A stand-in for another Hildegard: a Node process. */
const hildegard = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
/** Writes a note as `owner` would have: its start time (or one given) and its children's. */
const note = (
  dir: string,
  owner: number,
  pids: (number | undefined)[],
  ownerStarted = processStart(owner),
) => {
  mkdirSync(pidDir(dir), { recursive: true });
  const children = pids.map((pid) => ({ pid, started: pid ? processStart(pid) : null }));
  writeFileSync(pidFile(dir, owner), JSON.stringify({ started: ownerStarted, pids: children }));
};
/** Processes a test found by number only, with the start time they had then: killed after it, so a failed expect leaves none behind. */
const strays: { pid: number; started: string | null }[] = [];
const stray = (pids: number[]) => strays.push(...pids.map((pid) => ({ pid, started: processStart(pid) })));
afterEach(() => {
  for (const c of started.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  // Only the process that was noted: a number the OS has handed to something else since is not ours to kill.
  for (const { pid, started: at } of strays.splice(0))
    if (at && processStart(pid) === at)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
  // A test that died before it could note its processes (the crash script's timeout, say) leaves them by name only:
  // anything whose command line is in one of the fake installs. -ww: BSD ps cuts the command short without a terminal.
  if (process.platform !== 'win32' && installs.length) {
    const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '';
    for (const line of ps.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m || Number(m[1]) === process.pid || !installs.some((d) => m[2]!.includes(d))) continue;
      try {
        process.kill(Number(m[1]), 'SIGKILL');
      } catch {}
    }
  }
});

describe.skipIf(process.platform === 'win32')('ComfyRuntime processes', () => {
  it('takes ComfyUI and the proxy down when Hildegard’s process ends, even by a crash', async () => {
    const dir = fakeInstall();
    const script = join(dir, 'crash.mjs');
    const entry = resolve(import.meta.dirname, '../src/index.ts');
    writeFileSync(
      script,
      `import { ComfyRuntime } from ${JSON.stringify(entry)};
const r = new ComfyRuntime({ dataDir: process.argv[2] });
await r.start();
await new Promise((ok) => setTimeout(ok, 300));
console.log(JSON.stringify(r.pids()));
process.exit(1);
`,
    );
    const out = spawnSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 20_000 });
    const pids = JSON.parse(out.stdout.trim().split('\n').at(-1)!) as number[];
    stray(pids);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expect(await gone(pid)).toBe(true);
  });

  it('stops what a Hildegard that’s gone left behind, and nothing else', async () => {
    const dir = fakeInstall();
    const leftover = spawn(layout(dir).python, ['main.py'], { stdio: 'ignore' });
    const stranger = forever();
    const gonePid = 2 ** 22 + 7; // no process has this number
    started.push(leftover, stranger);
    await new Promise((r) => setTimeout(r, 200));
    note(dir, gonePid, [leftover.pid, stranger.pid, process.pid, 1]);

    expect(reapStale(dir)).toEqual([leftover.pid]);
    expect(await gone(leftover.pid!)).toBe(true);
    expect(alive(stranger.pid!)).toBe(true);
    expect(existsSync(pidFile(dir, gonePid))).toBe(false);
  });

  it('leaves a Hildegard that’s still running its ComfyUI', async () => {
    const dir = fakeInstall();
    const theirs = spawn(layout(dir).python, ['main.py'], { stdio: 'ignore' });
    const owner = hildegard();
    started.push(theirs, owner);
    await new Promise((r) => setTimeout(r, 200));
    note(dir, owner.pid!, [theirs.pid]);

    expect(reapStale(dir)).toEqual([]);
    expect(alive(theirs.pid!)).toBe(true);
    expect(existsSync(pidFile(dir, owner.pid!))).toBe(true);
  });

  it('takes a reused process number for what it is: not the Hildegard that wrote the note', async () => {
    const dir = fakeInstall();
    const leftover = spawn(layout(dir).python, ['main.py'], { stdio: 'ignore' });
    const reused = forever(); // a process started later now has the number the crashed Hildegard had
    started.push(leftover, reused);
    await new Promise((r) => setTimeout(r, 200));
    note(dir, reused.pid!, [leftover.pid], 'the start time of the Hildegard that crashed');

    expect(reapStale(dir)).toEqual([leftover.pid]);
    expect(alive(reused.pid!)).toBe(true);
  });

  it('leaves a process that took a noted child’s number since', async () => {
    const dir = fakeInstall();
    const newer = spawn(layout(dir).python, ['main.py'], { stdio: 'ignore' }); // same Python, a later process
    started.push(newer);
    await new Promise((r) => setTimeout(r, 200));
    mkdirSync(pidDir(dir), { recursive: true });
    writeFileSync(
      pidFile(dir, 2 ** 22 + 11),
      JSON.stringify({ started: 'gone', pids: [{ pid: newer.pid, started: 'an earlier process' }] }),
    );
    expect(reapStale(dir)).toEqual([]);
    expect(alive(newer.pid!)).toBe(true);
  });

  it('stops promptly when its Python can’t even start', async () => {
    const dir = fakeInstall();
    chmodSync(layout(dir).python, 0o644); // not executable: spawn fails, and no process ever exists
    const r = new ComfyRuntime({ dataDir: dir });
    await r.start();
    await new Promise((ok) => setTimeout(ok, 300));
    const t = Date.now();
    await r.stop();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it('reaps leftovers when it starts, notes its own processes, and forgets them when it stops', async () => {
    const dir = fakeInstall();
    const leftover = spawn(layout(dir).python, ['main.py'], { stdio: 'ignore' });
    started.push(leftover);
    await new Promise((r) => setTimeout(r, 200));
    note(dir, 2 ** 22 + 9, [leftover.pid]);

    const r = new ComfyRuntime({ dataDir: dir });
    await r.start();
    expect(await gone(leftover.pid!)).toBe(true);
    expect(existsSync(pidFile(dir))).toBe(true);
    const mine = r.pids();
    expect(mine).toHaveLength(2);
    await r.stop();
    expect(existsSync(pidFile(dir))).toBe(false);
    for (const pid of mine) expect(await gone(pid)).toBe(true);
  });

  it('starts even when it can’t note its processes', async () => {
    const dir = fakeInstall();
    writeFileSync(pidDir(dir), 'not a folder');
    const r = new ComfyRuntime({ dataDir: dir });
    await r.start();
    expect(r.pids()).toHaveLength(2);
    await r.stop();
  });

  it('pays no attention to a child of an earlier start ending late', async () => {
    // This ComfyUI shrugs off SIGTERM, so it outlives the restart that replaces it.
    const dir = fakeInstall('trap \'\' TERM; touch "$(dirname "$0")/ready-$$"; while :; do sleep 1; done');
    const r = new ComfyRuntime({ dataDir: dir });
    await r.start();
    const [comfy, proxy] = r.pids() as [number, number];
    // Until the shell has set its trap: it says so with a file.
    const ready = join(layout(dir).venv, 'bin', `ready-${comfy}`);
    for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((ok) => setTimeout(ok, 50));
    expect(existsSync(ready)).toBe(true);
    process.kill(proxy, 'SIGKILL');
    // The proxy's exit restarts both after a second's back-off, on the same ports.
    for (let i = 0; i < 60 && !(r.pids().length === 2 && !r.pids().includes(comfy)); i++)
      await new Promise((ok) => setTimeout(ok, 100));
    const fresh = r.pids();
    expect(fresh).toHaveLength(2);
    expect(alive(comfy)).toBe(true);
    // It shrugged off SIGTERM; SIGKILL follows five seconds after it, and the note keeps it until then.
    expect(JSON.parse(readFileSync(pidFile(dir), 'utf8')).pids.map((c: { pid: number }) => c.pid)).toContain(
      comfy,
    );
    for (let i = 0; i < 80 && alive(comfy); i++) await new Promise((ok) => setTimeout(ok, 100));
    expect(alive(comfy)).toBe(false);
    // Gone, it leaves the note, which names only the pair running now.
    await new Promise((ok) => setTimeout(ok, 100));
    const noted = JSON.parse(readFileSync(pidFile(dir), 'utf8')).pids.map((c: { pid: number }) => c.pid);
    expect(noted.sort()).toEqual([...r.pids()].sort());
    await new Promise((ok) => setTimeout(ok, 300));
    expect(r.pids()).toEqual(fresh);
    for (const pid of fresh) expect(alive(pid)).toBe(true);
    await r.stop(); // its SIGTERM-proof ComfyUI takes the five-second SIGKILL path
  }, 30_000);

  it('starts nothing when stopped while it looks for ports', async () => {
    const dir = fakeInstall();
    const r = new ComfyRuntime({ dataDir: dir });
    const starting = r.start();
    await r.stop();
    await starting;
    expect(r.pids()).toEqual([]);
    expect(existsSync(pidFile(dir))).toBe(false);
    expect(r.state.status).toBe('stopped');
  });

  it('reads the same start time whatever the reader’s locale and time zone', () => {
    const saved = { TZ: process.env.TZ, LANG: process.env.LANG, LC_ALL: process.env.LC_ALL };
    try {
      process.env.TZ = 'America/New_York';
      process.env.LANG = process.env.LC_ALL = 'C';
      const here = processStart(process.pid);
      expect(here).not.toBeNull(); // a reader that can't see start times would pass this test for nothing
      process.env.TZ = 'Asia/Tokyo';
      process.env.LANG = process.env.LC_ALL = 'de_DE.UTF-8';
      expect(processStart(process.pid)).toBe(here);
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  });

  it('still knows a live owner from a note written before start times were pinned', async () => {
    const dir = fakeInstall();
    const theirs = spawn(layout(dir).python, ['main.py'], { stdio: 'ignore' });
    const owner = hildegard();
    started.push(theirs, owner);
    await new Promise((r) => setTimeout(r, 200));
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'America/Chicago';
      // An older note: no version, times as its writer's own shell printed them.
      mkdirSync(pidDir(dir), { recursive: true });
      writeFileSync(
        pidFile(dir, owner.pid!),
        JSON.stringify({
          started: startedHere(owner.pid!),
          pids: [{ pid: theirs.pid, started: startedHere(theirs.pid!) }],
        }),
      );
      expect(reapStale(dir)).toEqual([]);
      expect(alive(theirs.pid!)).toBe(true);
      // Taken for alive, its note stays, so its ComfyUI can still be reaped if it crashes later.
      expect(existsSync(pidFile(dir, owner.pid!))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });
});
