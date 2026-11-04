// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
    const outDir = mkdtempSync(join(tmpdir(), 'hg-leak-out-'));
    const out = join(outDir, 'dir');
    const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
    let dir = '';
    try {
      const child = spawnSync(
        process.execPath,
        [vitest, 'run', '--config', here('./fixtures/vitest.config.ts'), '--root', here('./fixtures/')],
        { encoding: 'utf8', timeout: 120_000, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', LEAK_OUT: out } },
      );
      dir = readFileSync(out, 'utf8');
      // The fixture failed where it should: after ComfyUI was up (it asserts the script printed its processes), on
      // the script's timeout.
      expect(child.status).not.toBe(0);
      expect(child.stdout + child.stderr).toMatch(/expected null to be/);
      // Nothing names its install any more (a killed process is reaped a moment later).
      let left = pgrep(dir);
      for (let i = 0; i < 40 && left; i++) {
        await new Promise((r) => setTimeout(r, 50));
        left = pgrep(dir);
      }
      expect(left).toBe('');
    } finally {
      if (dir)
        for (const pid of pgrep(dir).split('\n').filter(Boolean))
          try {
            process.kill(Number(pid), 'SIGKILL');
          } catch {}
      if (dir) rmSync(dir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  },
  150_000,
);
