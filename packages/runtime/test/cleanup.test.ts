// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pgrep = (dir: string) => spawnSync('pgrep', ['-f', '--', dir], { encoding: 'utf8' }).stdout.trim();

// A test that starts the stand-in ComfyUI and then fails or times out must not leave it running (the hildegard-supervisor-*
// loops that piled up on a Mac).
it.skipIf(process.platform === 'win32')(
  'leaves no ComfyUI stand-in running when a test that started one fails',
  async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'hg-leak-out-')), 'dir');
    const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
    const child = spawnSync(
      process.execPath,
      [vitest, 'run', '--config', here('./fixtures/vitest.config.ts'), '--root', here('./fixtures/')],
      { encoding: 'utf8', timeout: 120_000, env: { ...process.env, LEAK_OUT: out } },
    );
    const dir = readFileSync(out, 'utf8');
    let left = '';
    try {
      // The fixture failed where it should: after ComfyUI was up, on the script's timeout.
      expect(child.status).not.toBe(0);
      expect(child.stdout + child.stderr).toMatch(/expected null to be/);
      // Nothing names its install any more (a killed process is reaped a moment later).
      for (let i = 0; i < 40; i++) {
        left = pgrep(dir);
        if (!left) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(left).toBe('');
    } finally {
      for (const pid of pgrep(dir).split('\n').filter(Boolean))
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {}
    }
  },
  150_000,
);
