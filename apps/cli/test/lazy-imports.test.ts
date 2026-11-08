// SPDX-License-Identifier: AGPL-3.0-only
// The CLI starts in tens of milliseconds only if a command loads just its own code. Loading the whole server costs
// more than the rest of a call put together, so this holds the line: these commands never load it.
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { cliEnv, main } from './harness.ts';

const exec = promisify(execFile);
// A file URL, not a path: on Windows `--import D:\a\...\trace-imports.mjs` is read as the scheme "d:" and Node refuses
// to start, so the command printed no module list at all. The URL names the same file on every platform.
const trace = new URL('./trace-imports.mjs', import.meta.url).href;

async function loaded(args: string[]): Promise<string[]> {
  const home = mkdtempSync(join(tmpdir(), 'hg-lazy-'));
  const { stderr } = await exec(
    process.execPath,
    ['--import', trace, main, ...args, '--port', '1', '--data', join(home, 'data')],
    { env: { ...cliEnv(home), HILDEGARD_COMPILE_CACHE: 'off' }, timeout: 30_000 },
  ).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
  const line = stderr.split('\n').find((l) => l.startsWith('LOADED '));
  return line ? (JSON.parse(line.slice('LOADED '.length)) as string[]) : [];
}

// The server's app, scheduler and HTTP framework are what make loading it slow.
const heavy = (url: string) =>
  /\/apps\/server\/src\/(app|server|scheduler|voice|loop|llm)\.ts$/.test(url) || /\/hono\//.test(url);

describe('the CLI loads only the code a command needs', () => {
  it.skipIf(process.env.HILDEGARD_CLI)('--help and --version load no server code', async () => {
    for (const args of [['--help'], ['--version'], ['help']]) {
      const urls = await loaded(args);
      expect(urls.length, args.join(' ')).toBeGreaterThan(0);
      expect(urls.filter(heavy), args.join(' ')).toEqual([]);
      // Nor the command modules: just the entry, its output helper and the two tiny server modules it prints from.
      expect(
        urls.some((u) => /\/apps\/cli\/src\/commands\.ts$/.test(u)),
        args.join(' '),
      ).toBe(false);
    }
  });

  it.skipIf(process.env.HILDEGARD_CLI)(
    'status, models, doctor, host and tunnel talk to the server over HTTP and never load it',
    async () => {
      for (const args of [['status'], ['models'], ['doctor'], ['host', 'status'], ['tunnel'], ['agents']]) {
        const urls = await loaded(args);
        expect(urls.length, args.join(' ')).toBeGreaterThan(0);
        expect(urls.filter(heavy), args.join(' ')).toEqual([]);
      }
    },
    120_000,
  );
});
