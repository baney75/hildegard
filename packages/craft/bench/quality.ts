// SPDX-License-Identifier: AGPL-3.0-only
// How well the prose lint tells machine writing from people's: recall on AI drafts, false fails on human writing, and
// for each rule how often it fires on each.
//   node packages/craft/bench/quality.ts [--json] [--cached] [--show <rule>] [--py]
//   --cached  add drafts found in ~/.cache (more no-skill AI writing, and drafts made with the skill, reported apart)
//   --split   report one split only (`dev` or `test`)
//   --show    print what a rule matched in `dev` pieces (test pieces are never shown one by one)
//   --py      also run the Python script over the same pieces and fail if it differs from the package
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintProse, type ProseLint } from '../src/index.ts';
import { loadCached, loadCommitted, type Piece } from './corpus.ts';

export interface Report {
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
  for (const s of ['dev', 'test'] as const) {
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
  return {
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

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const pieces = loadCommitted();
  const cached = args.includes('--cached') ? loadCached() : [];
  const only = args.includes('--split') ? args[args.indexOf('--split') + 1] : undefined;
  const all = [...pieces, ...cached].filter((p) => !only || p.split === only);
  const { rows, report } = measure(all);

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

  if (args.includes('--py')) {
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
    let diff = 0;
    all.forEach((p, i) => {
      if (JSON.stringify(py[i]) !== JSON.stringify(rows[i]!.l)) {
        diff++;
        console.error(`DIFFERS ${p.id}`);
      }
    });
    console.log(
      diff
        ? `Python and the package differ on ${diff} of ${all.length} pieces`
        : `Python and the package agree on all ${all.length} pieces`,
    );
    if (diff) process.exit(1);
  }

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
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
