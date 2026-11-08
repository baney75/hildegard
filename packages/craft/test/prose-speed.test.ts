// SPDX-License-Identifier: AGPL-3.0-only
// A speed ratchet with a generous ceiling, so a slow CI machine passes and a rule that scans quadratically does not.
// Measured on a laptop (2026-11): about 10 ms for 100,000 characters in TypeScript and 80 ms in Python. The full
// numbers, with where the time goes, come from `node packages/craft/bench/speed.ts`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { realistic, timeTs } from '../bench/speed.ts';

const bench = resolve(import.meta.dirname, '../bench');
const dir = mkdtempSync(join(tmpdir(), 'prose-speed-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const text = realistic(100_000);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('prose lint speed on 100,000 characters of prose', () => {
  it('takes under 250 ms in TypeScript (median of 5)', () => {
    const ms = timeTs({ name: 'x', text, runs: 5 })[0]!;
    expect(median(ms)).toBeLessThan(250);
  });

  it('takes under 2 s in Python (median of 3, one process)', () => {
    const file = join(dir, 'case.json');
    writeFileSync(file, JSON.stringify([{ name: 'x', text, runs: 3 }]));
    const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const out = JSON.parse(
      execFileSync(python, ['-I', join(bench, 'speed_py.py'), file], { encoding: 'utf8' }),
    ) as Record<string, { ms: number[] }>;
    expect(median(out.x!.ms)).toBeLessThan(2000);
  });
});
