# SPDX-License-Identifier: AGPL-3.0-only
"""report_ops.py <label> [--base none] [--cand main] [--models haiku luna] [--tasks tasks.json ...] [--out results-<label>.json]

Collects every ops run's metadata and score into results-<label>.json and prints: the per-task checks of both arms, the win counts
(a run beats another when it succeeded and the other did not, else when it passed more of its checks and broke no safety rule), and
the most common failed checks of the candidate arm with quotes. No judge model: every number comes from score_ops.py."""
import collections, json, os, re, sys
from opslib import CODE_RX
HERE = os.path.dirname(os.path.abspath(__file__))
E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))


def vals(a, k):
    if k not in a:
        return None
    out = []
    for x in a[a.index(k) + 1:]:
        if x.startswith('--'):
            break
        out.append(x)
    return out


def load(arm, model, tid):
    rd = os.path.join(E, 'runs', arm, model, tid)
    j = lambda n: json.load(open(os.path.join(rd, n))) if os.path.exists(os.path.join(rd, n)) else {}
    return {'meta': j('meta.json'), 'score': j('score.json'), 'dir': rd,
            'final': open(os.path.join(rd, 'final.txt'), errors='replace').read() if os.path.exists(os.path.join(rd, 'final.txt')) else ''}


def rank(s):
    """Higher is better: succeeded, then no safety rule broken, then the share of checks passed."""
    if not s:
        return (-1, -1, -1)
    return (int(s['success']), int(not s['safety_failed']), s['passed'] / max(1, s['total']))


def main():
    a = sys.argv[1:]
    label = a[0]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    base, cand = opt('--base', 'none'), opt('--cand', 'main')
    models = vals(a, '--models') or ['haiku', 'luna']
    paths = vals(a, '--tasks') or [os.path.join(HERE, 'tasks.json')]
    tasks = [t for p in paths for t in json.load(open(p)) if t['domain'] == 'ops']
    runs = {arm: {m: {t['id']: load(arm, m, t['id']) for t in tasks} for m in models} for arm in (base, cand)}
    tasks = [t for t in tasks if any(runs[arm][m][t['id']]['score'] for arm in (base, cand) for m in models)]

    wins = {m: {'cand': 0, 'base': 0, 'tie': 0} for m in models}
    for m in models:
        for t in tasks:
            rc, rb = rank(runs[cand][m][t['id']]['score']), rank(runs[base][m][t['id']]['score'])
            wins[m]['cand' if rc > rb else 'base' if rb > rc else 'tie'] += 1
    fails = collections.defaultdict(list)
    for m in models:
        for t in tasks:
            r = runs[cand][m][t['id']]
            for k, v in (r['score'].get('checks') or {}).items():
                if not v:
                    fails[k].append({'model': m, 'task': t['id'], 'note': r['score'].get('notes', {}).get(k, ''), 'answer': CODE_RX.sub('<join code>', r['final'][:300])})
    top = sorted(fails.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    out = {'label': label, 'base': base, 'cand': cand, 'models': models, 'tasks': [t['id'] for t in tasks], 'wins': wins,
           'top_failures': {k: v for k, v in top[:8]},
           'runs': {arm: {m: {tid: {'meta': r['meta'], 'score': r['score']} for tid, r in by.items()} for m, by in bm.items()} for arm, bm in runs.items()}}
    path = opt('--out', os.path.join(HERE, f'results-{label}.json'))
    json.dump(out, open(path, 'w'), indent=1)

    P = print
    P(f'\n== {label}: {cand} vs {base}, one response per task and model, scored from the worlds\' end state ==\n')
    P('Per task: checks passed of total (S = every check passed, safety = a safe_* check failed)')
    P(f'{"task":<24} {"model":<6} {base:>14} {cand:>14}')
    cell = lambda s: '(no run)' if not s else f"{s['passed']}/{s['total']}{' S' if s['success'] else ''}{' safety' if s['safety_failed'] else ''}"
    for t in tasks:
        for m in models:
            P(f'{t["id"]:<24} {m:<6} {cell(runs[base][m][t["id"]]["score"]):>14} {cell(runs[cand][m][t["id"]]["score"]):>14}')
    P('\nChecks per run (. pass, X fail):')
    for t in tasks:
        names = list(next((runs[arm][m][t['id']]['score']['checks'] for arm in (base, cand) for m in models if runs[arm][m][t['id']]['score']), {}))
        P(f'  {t["id"]}')
        for arm in (base, cand):
            for m in models:
                sc = runs[arm][m][t['id']]['score']
                if sc:
                    P(f'    {arm:<5} {m:<6} ' + ' '.join(f'{n}:{"." if sc["checks"].get(n) else "X"}' for n in names))
    P('\nWin counts (tasks where one arm beat the other):')
    for m in models:
        P(f'  {m}: {cand} {wins[m]["cand"]}, {base} {wins[m]["base"]}, tie {wins[m]["tie"]}')
    tot = {k: sum(wins[m][k] for m in models) for k in ('cand', 'base', 'tie')}
    P(f'  all: {cand} {tot["cand"]}, {base} {tot["base"]}, tie {tot["tie"]}')
    for arm in (base, cand):
        s = [r['score'] for m in models for r in runs[arm][m].values() if r['score']]
        if s:
            P(f'  {arm}: {sum(x["success"] for x in s)}/{len(s)} tasks fully passed, {sum(bool(x["safety_failed"]) for x in s)} broke a safety rule, '
              f'{sum(x["passed"] for x in s)}/{sum(x["total"] for x in s)} checks')
    P(f'\nMost common failed checks in the {cand} arm:')
    for k, v in top[:5]:
        P(f'  {k}: {len(v)} run(s)')
        for x in v[:2]:
            P(f'    {x["model"]} {x["task"]}: {x["note"] or "(no note)"}')
    for arm in (base, cand):
        rr = [(m, t['id']) for m in models for t in tasks if runs[arm][m][t['id']]['score'].get('real_file_reads')]
        if rr:
            P(f'  read files of the real Hildegard install ({arm}): ' + ', '.join(f'{m} {t}' for m, t in rr))
    for arm in (base, cand):
        sk = {m: [sum(1 for r in runs[arm][m].values() if r['meta'].get('skill_loaded')), sum(1 for r in runs[arm][m].values() if r['meta'])] for m in models}
        P(f'  skill loaded ({arm}): ' + ', '.join(f'{m} {a_}/{b_}' for m, (a_, b_) in sk.items()))


main()
