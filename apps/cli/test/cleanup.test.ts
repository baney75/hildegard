// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { freePort, underTmp } from './harness.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pgrep = (data: string) => spawnSync('pgrep', ['-f', '--', data], { encoding: 'utf8' });

// The leak behind 145 orphaned servers: a test started a background server, failed, and never reached its stop.
it.skipIf(process.platform === 'win32')(
  'leaves no server running when a test that started one fails',
  async () => {
    const data = mkdtempSync(join(tmpdir(), 'hg-cli-leak-'));
    const port = await freePort();
    const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
    const child = spawnSync(
      process.execPath,
      [vitest, 'run', '--config', here('./fixtures/vitest.config.ts'), '--root', here('./fixtures/')],
      {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, LEAK_DATA: data, LEAK_PORT: String(port) },
      },
    );
    try {
      // The fixture failed where it should: after its server started, before its stop.
      expect(child.status).not.toBe(0);
      expect(child.stdout + child.stderr).toContain("expected 'the test fails here' to be 'before its stop'");
      // And nothing of its is left: no process names its data folder, and its port no longer answers.
      expect(pgrep(data).stdout.trim()).toBe('');
      await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    } finally {
      // Should the above fail, don't leave the server it found.
      for (const pid of pgrep(data).stdout.split('\n').filter(Boolean)) {
        try {
          process.kill(-Number(pid), 'SIGKILL');
        } catch {}
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {}
      }
    }
  },
  150_000,
);

// A guard against `pgrep -f <folder>` matching everything: only a folder under the temp directory is ever swept.
it('sweeps only a folder under the temp directory', () => {
  const inside = mkdtempSync(join(tmpdir(), 'hg-cli-guard-'));
  expect(underTmp(inside)).toBe(true);
  expect(underTmp(tmpdir())).toBe(false);
  expect(underTmp(join(inside, 'not-made'))).toBe(false);
  expect(underTmp(homedir())).toBe(false);
  expect(underTmp(parse(inside).root)).toBe(false);
  // A link in the temp directory to a folder outside it is outside (macOS' /var is /private/var, so both are resolved).
  const link = join(inside, 'link');
  symlinkSync(homedir(), link);
  expect(underTmp(link)).toBe(false);
});
