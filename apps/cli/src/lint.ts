// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { describeProseLint, lintProse } from '@hildegard/craft';
import type { Ctx } from './commands.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Exit status 2 for bad usage or a file that can't be read; 1 stays for a lint that fails. */
const usage = (message: string) => Object.assign(new Error(message), { exitCode: 2 });

/**
 * `hildegard lint <file...>`: the prose lint on this computer, no server needed. `-` reads standard input. Prints each
 * file's findings (or with --json the lint itself: one object for one file, a list of { file, … } for several) and
 * sets the exit status to 1 when any file fails, or 2 when it was used wrongly or a file can't be read.
 */
export async function lint(ctx: Ctx, files: string[]): Promise<void> {
  if (!files.length) throw usage('Give the files to lint, or - to read from standard input.');
  const max = ctx.opts.has('max') ? Number(ctx.opts.get('max')) : ctx.flags.has('max') ? Number.NaN : 6;
  if (!Number.isInteger(max) || max < 1) throw usage('--max takes a whole number of places, 1 or more.');
  const results = [];
  for (const file of files) {
    const text =
      file === '-'
        ? await readStdin()
        : await readFile(file, 'utf8').catch(() => {
            throw usage(`I can’t read ${file}.`);
          });
    results.push({ file: file === '-' ? 'stdin' : file, lint: lintProse(text) });
  }
  if (ctx.json) {
    const out = results.length === 1 ? results[0]!.lint : results.map((r) => ({ file: r.file, ...r.lint }));
    console.log(JSON.stringify(out, null, 2));
  } else
    results.forEach((r, i) => {
      if (results.length > 1) console.log(`${i ? '\n' : ''}${r.file}`);
      console.log(describeProseLint(r.lint, max));
    });
  if (results.some((r) => !r.lint.ok)) process.exitCode = 1;
}
