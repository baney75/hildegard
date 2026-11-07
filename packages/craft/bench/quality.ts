// SPDX-License-Identifier: AGPL-3.0-only
// How well the prose lint tells machine writing from people's: recall on AI drafts, false fails on human writing, and
// for each rule how often it fires on each.
//   node packages/craft/bench/quality.ts [--json] [--cached] [--show <rule>] [--py]
//   --cached  add drafts found in ~/.cache (more no-skill AI writing, and drafts made with the skill, reported apart)
//   --split   report one split only (`dev`, `test` or `holdout`)
//   --holdout add the holdout pieces, which nothing reads until the rules are final
//   --show    print what a rule matched in `dev` pieces (test pieces are never shown one by one)
//   --ref     measure the lint as it stood at a git ref (say origin/main) instead of this tree
//   --ratchet write baseline.json when the numbers are no worse and some are better (--rebase after the corpus changes)
//   --py      also run the Python script over the same pieces and fail if it differs from the package (both profiles)
// Every number is given twice: the default profile, and `strict` (the em dash and the other warns fail), which is for
// writing that must carry no tells and so is not held to the human false-fail limit.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintProse, type ProseLint } from '../src/index.ts';
import { loadCached, loadCommitted, type Piece } from './corpus.ts';
import { engineAt } from './engine.ts';

/** Whole numbers behind the rates: what `baseline.json` holds and the tests compare. */
export interface Counts {
  humanN: number;
  humanFails: number;
  /** Human pieces with any warn: what the writer is asked to weigh. Recorded, not held to a limit. */
  humanWarns: number;
  aiN: number;
  aiFails: number;
  testHumanN: number;
  testHumanFails: number;
  testAiN: number;
  testAiFails: number;
  holdoutHumanN: number;
  holdoutHumanFails: number;
  holdoutAiN: number;
  holdoutAiFails: number;
}

/** What `baseline.json` holds: the default profile's counts, and the strict profile's under `strict`. */
export type Baseline = Counts & { strict: Counts };

export interface Report {
  counts: Counts;
  human: { n: number; failRate: number; warnRate: number; anyRate: number };
  ai: { n: number; recall: number; anyRate: number; byModel: Record<string, { n: number; recall: number }> };
  /** Split of the same two rates, `test` being the pieces nobody read while tuning. */
  splits: Record<string, { humanN: number; falseFail: number; aiN: number; recall: number }>;
  rules: Record<string, { human: number; ai: number; humanFail: number; aiFail: number }>;
}

const rate = (a: number, n: number) => (n ? Math.round((a / n) * 1000) / 1000 : 0);

export function measure(pieces: Piece[], lint: (t: string) => ProseLint = lintProse) {
  const rows = pieces.map((p) => ({ p, l: lint(p.text) }));
  return { rows, report: summarize(rows) };
}

export function summarize(rows: Array<{ p: Piece; l: ProseLint }>): Report {
  const by = (g: Piece['group']) => rows.filter((r) => r.p.group === g);
  const human = by('human');
  const ai = by('ai');
  const fails = (rs: typeof rows) => rs.filter((r) => !r.l.ok).length;
  const warns = (rs: typeof rows) => rs.filter((r) => r.l.findings.some((f) => f.severity === 'warn')).length;
  const any = (rs: typeof rows) => rs.filter((r) => r.l.findings.length).length;
  const models: Report['ai']['byModel'] = {};
  for (const m of new Set(ai.map((r) => r.p.from))) {
    const rs = ai.filter((r) => r.p.from === m);
    models[m] = { n: rs.length, recall: rate(fails(rs), rs.length) };
  }
  const splits: Report['splits'] = {};
  for (const s of ['dev', 'test', 'holdout'] as const) {
    const h = human.filter((r) => r.p.split === s);
    const a = ai.filter((r) => r.p.split === s);
    splits[s] = {
      humanN: h.length,
      falseFail: rate(fails(h), h.length),
      aiN: a.length,
      recall: rate(fails(a), a.length),
    };
  }
  const rules: Report['rules'] = {};
  for (const r of rows) {
    if (r.p.group === 'skill') continue;
    for (const f of r.l.findings) {
      rules[f.id] ??= { human: 0, ai: 0, humanFail: 0, aiFail: 0 };
      const e = rules[f.id]!;
      if (r.p.group === 'human') {
        e.human++;
        if (f.severity === 'fail') e.humanFail++;
      } else {
        e.ai++;
        if (f.severity === 'fail') e.aiFail++;
      }
    }
  }
  const n = (rs: typeof rows) => rs.length;
  const th = human.filter((r) => r.p.split === 'test');
  const ta = ai.filter((r) => r.p.split === 'test');
  const hh = human.filter((r) => r.p.split === 'holdout');
  const ha = ai.filter((r) => r.p.split === 'holdout');
  return {
    counts: {
      humanN: n(human),
      humanFails: fails(human),
      humanWarns: warns(human),
      aiN: n(ai),
      aiFails: fails(ai),
      testHumanN: n(th),
      testHumanFails: fails(th),
      testAiN: n(ta),
      testAiFails: fails(ta),
      holdoutHumanN: n(hh),
      holdoutHumanFails: fails(hh),
      holdoutAiN: n(ha),
      holdoutAiFails: fails(ha),
    },
    human: {
      n: human.length,
      failRate: rate(fails(human), human.length),
      warnRate: rate(warns(human), human.length),
      anyRate: rate(any(human), human.length),
    },
    ai: {
      n: ai.length,
      recall: rate(fails(ai), ai.length),
      anyRate: rate(any(ai), ai.length),
      byModel: models,
    },
    splits,
    rules,
  };
}

