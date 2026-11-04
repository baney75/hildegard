// SPDX-License-Identifier: AGPL-3.0-only
// What the supervisor tests share: a stand-in ComfyUI install, and the cleanup that leaves none of its processes
// behind when a test fails or times out. Not a test file: the fixture that proves the cleanup imports it too.
import { type ChildProcess, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { layout, processStart } from '../src/index.ts';

// A stand-in ComfyUI: this folder's "python" is a shell script that never ends, so its command line names the
// folder's Python just as the real ComfyUI's does.
const installs: string[] = [];
export function fakeInstall(script = 'while :; do sleep 1; done'): string {
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

export const started: ChildProcess[] = [];
afterEach(() => {
  for (const c of started.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const dir of installs) {
    // What the crash script noted of its children as soon as ComfyUI was up, with the start time they had then:
    // only that process is killed, not whatever the OS has since given the number to.
    try {
      const noted = JSON.parse(readFileSync(join(dir, 'pids.json'), 'utf8')) as {
        pid: number;
        started: string;
      }[];
      for (const { pid, started: at } of noted)
        if (at && processStart(pid) === at)
          try {
            process.kill(pid, 'SIGKILL');
          } catch {}
    } catch {}
  }
  // A test that died before it could note its processes leaves them by name only: anything whose command line is in
  // one of the fake installs. -ww: BSD ps cuts the command short without a terminal.
  if (process.platform !== 'win32' && installs.length) {
    const ps = spawnSync('ps', ['-axww', '-o', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (ps.error) console.warn('ps failed, so fake installs’ processes are not swept:', ps.error);
    for (const line of (ps.stdout ?? '').split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m || Number(m[1]) === process.pid || !installs.some((d) => m[2]!.includes(d))) continue;
      try {
        process.kill(Number(m[1]), 'SIGKILL');
      } catch {}
    }
  }
});
