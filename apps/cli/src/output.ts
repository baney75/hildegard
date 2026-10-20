// SPDX-License-Identifier: AGPL-3.0-only
import type { Step } from '@hildegard/runtime';

/** What every command returns. With --json it is printed as is, for agents; otherwise as lines for people. */
export interface Result {
  ok: boolean;
  /** Some step waits on the owner: a license to accept, a driver to install. */
  needsOwner: boolean;
  steps: Step[];
  /** One plain sentence: what happened, and what's next. */
  message: string;
  [extra: string]: unknown;
}

export function result(steps: Step[], message: string, extra: Record<string, unknown> = {}): Result {
  return {
    ok: !steps.some((s) => s.status === 'failed'),
    needsOwner: steps.some((s) => s.status === 'needs-owner'),
    steps,
    message,
    ...extra,
  };
}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = paint('2');
export const bold = paint('1');
const gold = paint('33');
const red = paint('31');
const green = paint('32');

const MARK: Record<Step['status'], string> = {
  done: green('✓'),
  skipped: dim('·'),
  'needs-owner': gold('!'),
  failed: red('✗'),
};

export function printStep(s: Step) {
  console.log(`${MARK[s.status]} ${s.title}`);
  for (const line of s.detail.split('\n')) console.log(`  ${dim(line)}`);
  if (s.command) console.log(`  ${bold(s.command)}`);
}

export function printResult(r: Result, json: boolean, printed = 0) {
  if (json) {
    // `printed` is how many steps already went to the terminal: bookkeeping for people, not part of the result.
    const { printed: _, ...rest } = r as Result & { printed?: number };
    console.log(JSON.stringify(rest, null, 2));
    return;
  }
  for (const s of r.steps.slice(printed)) printStep(s);
  if (r.message) console.log(`\n${r.ok ? r.message : red(r.message)}`);
}