export const baselinePath = join(import.meta.dirname, 'baseline.json');

/** Whether `now` is no worse than `then` on every count (more AI drafts failing, no more human pieces failing). */
export function noWorse(now: Counts, then: Counts): string[] {
  const bad: string[] = [];
  if (now.humanN !== then.humanN || now.aiN !== then.aiN)
    bad.push('the corpus changed size: rebase the baseline');
  if (now.humanFails > then.humanFails)
    bad.push(`human pieces failing: ${now.humanFails} > ${then.humanFails}`);
  if (now.testHumanFails > then.testHumanFails)
    bad.push(`test-split human pieces failing: ${now.testHumanFails} > ${then.testHumanFails}`);
  if (now.holdoutHumanFails > then.holdoutHumanFails)
    bad.push(`holdout human pieces failing: ${now.holdoutHumanFails} > ${then.holdoutHumanFails}`);
  if (now.holdoutAiFails < then.holdoutAiFails)
    bad.push(`holdout AI drafts failing: ${now.holdoutAiFails} < ${then.holdoutAiFails}`);
  if (now.aiFails < then.aiFails) bad.push(`AI drafts failing: ${now.aiFails} < ${then.aiFails}`);
  if (now.testAiFails < then.testAiFails)
    bad.push(`test-split AI drafts failing: ${now.testAiFails} < ${then.testAiFails}`);
  return bad;
}

/**
 * The strict profile may fail more of the AI drafts than the default one, never fewer than it did: it is held to its
 * recall, and to failing at least what the default fails. Its human false fails are recorded and not limited.
 */
