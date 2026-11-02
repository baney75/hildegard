// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComfyRuntime, layout, pidDir, pidFile, reapStale } from '../src/index.ts';

// A stand-in ComfyUI: this folder's "python" is a shell script that never ends, so its command line names the
// folder's Python just as the real ComfyUI's does.
function fakeInstall(script = 'while :; do sleep 1; done'): string {
  const dir = mkdtempSync(join(tmpdir(), 'hildegard-supervisor-'));
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
const note = (dir: string, owner: number, pids: (number | undefined)[]) => {
  mkdirSync(pidDir(dir), { recursive: true });
  writeFileSync(pidFile(dir, owner), JSON.stringify(pids));
};
afterEach(() => {
  for (const c of started.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
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
    const owner = forever();
    started.push(theirs, owner);
    await new Promise((r) => setTimeout(r, 200));
    note(dir, owner.pid!, [theirs.pid]);

    expect(reapStale(dir)).toEqual([]);
    expect(alive(theirs.pid!)).toBe(true);
    expect(existsSync(pidFile(dir, owner.pid!))).toBe(true);
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
    const dir = fakeInstall("trap '' TERM; while :; do sleep 1; done");
    const r = new ComfyRuntime({ dataDir: dir });
    await r.start();
    const [comfy, proxy] = r.pids() as [number, number];
    await new Promise((ok) => setTimeout(ok, 300)); // until the shell has set its trap
    process.kill(proxy, 'SIGKILL');
    // The proxy's exit restarts both after a second's back-off, on the same ports.
    for (let i = 0; i < 60 && !(r.pids().length === 2 && !r.pids().includes(comfy)); i++)
      await new Promise((ok) => setTimeout(ok, 100));
    const fresh = r.pids();
    expect(fresh).toHaveLength(2);
    expect(alive(comfy)).toBe(true);
    process.kill(comfy, 'SIGKILL');
    expect(await gone(comfy)).toBe(true);
    await new Promise((ok) => setTimeout(ok, 300));
    expect(r.pids()).toEqual(fresh);
    for (const pid of fresh) expect(alive(pid)).toBe(true);
    await r.stop(); // its SIGTERM-proof ComfyUI takes the five-second SIGKILL path
  }, 20_000);
});
