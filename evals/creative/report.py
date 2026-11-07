# SPDX-License-Identifier: AGPL-3.0-only
"""report.py <label> [--base none] [--cand main] [--models haiku luna] [--tasks tasks.json ...] [--out results-<label>.json]

Collects every run's metadata and score and every cached verdict into results-<label>.json, prints the summary tables, and
writes a contact sheet of every design (all arms and models) to $EVAL_DIR/contact-sheet-<label>.png."""
import json, os, sys
from judge import vals
HERE = os.path.dirname(os.path.abspath(__file__))
E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
DROP = {'log_tail', 'lint_hits'}


def main():
    a = sys.argv[1:]
    label = a[0]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    base, cand = opt('--base', 'none'), opt('--cand', 'main')
    models = vals(a, '--models') or ['haiku', 'luna']
    paths = vals(a, '--tasks') or [os.path.join(HERE, 'tasks.json')]
    tasks = [t for p in paths for t in json.load(open(p))]
    arms = [base, cand]
    runs, verdicts = {}, []
    for arm in arms:
        for m in models:
            for t in tasks:
                rd = os.path.join(E, 'runs', arm, m, t['id'])
                meta = json.load(open(os.path.join(rd, 'meta.json'))) if os.path.exists(os.path.join(rd, 'meta.json')) else {}
                sc = json.load(open(os.path.join(rd, 'score.json'))) if os.path.exists(os.path.join(rd, 'score.json')) else {}
                runs.setdefault(arm, {}).setdefault(m, {})[t['id']] = {'meta': meta, 'score': {k: v for k, v in sc.items() if k not in DROP}}
    tasks = [t for t in tasks if any(runs[arm][m][t['id']]['meta'] for arm in arms for m in models)]
    for m in models:
        for t in tasks:
            for o in (0, 1):
                p = os.path.join(E, 'judge', label, m, t['id'], f'order{o}.json')
                if os.path.exists(p):
                    verdicts.append(json.load(open(p)))
    summary = {}
    for v in verdicts:
        s = summary.setdefault(v['domain'], {}).setdefault(v['model'], {'cand': 0, 'base': 0, 'tie': 0, 'n': 0, 'auto': 0, 'tasks_won': 0, 'tasks_lost': 0})
        s['n'] += 1
        s['auto'] += bool(v['auto'])
        s['cand' if v['winner'] == cand else 'base' if v['winner'] == base else 'tie'] += 1
    for d, by in summary.items():
        for m, s in by.items():
            s['cand_rate'] = round((s['cand'] + 0.5 * s['tie']) / s['n'], 2)
            for t in {v['task'] for v in verdicts if v['domain'] == d and v['model'] == m}:
                w = [v['winner'] for v in verdicts if v['task'] == t and v['model'] == m]
                s['tasks_won'] += w.count(cand) == len(w) and len(w) == 2
                s['tasks_lost'] += w.count(base) == len(w) and len(w) == 2
    skill = {arm: {m: [sum(1 for r in runs[arm][m].values() if r['meta'].get('skill_loaded')), sum(1 for r in runs[arm][m].values() if r['meta'])] for m in models} for arm in arms}
    # Which skills each arm's responses were made with (the hash of the skills folder, recorded per run; older runs have none).
    hashes = {arm: {} for arm in arms}
    for arm in arms:
        for m in models:
            for t in tasks:
                h = runs[arm][m][t['id']]['meta'].get('skills_hash') if runs[arm][m][t['id']]['meta'] else None
                hashes[arm][h or 'unrecorded'] = hashes[arm].get(h or 'unrecorded', 0) + 1
    unfinished = sum(1 for v in verdicts if v.get('unfinished'))
    out = {'label': label, 'base': base, 'cand': cand, 'models': models, 'tasks': [t['id'] for t in tasks], 'summary': summary, 'skill_loaded': skill, 'skills_hash': hashes, 'unfinished_verdicts': unfinished, 'runs': runs, 'verdicts': verdicts}
    path = opt('--out', os.path.join(HERE, f'results-{label}.json'))
    json.dump(out, open(path, 'w'), indent=1)

    P = print
    P(f'\n== {label}: {cand} vs {base}, one response per task, both judge orders ==\n')
    P('Per domain (verdicts = tasks x 2 orders; rate counts a tie as half; "won"/"lost" = both orders agree)')
    P(f'{"domain":<10} {"model":<6} {cand+" wins":>9} {base+" wins":>9} {"ties":>5} {"n":>3} {"rate":>6}  won/lost tasks  (auto)')
    for d in ('design', 'video', 'audio', 'writing', 'videoedit', 'logo', 'brand', 'app'):
        for m in models:
            s = summary.get(d, {}).get(m)
            if s:
                P(f'{d:<10} {m:<6} {s["cand"]:>9} {s["base"]:>9} {s["tie"]:>5} {s["n"]:>3} {s["cand_rate"]:>6.2f}  {s["tasks_won"]}/{s["tasks_lost"]}            ({s["auto"]})')
    if unfinished:
        P(f'{unfinished} of {len(verdicts)} verdicts had an arm whose responder did not finish (timed out or died): no usable deliverable, scored and judged as none.')
    allv = {m: [v for v in verdicts if v['model'] == m] for m in models}
    for m in models:
        n = len(allv[m])
        if n:
            c = sum(v['winner'] == cand for v in allv[m]) + 0.5 * sum(v['winner'] == 'tie' for v in allv[m])
            P(f'{"all":<10} {m:<6} {cand} rate {c / n:.2f} over {n} verdicts')
    P('\nSkills used (hash of the skills folder -> responses; "unrecorded" = made before runs recorded it; none = no skills):')
    for arm in arms:
        P('  ' + arm + ': ' + ', '.join(f'{h[:12]} x{n}' for h, n in sorted(hashes[arm].items())))
    P('\nCouncil run (runs that tallied a council / runs; critic subagents started):')
    for arm in arms:
        P('  ' + arm + ': ' + ', '.join(f'{m} {sum(1 for r in runs[arm][m].values() if r["meta"].get("council_ran"))}/{sum(1 for r in runs[arm][m].values() if r["meta"])}'
                                         f' ({sum(r["meta"].get("subagents", 0) for r in runs[arm][m].values())} subagents)' for m in models))
    P('\nSkill loaded (runs where the responder loaded or read a Hildegard skill / runs):')
    for arm in arms:
        P('  ' + arm + ': ' + ', '.join(f'{m} {x[0]}/{x[1]}' for m, x in skill[arm].items()))

    P('\nAudio, objective (each script re-run here; checks passed/total):')
    P(f'{"task":<17} {"model":<6} {"arm":<5} {"ran":>3} {"LUFS":>6} {"TP":>6} {"checks":>7}  key metrics')
    for t in tasks:
        if t['domain'] != 'audio':
            continue
        for m in models:
            for arm in arms:
                s = runs[arm][m][t['id']]['score']
                key = ', '.join(f'{k}={s[k]}' for k in ('hum_prom_out_db', 'pause_gap_out_db', 'fidelity_out', 'duck_db', 'vmr_db', 'voice_fidelity', 'sting_at') if s.get(k) is not None)
                P(f'{t["id"]:<17} {m:<6} {arm:<5} {"y" if s.get("ran") else "n":>3} {s.get("lufs", "-")!s:>6} {s.get("tp", "-")!s:>6} {str(s.get("passed", 0)) + "/" + str(s.get("total", 0)):>7}  {key}')
    P('\nVideo edit, objective:')
    for t in tasks:
        if t['domain'] != 'videoedit':
            continue
        for m in models:
            for arm in arms:
                s = runs[arm][m][t['id']]['score']
                bad = [k for k, v in s.get('checks', {}).items() if not v]
                P(f'{t["id"]:<14} {m:<6} {arm:<5} ran={s.get("ran")} dur={s.get("dur")} cuts={s.get("scene_changes")}/{s.get("source_switches")} lufs={s.get("lufs")} black={s.get("black_segments")} passed {s.get("passed", 0)}/{s.get("total", 0)}  failed: {bad}')
    P('\nWriting, objective and judged (prose lint fails / warns per draft; invented facts per draft from the judge):')
    for m in models:
        for arm in arms:
            ws = [runs[arm][m][t['id']]['score'] for t in tasks if t['domain'] == 'writing']
            inv = [len(v['invented'].get(arm, [])) for v in verdicts if v['model'] == m and v['domain'] == 'writing' and not v['auto']]
            if ws:
                P(f'  {m:<6} {arm:<5} lint fails {sum(w.get("fails", 0) for w in ws)}, warns {sum(w.get("warns", 0) for w in ws)} over {len(ws)} drafts; '
                  f'invented facts {sum(inv)} over {len(inv)} judgments ({sum(inv) / len(inv):.1f} each)' if inv else f'  {m:<6} {arm:<5} lint fails {sum(w.get("fails", 0) for w in ws)}, warns {sum(w.get("warns", 0) for w in ws)}')
    P('\nLogo, brand and app, measured (each arm\'s files through the skills\' own checkers; lower is better except where noted):')
    keys = {'logo': ('fails', 'hairlines', 'embroidery', 'one-color', 'live_text', 'has_sheet'),
            'brand': ('json_ok', 'one_page', 'contrast_fails', 'clipped', 'placeholder'),
            'app': ('fails', 'contrast_fails', 'small_targets', 'clipped', 'overflow', 'states_delivered')}
    for t in tasks:
        if t['domain'] not in keys:
            continue
        for m in models:
            for arm in arms:
                sc = runs[arm][m][t['id']]['score']
                P(f'  {t["id"]:<22} {m:<6} {arm:<9} ' + ', '.join(f'{k}={sc.get(k)}' for k in keys[t['domain']]))
    for d in ('design', 'video', 'logo', 'brand', 'app'):
        for m in models:
            for arm in arms:
                inv = [len(v['invented'].get(arm, [])) for v in verdicts if v['model'] == m and v['domain'] == d and not v['auto']]
                if inv:
                    P(f'  {d} {m:<6} {arm:<5} invented facts {sum(inv)} over {len(inv)} judgments ({sum(inv) / len(inv):.1f} each)')
    contact(label, tasks, arms, models)


