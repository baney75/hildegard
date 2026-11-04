// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { freePort, underTmp } from './harness.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const pgrep = (data: string) => spawnSync('pgrep', ['-f', '--', data], { encoding: 'utf8' }).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/health`).then(
    () => true,
    () => false,
  );

/** Runs one fixture in a child vitest, with a home, data folder and port of its own; `check` judges, then all is removed. */
async function runFixture(
  name: string,
  check: (r: { child: ReturnType<typeof spawnSync>; data: string; port: number }) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), 'hg-cli-home-'));
  const data = mkdtempSync(join(tmpdir(), 'hg-cli-leak-'));
  const port = await freePort();
  const vitest = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
  try {
    const child = spawnSync(
      process.execPath,
      [vitest, 'run', '--config', here('./fixtures/vitest.config.ts'), '--root', here('./fixtures/'), name],
      {
        encoding: 'utf8',
        // Above the fixture's own timeout (90 s) and the cleanup hooks' (60 s each).
        timeout: 240_000,
        env: {
          ...process.env,
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          LEAK_HOME: home,
          LEAK_DATA: data,
          LEAK_PORT: String(port),
        },
      },
    );
    try {
      await check({ child, data, port });
    } finally {
      // Should the check fail, don't leave the server it found.
      for (const pid of pgrep(data).split('\n').filter(Boolean)) {
        try {
          process.kill(-Number(pid), 'SIGKILL');
        } catch {}
        try {
          process.kill(Number(pid), 'SIGKILL');
        } catch {}
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
}

// CI forces colour; strip ANSI escapes so the summary line matches.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const output = (child: { stdout: unknown; stderr: unknown }) =>
  `${child.stdout}${child.stderr}`.replace(ANSI, '');

// The leak behind 145 orphaned servers: a test started a background server, failed, and never reached its stop.
it.skipIf(process.platform === 'win32')(
  'leaves no server running when a test that started one fails',
  () =>
    runFixture('leak', async ({ child, data, port }) => {
      // The fixture failed where it should: after its server started, before its stop.
      expect(child.status).not.toBe(0);
      expect(output(child)).toContain("expected 'the test fails here' to be 'before its stop'");
      // And nothing of its is left (a killed process is reaped a moment later): no process names its data folder,
      // and its port no longer answers.
      let left = pgrep(data);
      for (let i = 0; i < 8 && left; i++) {
        await sleep(250);
        left = pgrep(data);
      }
      expect(left).toBe('');
      expect(await answers(port)).toBe(false);
    }),
  270_000,
);

// A test that times out while `hildegard start` is still running: the server starts after the test's cleanup looked.
it.skipIf(process.platform === 'win32')(
  'leaves no server starting after a test that timed out mid-start',
  () =>
    runFixture('inflight', async ({ child, data, port }) => {
      expect(child.status).not.toBe(0);
      expect(output(child)).toContain('Test timed out in 300ms');
      // The start was cut short, or its server was stopped: watch long enough for one that starts late (this one
      // is held for five seconds before it spawns its server).
      for (let i = 0; i < 36; i++) {
        expect(pgrep(data), `a process names ${data} ${i * 250} ms after the fixture ended`).toBe('');
        expect(await answers(port), `port ${port} answers ${i * 250} ms after the fixture ended`).toBe(false);
        await sleep(250);
      }
    }),
  270_000,
);

// The cleanup runs after each test, not only when the file ends: a later test in the same file mustn't find the server.
it.skipIf(process.platform === 'win32')(
  'stops a failed test’s server before the next test runs',
  () =>
    runFixture('between', async ({ child }) => {
      expect(output(child)).toMatch(/Tests\s+1 failed \| 1 passed/);
    }),
  270_000,
);

// A guard against `pgrep -f <folder>` matching everything: only a folder under the temp directory is ever swept.
it('sweeps only a folder under the temp directory', () => {
  const inside = mkdtempSync(join(tmpdir(), 'hg-cli-guard-'));
  const link = join(inside, 'link');
  try {
    expect(underTmp(inside)).toBe(true);
    expect(underTmp(tmpdir())).toBe(false);
    expect(underTmp(join(inside, 'not-made'))).toBe(false);
    expect(underTmp(homedir())).toBe(false);
    expect(underTmp(parse(inside).root)).toBe(false);
    // A link in the temp directory to a folder outside it is outside (macOS' /var is /private/var, so both are resolved).
    // A junction, since a symbolic link needs more rights on Windows.
    symlinkSync(homedir(), link, 'junction');
    expect(underTmp(link)).toBe(false);
  } finally {
    // The link first: removing the folder must never follow it into the home folder.
    try {
      unlinkSync(link);
    } catch {}
    rmSync(inside, { recursive: true, force: true });
  }
});
