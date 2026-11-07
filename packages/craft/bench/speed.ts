// SPDX-License-Identifier: AGPL-3.0-only
// How fast the prose lint is, in both engines, on realistic prose and on the adversarial inputs.
//   node packages/craft/bench/speed.ts [--json] [--profile] [--runs N]
// Realistic prose is the corpus's own pieces joined (human and AI alike) and cut at a sentence to 1k, 10k, 100k and
// 1M characters. Adversarial inputs are the `attacks` in test/prose-fixtures.json, each 200,000 characters. The
// Python script runs in one process (its start-up is not counted). `--profile` adds where the time goes.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import inspector from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lintProse } from '../src/index.ts';
import FIXTURES from '../test/prose-fixtures.json' with { type: 'json' };
import { loadCommitted } from './corpus.ts';

const args = process.argv.slice(2);
const runsArg = args.includes('--runs') ? Number(args[args.indexOf('--runs') + 1]) : 0;

/** Pieces joined with blank lines until `chars` characters, cut after the last full sentence. */
export function realistic(chars: number): string {
  const pieces = loadCommitted().map((p) => p.text.trim());
  let out = '';
  for (let i = 0; out.length < chars + 2000; i++) out += `${pieces[(i * 7) % pieces.length]}\n\n`;
  const cut = out.slice(0, chars);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
  return end > chars / 2 ? cut.slice(0, end + 1) : cut;
}

export interface Case {
  name: string;
  text: string;
  runs: number;
  profile?: boolean;
}

export function cases(): Case[] {
  const runs = (chars: number) => runsArg || (chars <= 10_000 ? 200 : chars <= 100_000 ? 15 : 3);
  const out: Case[] = [1_000, 10_000, 100_000, 1_000_000].map((n) => ({
    name: `prose ${n.toLocaleString('en-US')} chars`,
    text: realistic(n),
    runs: runs(n),
    profile: n === 100_000,
  }));
  for (const a of FIXTURES.attacks)
    out.push({
      name: `attack: ${a.name}`,
      text: a.head + a.unit.repeat(a.times) + a.tail,
      runs: runsArg || 3,
    });
  return out;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

export function timeTs(c: Case): number[] {
  for (let i = 0; i < Math.min(3, c.runs); i++) lintProse(c.text);
  const ms: number[] = [];
  for (let i = 0; i < c.runs; i++) {
    const t = performance.now();
    lintProse(c.text);
    ms.push(performance.now() - t);
  }
  return ms;
}

if (import.meta.main) {
  const cs = cases();
  const dir = mkdtempSync(join(tmpdir(), 'prose-speed-'));
  const file = join(dir, 'cases.json');
  writeFileSync(file, JSON.stringify(cs));
  const py = JSON.parse(
    execFileSync(
      'python3',
      [
        '-I',
        join(import.meta.dirname, 'speed_py.py'),
        file,
        ...(args.includes('--profile') ? ['--profile'] : []),
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    ),
  ) as Record<string, { ms: number[] }>;
  const rows = cs.map((c) => {
    const ts = timeTs(c);
    return {
      name: c.name,
      chars: c.text.length,
      tsMs: median(ts),
      pyMs: median(py[c.name]!.ms),
      tsWorst: Math.max(...ts),
      pyWorst: Math.max(...py[c.name]!.ms),
    };
  });
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(
      'case'.padEnd(52),
      'chars'.padStart(8),
      'ts ms'.padStart(9),
      'py ms'.padStart(9),
      'ts/100k'.padStart(9),
      'py/100k'.padStart(9),
    );
    for (const r of rows)
      console.log(
        r.name.padEnd(52),
        String(r.chars).padStart(8),
        r.tsMs.toFixed(2).padStart(9),
        r.pyMs.toFixed(2).padStart(9),
        ((r.tsMs * 1e5) / r.chars).toFixed(2).padStart(9),
        ((r.pyMs * 1e5) / r.chars).toFixed(2).padStart(9),
      );
    const prose = rows.filter((r) => r.name.startsWith('prose'));
    const per = (k: 'tsMs' | 'pyMs') =>
      median(prose.filter((r) => r.chars > 50_000).map((r) => (r[k] * 1e5) / r.chars));
    console.log(
      `\nMedian ms per 100k characters (the 100k and 1M inputs): ts ${per('tsMs').toFixed(2)}, py ${per('pyMs').toFixed(2)}`,
    );
    const att = rows.filter((r) => r.name.startsWith('attack'));
    const worst = (k: 'tsMs' | 'pyMs') =>
      att.reduce((a, r) => (r[k] > a.v ? { n: r.name, v: r[k] } : a), { n: '', v: 0 });
    console.log(
      `Worst adversarial case (200k chars): ts ${worst('tsMs').v.toFixed(0)} ms (${worst('tsMs').n}), py ${worst('pyMs').v.toFixed(0)} ms (${worst('pyMs').n})`,
    );
  }

  if (args.includes('--profile')) {
    const big = cs.find((c) => c.profile)!;
    const session = new inspector.Session();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.setSamplingInterval', { interval: 100 });
    session.post('Profiler.start');
    for (let i = 0; i < 10; i++) lintProse(big.text);
    session.post('Profiler.stop', (_e, { profile }) => {
      const self = new Map<string, number>();
      const dt = profile.timeDeltas;
      const idx = new Map(profile.nodes.map((n) => [n.id, n]));
      profile.samples!.forEach((id, i) => {
        const n = idx.get(id)!;
        const where = n.callFrame.url.split('/').pop() ?? '';
        const lines = n.positionTicks?.map((t) => `${where}:${t.line}`) ?? [
          `${n.callFrame.functionName || '(anon)'} ${where}`,
        ];
        const key = lines.length === 1 ? lines[0]! : `${n.callFrame.functionName} ${where}`;
        self.set(key, (self.get(key) ?? 0) + (dt?.[i] ?? 0));
      });
      const total = [...self.values()].reduce((a, b) => a + b, 0);
      console.log('\nWhere the TypeScript engine spends its time (100k realistic characters, own time):');
      for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14))
        console.log(`  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
    });
  }
}