def contact(label, tasks, arms, models):
    for d in ('logo', 'brand', 'app'):
        contact_for(label, [t for t in tasks if t['domain'] == d], arms, models, {'logo': 'logo-sheet.png', 'brand': 'guide.png', 'app': 'screens.png'}[d], d)
    contact_for(label, [t for t in tasks if t['domain'] == 'design'], arms, models, 'design.png', 'design')


def contact_for(label, ds, arms, models, pic, dom):
    from PIL import Image, ImageDraw
    if not ds:
        return
    cols = [(arm, m) for m in models for arm in arms]
    H, pad, head = 520, 12, 34
    cells, widths = {}, {}
    for t in ds:
        for arm, m in cols:
            p = os.path.join(E, 'runs', arm, m, t['id'], pic)
            im = Image.open(p).convert('RGB') if os.path.exists(p) else None
            if im:
                im = im.resize((max(1, int(im.width * H / im.height)), H))
            cells[(t['id'], arm, m)] = im
    colw = [max([(cells[(t['id'], a, m)].width if cells[(t['id'], a, m)] else 380) for t in ds]) for a, m in cols]
    W = sum(colw) + pad * (len(cols) + 1)
    sheet = Image.new('RGB', (W, head + (H + pad + 18) * len(ds) + pad), (24, 24, 24))
    dr = ImageDraw.Draw(sheet)
    x = pad
    for (arm, m), w in zip(cols, colw):
        dr.text((x, 10), f'{m} / {arm}', fill=(255, 255, 255))
        x += w + pad
    for r, t in enumerate(ds):
        y = head + r * (H + pad + 18)
        x = pad
        for (arm, m), w in zip(cols, colw):
            im = cells[(t['id'], arm, m)]
            if im:
                sheet.paste(im, (x, y + 16))
            else:
                dr.rectangle([x, y + 16, x + w, y + 16 + H], outline=(120, 40, 40))
                dr.text((x + 10, y + 30), 'no usable output', fill=(200, 80, 80))
            dr.text((x, y), t['id'], fill=(170, 170, 170))
            x += w + pad
    p = os.path.join(E, f'contact-sheet-{label}{"" if dom == "design" else "-" + dom}.png')
    sheet.save(p)
    print(f'\n{dom.capitalize()} contact sheet:', p)


if __name__ == '__main__':
    main()
