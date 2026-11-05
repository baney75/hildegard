// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lintProse, type ProseLint } from '../src/index.ts';
import FIXTURES from './prose-fixtures.json' with { type: 'json' };

const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const root = resolve(import.meta.dirname, '../../..');
const script = join(root, 'skills/hildegard/scripts/prose_lint.py');
const dir = mkdtempSync(join(tmpdir(), 'prose-py-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function lintPy(text: string, name = 'in.md'): ProseLint {
  const file = join(dir, name);
  writeFileSync(file, text);
  try {
    return JSON.parse(execFileSync(python, ['-I', script, '--json', file], { encoding: 'utf8' }));
  } catch (e) {
    // Exit status 1 means the text fails; the lint is still on stdout.
    const out = (e as { status?: number; stdout?: string }).stdout;
    if ((e as { status?: number }).status === 1 && out) return JSON.parse(out);
    throw e;
  }
}

interface Attack {
  name: string;
  head: string;
  unit: string;
  times: number;
  tail: string;
}

const pairs = (l: ProseLint) => l.findings.map((f) => `${f.severity} ${f.id}`).sort();

describe('prose lint: the Python script and the package agree', () => {
  for (const c of FIXTURES.cases as Array<{ name: string; text: string }>) {
    it(c.name, () => {
      const js = lintProse(c.text);
      const py = lintPy(c.text);
      expect(pairs(py)).toEqual(pairs(js));
      expect(py.ok).toBe(js.ok);
      expect(py.words).toBe(js.words);
      expect(py.findings.map((f) => [f.id, f.why, f.fix])).toEqual(
        js.findings.map((f) => [f.id, f.why, f.fix]),
      );
      // The same places, in the same order: text, offset, line and column.
      expect(py.findings.map((f) => f.matches)).toEqual(js.findings.map((f) => f.matches));
    });
  }

  for (const a of FIXTURES.attacks as Attack[]) {
    it(`lints 200,000 characters of ${a.name} in seconds, and agrees`, () => {
      const text = a.head + a.unit.repeat(a.times) + a.tail;
      const started = performance.now();
      const py = lintPy(text);
      expect(performance.now() - started).toBeLessThan(5000);
      expect(py).toEqual(lintProse(text));
    });
  }

  it('counts columns in UTF-16 units, as JavaScript does', () => {
    const text = '😀 We will delve into it.\n\n# 🎉 Heading\n';
    const js = lintProse(text);
    expect(js.findings.length).toBeGreaterThan(0);
    expect(lintPy(text)).toEqual(js);
  });

  it('agrees on Windows line endings', () => {
    const text = 'First line.\r\n\r\nWe will delve into the realm of it.\r\n\r\n- 🚀 Item\r\n';
    expect(lintPy(text)).toEqual(lintProse(text));
  });

  it('agrees on the repo’s own docs', () => {
    const docs = join(root, 'docs');
    const files = readdirSync(docs).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const text = readFileSync(join(docs, f), 'utf8');
      const js = lintProse(text);
      const py = lintPy(text, f);
      const shape = (l: ProseLint) => ({
        ok: l.ok,
        words: l.words,
        findings: l.findings.map((x) => `${x.severity} ${x.id} ${x.matches.length}`),
      });
      expect({ f, ...shape(py) }).toEqual({ f, ...shape(js) });
    }
  });

  it('exits 1 on a failing file and 0 on a passing one, and reads stdin', () => {
    const run = (input: string) => {
      try {
        execFileSync(python, ['-I', script, '-'], { input, encoding: 'utf8' });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(run('We will delve into it.')).toBe(1);
    expect(run('A plain sentence about a red barn.')).toBe(0);
  });
});
