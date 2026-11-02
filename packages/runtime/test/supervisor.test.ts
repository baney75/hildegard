// SPDX-License-Identifier: AGPL-3.0-only
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ComfyRuntime, layout, pidFile, reapStale } from '../src/index.ts';

// A stand-in ComfyUI: this folder's "python" is a shell script that never ends, so its command line names the
// folder's Python just as the real ComfyUI's does.
function fakeInstall(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hildegard-supervisor-'));
  const L = layout(dir);
  mkdirSync(join(L.venv, 'bin'), { recursive: true });
  mkdirSync(L.comfyDir, { recursive: true });
  writeFileSync(L.python, '#!/bin/sh\nwhile :; do sleep 1; done\n');
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

  it('stops what an earlier run in this folder left behind, and nothing else', async () => {
    const dir = fakeInstall();
    const L = layout(dir);
    const leftover = spawn(L.python, ['main.py'], { stdio: 'ignore' });
    const stranger = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' });
    started.push(leftover, stranger);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(pidFile(dir), JSON.stringify([leftover.pid, stranger.pid, process.pid, 1]));

    expect(reapStale(dir)).toEqual([leftover.pid]);
    expect(await gone(leftover.pid!)).toBe(true);
    expect(alive(stranger.pid!)).toBe(true);
    expect(existsSync(pidFile(dir))).toBe(false);
  });

  it('reaps leftovers when it starts, notes its own processes, and forgets them when it stops', async () => {
    const dir = fakeInstall();
    const leftover = spawn(layout(dir).python, ['main.py'], { stdio: 'ignore' });
    started.push(leftover);
    await new Promise((r) => setTimeout(r, 200));
    writeFileSync(pidFile(dir), JSON.stringify([leftover.pid]));

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
});
