// SPDX-License-Identifier: AGPL-3.0-only
// The ratchet: how well the prose lint tells AI drafts from people's writing may get better, never worse. The numbers
// are in bench/baseline.json; `node packages/craft/bench/quality.ts --ratchet` raises them when a change earns it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCached, loadCommitted } from '../bench/corpus.ts';
import { type Baseline, measure, noWorse, strictNoWorse } from '../bench/quality.ts';
import { lintProse, type ProseLint } from '../src/index.ts';
import { phraseHits, phraseHitsNaive } from '../src/prose.ts';
import FIXTURES from './prose-fixtures.json' with { type: 'json' };

const bench = resolve(import.meta.dirname, '../bench');
const baseline = JSON.parse(readFileSync(join(bench, 'baseline.json'), 'utf8')) as Baseline;
const committed = loadCommitted();
const { rows, report } = measure(committed);
const strictRun = measure(committed, (t) => lintProse(t, { strict: true }));
const dir = mkdtempSync(join(tmpdir(), 'prose-quality-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('prose lint quality: no worse than the committed baseline', () => {
  it('fails no more human pieces, and at least as many AI drafts', () => {
    expect(noWorse(report.counts, baseline)).toEqual([]);
  });

  it('never fails a person’s piece in the default profile, em dashes and all', () => {
    expect(report.counts.humanFails).toBe(0);
    expect(report.counts.holdoutHumanFails).toBe(0);
    expect(baseline.humanFails).toBe(0);
    // The dash warns on a large share of people's pieces and fails none, so it is no basis for failing anyone.
    expect(report.rules['em-dash']?.humanFail ?? 0).toBe(0);
    expect(report.rules['em-dash']?.human ?? 0).toBeGreaterThan(40);
  });

  it('holds the strict profile to its recall, and to failing at least what the default fails', () => {
    expect(strictNoWorse(strictRun.report.counts, baseline.strict, report.counts)).toEqual([]);
    expect(strictRun.report.counts.aiFails).toBeGreaterThanOrEqual(report.counts.aiFails);
    expect(strictRun.report.counts.humanFails).toBeGreaterThanOrEqual(report.counts.humanFails);
    // Nothing in the default profile fails on an em dash.
    expect(rows.every((r) => r.l.findings.every((f) => f.id !== 'em-dash' || f.severity === 'warn'))).toBe(
      true,
    );
  });

  it('keeps the human false-fail rate under 2 percent and the AI recall over 25 percent, whatever the baseline says', () => {
    expect(report.human.failRate).toBeLessThan(0.02);
    // 30.7 percent before the placeholder rule stopped failing a person's [bracketed words] (29.5 percent after).
    expect(report.ai.recall).toBeGreaterThan(0.25);
  });

  it('fails nothing a person wrote that the test split holds back from tuning', () => {
    expect(report.counts.testHumanFails).toBe(0);
    expect(report.counts.testAiFails / report.counts.testAiN).toBeGreaterThan(0.25);
  });

  it('names the failing human pieces when there are any, so a regression is easy to read', () => {
    const failing = rows.filter((r) => r.p.group === 'human' && !r.l.ok).map((r) => r.p.id);
    expect(failing.length).toBeLessThanOrEqual(baseline.humanFails);
  });

  it('is the same lint in the Python script on every piece, and on the fixtures', () => {
    const texts = [
      ...committed.map((p) => p.text),
      ...(FIXTURES.cases as Array<{ text: string }>).map((c) => c.text),
    ];
    const files = texts.map((t, i) => {
      const f = join(dir, `${i}.md`);
      writeFileSync(f, t);
      return f;
    });
    const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const py = JSON.parse(
      execFileSync(python, ['-I', join(bench, 'lint_all.py'), ...files], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      }),
    ) as ProseLint[];
    expect(py).toHaveLength(texts.length);
    texts.forEach((t, i) => {
      expect(py[i], `piece ${i}`).toEqual(lintProse(t));
    });
  });

  it('is the same strict lint in the Python script on every piece', () => {
    const files = committed.map((p, i) => {
      const f = join(dir, `strict-${i}.md`);
      writeFileSync(f, p.text);
      return f;
    });
    const python = process.env.HILDEGARD_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const py = JSON.parse(
      execFileSync(python, ['-I', join(bench, 'lint_all.py'), '--strict', ...files], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      }),
    ) as ProseLint[];
    expect(py).toHaveLength(committed.length);
    committed.forEach((p, i) => {
      expect(py[i], p.id).toEqual(lintProse(p.text, { strict: true }));
    });
  });

  it('finds the phrases the way scanning each pattern over the whole text does', () => {
    const shape = (hits: RegExpExecArray[][]) => hits.map((h) => h.map((m) => [m.index, m[0]]));
    for (const t of [
      ...committed.map((p) => p.text),
      ...(FIXTURES.cases as Array<{ text: string }>).map((c) => c.text),
    ])
      expect(shape(phraseHits(t))).toEqual(shape(phraseHitsNaive(t)));
  });
});

const cached = join(homedir(), '.cache/hildegard-creative-eval/runs');
describe('prose lint quality on drafts in the owner’s cache', () => {
  it.skipIf(!existsSync(cached))(
    existsSync(cached)
      ? 'passes every draft made with the skill, and fails no more no-skill drafts than the corpus does'
      : 'skipped: ~/.cache/hildegard-creative-eval/runs is not on this computer',
    () => {
      const extra = loadCached();
      expect(extra.length).toBeGreaterThan(0);
      const withSkill = extra.filter((p) => p.group === 'skill');
      expect(withSkill.filter((p) => !lintProse(p.text).ok).map((p) => p.id)).toEqual([]);
    },
  );
});