export function strictNoWorse(now: Counts, then: Counts, defaults: Counts): string[] {
  const bad: string[] = [];
  if (now.aiFails < then.aiFails) bad.push(`strict AI drafts failing: ${now.aiFails} < ${then.aiFails}`);
  if (now.testAiFails < then.testAiFails)
    bad.push(`strict test-split AI drafts failing: ${now.testAiFails} < ${then.testAiFails}`);
  if (now.holdoutAiFails < then.holdoutAiFails)
    bad.push(`strict holdout AI drafts failing: ${now.holdoutAiFails} < ${then.holdoutAiFails}`);
  if (now.aiFails < defaults.aiFails || now.humanFails < defaults.humanFails)
    bad.push('strict fails less than the default profile');
  return bad;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pieces = loadCommitted();
  const cached = args.includes('--cached') ? loadCached() : [];
  const only = args.includes('--split') ? args[args.indexOf('--split') + 1] : undefined;
  // The holdout is read once, when the rules are final: ask for it with --holdout or --split holdout.
  const all = [...pieces, ...cached].filter((p) =>
    only
      ? p.split === only
      : args.includes('--holdout') || args.includes('--ratchet') || p.split !== 'holdout',
  );
  const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : undefined;
  const engine = ref ? await engineAt(ref) : undefined;
  const { rows, report } = measure(all, engine?.lintProse);
  // The strict profile is this tree's; an older ref has none.
  const strictRun = engine ? undefined : measure(all, (t) => lintProse(t, { strict: true }));

  const show = args.includes('--show') ? args[args.indexOf('--show') + 1] : undefined;
  if (show) {
    for (const r of rows.filter((x) => x.p.split === 'dev' && x.p.group !== 'skill')) {
      const f = r.l.findings.find((x) => x.id === show);
      if (f)
        console.log(
          `${r.p.group} ${r.p.id} [${f.severity}] ${f.matches
            .slice(0, 4)
            .map((m) => JSON.stringify(m.text.slice(0, 70)))
            .join(' ')}`,
        );
    }
    process.exit(0);
  }

  if (args.includes('--py') && !engine) {
    const dir = mkdtempSync(join(tmpdir(), 'prose-q-'));
    const list = all.map((p, i) => {
      const f = join(dir, `${i}.md`);
      writeFileSync(f, p.text);
      return f;
    });
    const out = execFileSync('python3', ['-I', join(import.meta.dirname, 'lint_all.py'), ...list], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    const py = JSON.parse(out) as ProseLint[];
    const pyStrict = JSON.parse(
      execFileSync('python3', ['-I', join(import.meta.dirname, 'lint_all.py'), '--strict', ...list], {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      }),
    ) as ProseLint[];
    let diff = 0;
    all.forEach((p, i) => {
      if (JSON.stringify(py[i]) !== JSON.stringify(rows[i]!.l)) {
        diff++;
        console.error(`DIFFERS ${p.id}`);
      }
      if (JSON.stringify(pyStrict[i]) !== JSON.stringify(strictRun!.rows[i]!.l)) {
        diff++;
        console.error(`DIFFERS (strict) ${p.id}`);
      }
    });
    console.log(
      diff
        ? `Python and the package differ on ${diff} of ${all.length} pieces`
        : `Python and the package agree on all ${all.length} pieces`,
    );
    if (diff) process.exit(1);
  }

  if (args.includes('--ratchet')) {
    const { strict: thenStrict, ...then } = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
    const bad = args.includes('--rebase')
      ? []
      : [
          ...noWorse(report.counts, then),
          ...strictNoWorse(strictRun!.report.counts, thenStrict, report.counts),
        ];
    if (bad.length) {
      console.error(`Not ratcheting: ${bad.join('; ')}`);
      process.exit(1);
    }
    const next: Baseline = { ...report.counts, strict: strictRun!.report.counts };
    const better = JSON.stringify(next) !== JSON.stringify({ ...then, strict: thenStrict });
    if (better) writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    console.log(better ? `baseline.json updated: ${JSON.stringify(next)}` : 'baseline.json already matches');
    process.exit(0);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(strictRun ? { ...report, strict: strictRun.report } : report, null, 2));
    process.exit(0);
  }
  if (strictRun) {
    const s = strictRun.report;
    console.log(
      `Strict profile: human fail ${pct(s.human.failRate)}, any warn ${pct(s.human.warnRate)}; AI recall ${pct(s.ai.recall)}.`,
    );
  }
  const skill = rows.filter((r) => r.p.group === 'skill');
  console.log(
    `Human writing: ${report.human.n} pieces. Fail ${pct(report.human.failRate)}, any warn ${pct(report.human.warnRate)}, any finding ${pct(report.human.anyRate)}.`,
  );
  console.log(
    `AI drafts (no skill): ${report.ai.n} pieces. Recall (fails) ${pct(report.ai.recall)}, any finding ${pct(report.ai.anyRate)}.`,
  );
  for (const [m, v] of Object.entries(report.ai.byModel))
    console.log(`  ${m.padEnd(22)} n=${String(v.n).padStart(2)} recall ${pct(v.recall)}`);
  for (const [s, v] of Object.entries(report.splits))
    console.log(
      `${s.padEnd(5)} human n=${v.humanN} false-fail ${pct(v.falseFail)}; AI n=${v.aiN} recall ${pct(v.recall)}`,
    );
  if (skill.length)
    console.log(
      `Drafts made with the skill: ${skill.length}, failing ${skill.filter((r) => !r.l.ok).length}`,
    );
  console.log('\nrule'.padEnd(22), 'human', 'ai   ', 'humanFail', 'aiFail');
  const nH = report.human.n;
  const nA = report.ai.n;
  for (const [id, v] of Object.entries(report.rules).sort(
    (a, b) => b[1].ai / nA - b[1].human / nH - (a[1].ai / nA - a[1].human / nH),
  ))
    console.log(
      `${id.padEnd(21)} ${pct(v.human / nH).padStart(6)} ${pct(v.ai / nA).padStart(6)} ${pct(v.humanFail / nH).padStart(8)} ${pct(v.aiFail / nA).padStart(8)}   (${v.human}/${v.ai})`,
    );
}
