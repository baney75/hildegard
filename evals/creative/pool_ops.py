# SPDX-License-Identifier: AGPL-3.0-only
"""pool_ops.py <results-a.json> <results-b.json> ...: pools replicates of the same ops baseline (run_ops.sh with a different EVAL_DIR each)
and prints, per arm and model, how many runs passed every check, how many broke a safety rule, the checks passed, and the failed checks
with how many runs each failed in. One response per task, arm and model is a small sample; two or three replicates show how much of a gap is noise."""
import collections, json, sys

files = [json.load(open(p)) for p in sys.argv[1:]]
base, cand, models = files[0]['base'], files[0]['cand'], files[0]['models']
P = print
P(f'{len(files)} replicate(s), {len(files[0]["tasks"])} tasks each: ' + ', '.join(files[0]['tasks']))
rows = {}
for arm in (base, cand):
    for m in models + ['all']:
        runs = [r['score'] for f in files for mm, by in f['runs'][arm].items() if m in (mm, 'all') for r in by.values() if r['score']]
        rows[(arm, m)] = runs
P(f'\n{"arm":<6}{"model":<7}{"runs":>5}{"all checks":>12}{"safety broken":>15}{"checks passed":>16}')
for (arm, m), runs in rows.items():
    P(f'{arm:<6}{m:<7}{len(runs):>5}{sum(r["success"] for r in runs):>12}{sum(bool(r["safety_failed"]) for r in runs):>15}{sum(r["passed"] for r in runs):>9}/{sum(r["total"] for r in runs)}')
P('\nPer task (pooled over replicates): runs that passed every check / runs, and runs that broke a safety rule')
P(f'{"task":<24}{"model":<7}{base:>16}{cand:>16}')
for t in files[0]['tasks']:
    for m in models:
        cell = []
        for arm in (base, cand):
            s = [f['runs'][arm][m][t]['score'] for f in files]
            cell.append(f'{sum(x["success"] for x in s)}/{len(s)} (safety {sum(bool(x["safety_failed"]) for x in s)})')
        P(f'{t:<24}{m:<7}{cell[0]:>16}{cell[1]:>16}')
wins = {m: collections.Counter() for m in models}
rank = lambda s: (int(s['success']), int(not s['safety_failed']), s['passed'] / max(1, s['total']))
for f in files:
    for m in models:
        for t in f['tasks']:
            a, b = rank(f['runs'][cand][m][t]['score']), rank(f['runs'][base][m][t]['score'])
            wins[m]['cand' if a > b else 'base' if b > a else 'tie'] += 1
P('\nWin counts over every (replicate, task) pair: ' + '; '.join(f'{m}: {cand} {w["cand"]}, {base} {w["base"]}, tie {w["tie"]}' for m, w in wins.items()))
for arm in (cand, base):
    c = collections.defaultdict(list)
    for f in files:
        for m, by in f['runs'][arm].items():
            for t, r in by.items():
                for k, v in (r['score'].get('checks') or {}).items():
                    if not v:
                        c[k].append((m, t, r['score'].get('notes', {}).get(k, '')))
    P(f'\nFailed checks in the {arm} arm, most common first:')
    for k, v in sorted(c.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        P(f'  {k}: {len(v)} run(s)  e.g. {v[0][0]} {v[0][1]}: {v[0][2][:170]}')
