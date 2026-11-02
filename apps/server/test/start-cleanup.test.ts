// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { memoryStore } from './helpers.ts';

/** Processes whose command line runs this folder's Python: the managed ComfyUI and its proxy. */
function running(python: string): number[] {
  const ps = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout;
  return ps
    .split('\n')
    .filter((l) => l.includes(python))
    .map((l) => Number(l.trim().split(/\s+/)[0]));
}

describe.skipIf(process.platform === 'win32')('starting the server', () => {
  it('stops the ComfyUI it started when a later step fails, so nothing is left serving nobody', async () => {
    // An installed runtime whose "Python" is a stand-in that runs until it's stopped.
    const dir = mkdtempSync(join(tmpdir(), 'hg-start-cleanup-'));
    const python = join(dir, 'python', 'bin', 'python');
    mkdirSync(join(dir, 'python', 'bin'), { recursive: true });
    mkdirSync(join(dir, 'comfyui'), { recursive: true });
    writeFileSync(python, '#!/bin/sh\nwhile :; do sleep 1; done\n');
    chmodSync(python, 0o755);
    writeFileSync(
      join(dir, 'runtime.json'),
      JSON.stringify({
        comfyui: '0',
        backend: 'cpu',
        torchBackend: null,
        gpu: 'none',
        torch: '0',
        installedAt: '',
      }),
    );
    // A step after ComfyUI starts fails, as a missing voices.toml did on parish1.
    const opts = { secrets: memoryStore(), hubToken: join(dir, 'no-hf-token') };
    Object.defineProperty(opts, 'voiceCatalog', {
      get() {
        if (running(python).length === 0) throw new Error('ComfyUI should have started first');
        throw new Error('ENOENT: voices.toml');
      },
    });

    await expect(
      startServer({ ...parseArgs(['--data', dir]), port: 0, hfClientId: null }, opts),
    ).rejects.toThrow('ENOENT: voices.toml');
    for (let i = 0; i < 40 && running(python).length; i++) await new Promise((r) => setTimeout(r, 100));
    expect(running(python)).toEqual([]);
  }, 30_000);
});
