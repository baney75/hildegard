#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""council.py: the design council's paperwork, so the critics stay blind and the tally is arithmetic, not mood.

  python3 council.py roles [--medium logo]
  python3 council.py brief --role typographer --medium logo --brief brief.md --render sheet.png [--render more.png]
                           [--round 1] [--dir council]
  python3 council.py shuffle a.png b.png [--dir council/variants]
  python3 council.py unblind [--dir council/variants]
  python3 council.py tally [--round 1] [--dir council]

brief    prints one critic's whole prompt (its rubric for the medium, the brief, the render paths, the reply shape) and
         saves it as <dir>/r<round>/prompts/<role>.txt. Give that text, and nothing else, to a fresh agent; it writes
         its review to <dir>/r<round>/<role>.json.
shuffle  copies two variants to A and B in a random order, so critics can't tell which is which; the key stays in
         <dir>/.key.json until unblind.
tally    reads every review of a round, checks its shape, and writes tally.md and tally.json: the scores, the hard
         fails, the areas two or more critics flagged (the must-fix list), and whether a second round is due.

Standard library only. The rubrics live in ../references/rubrics.md, beside this script."""
import argparse, json, os, random, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUBRICS = os.path.join(HERE, '..', 'references', 'rubrics.md')
ROLES = {
    'art-director': 'Art director',
    'typographer': 'Typographer',
    'brand-strategist': 'Brand strategist',
    'legibility': 'Legibility and access',
    'customer': 'The customer',
    'production': 'Production',
}
MEDIA = ('logo', 'brand', 'screen', 'page', 'image', 'motion')
AREAS = {'concept', 'mark', 'wordmark', 'lockup', 'type', 'color', 'contrast', 'small-size', 'layout', 'copy', 'imagery',
         'states', 'platform', 'production', 'motion', 'sound'}
HARD = {
    'art-director': {'cliche', 'two-ideas', 'off-brief'},
    'typographer': {'misspelled', 'colliding', 'live-text'},
    'brand-strategist': {'invented-copy', 'lookalike', 'wrong-audience'},
    'legibility': {'illegible', 'broken-small', 'low-contrast', 'tiny-targets'},
    'customer': {'confusing', 'untrustworthy'},
    'production': {'needs-gradient', 'hairlines', 'unlicensed-font', 'missing-deliverable'},
}
MAX_ROUNDS = 2


def sections():
    """{role title: (common text, {medium heading: text})} parsed from rubrics.md."""
    text = open(RUBRICS, encoding='utf-8').read()
    out = {}
    for block in re.split(r'^## ', text, flags=re.M)[1:]:
        title, _, body = block.partition('\n')
        parts = re.split(r'^### ', body, flags=re.M)
        media = {}
        for p in parts[1:]:
            head, _, txt = p.partition('\n')
            media[head.strip()] = txt.strip()
        out[title.strip()] = (parts[0].strip(), media)
    preamble = text.split('\n## ', 1)[0]
    return preamble, out


def rubric(role, medium):
    preamble, secs = sections()
    common, media = secs[ROLES[role]]
    extra = next((t for h, t in media.items() if medium in [x.strip() for x in h.split(',')]), '')
    rules = preamble.split('How every critic scores, whatever the role:', 1)[-1].strip()
    criteria = re.findall(r'^\| ([^|]+?) \| [^|]+ \| [^|]+ \| [^|]+ \|$', common, flags=re.M)
    criteria = [c for c in criteria if c not in ('Criterion', '---')]
    return rules, common, extra, criteria


def cmd_roles(a):
    for k, v in ROLES.items():
        print(f'{k:<17} {v}')
    print('\nEvery medium uses all six. Media:', ', '.join(MEDIA))


def cmd_brief(a):
    if a.role not in ROLES:
        sys.exit(f'role must be one of: {", ".join(ROLES)}')
    if a.medium not in MEDIA:
        sys.exit(f'medium must be one of: {", ".join(MEDIA)}')
    brief = open(a.brief, encoding='utf-8').read().strip() if os.path.exists(a.brief) else a.brief
    renders = [os.path.abspath(r) for r in a.render]
    missing = [r for r in renders if not os.path.exists(r)]
    if missing:
        sys.exit('no such render: ' + ', '.join(missing))
    rules, common, extra, criteria = rubric(a.role, a.medium)
    rd = os.path.join(a.dir, f'r{a.round}')
    review = os.path.abspath(os.path.join(rd, f'{a.role}.json'))
    shape = {
        'role': a.role,
        'scores': {c: '1-5' for c in criteria},
        'overall': '1-5',
        'hard_fails': [{'kind': '|'.join(sorted(HARD[a.role])), 'where': 'the element', 'fix': 'the exact change'}],
        'fixes': [{'area': 'one of the areas', 'fix': 'the element and the exact change', 'must': True}],
        'verdict': 'one sentence',
    }
    prompt = f"""You are the {ROLES[a.role]} on a design council. You are one critic of six. You have not seen and will not see
any other critic's notes, and you must not look for them. Judge only what is in front of you: the brief and the render.

THE BRIEF (the client's own words; anything on the work that is not supported here is invented):
{brief}

THE RENDER{'S' if len(renders) > 1 else ''} (open and look at each one at full size before you write anything):
{chr(10).join('- ' + r for r in renders)}

HOW TO SCORE:
{rules}

YOUR RUBRIC ({ROLES[a.role]}):
{common}

FOR THIS MEDIUM ({a.medium}):
{extra or 'Use the rubric as written.'}

Hard fails you may call (and only these): {', '.join(sorted(HARD[a.role]))}. Leave hard_fails empty when there is none.

WRITE your review as JSON, and nothing else, to {review}
Shape (replace every value; scores are integers 1 to 5; "must": true marks a fix you think the designer has to make):
{json.dumps(shape, indent=1)}
Then reply with the single line: done {a.role}"""
    os.makedirs(os.path.join(rd, 'prompts'), exist_ok=True)
    open(os.path.join(rd, 'prompts', f'{a.role}.txt'), 'w', encoding='utf-8').write(prompt)
    print(prompt)


def cmd_shuffle(a):
    if len(a.files) != 2:
        sys.exit('give exactly two files to compare')
    os.makedirs(a.dir, exist_ok=True)
    order = list(a.files)
    random.SystemRandom().shuffle(order)
    key = {}
    for tag, src in zip('AB', order):
        ext = os.path.splitext(src)[1]
        dst = os.path.join(a.dir, tag + ext)
        shutil.copy(src, dst)
        key[tag] = os.path.abspath(src)
    json.dump(key, open(os.path.join(a.dir, '.key.json'), 'w'), indent=1)
    print(f'A and B are in {a.dir}. Show critics only those two files. Run unblind after the tally.')


def cmd_unblind(a):
    key = json.load(open(os.path.join(a.dir, '.key.json')))
    for tag, src in key.items():
        print(f'{tag} = {src}')


def check_review(d, role):
    """Problems with one review's shape, as strings."""
    bad = []
    criteria = rubric(role, 'logo')[3]
    sc = d.get('scores')
    if not isinstance(sc, dict) or not sc:
        bad.append('no scores')
    else:
        for k, v in sc.items():
            if not isinstance(v, int) or not 1 <= v <= 5:
                bad.append(f'score {k!r} is {v!r}, not an integer 1 to 5')
        gone = [c for c in criteria if c not in sc]
        if gone:
            bad.append('no score for ' + ', '.join(gone))
        low = [k for k, v in sc.items() if isinstance(v, int) and v < 4]
        if low and not d.get('fixes'):
            bad.append(f'scores under 4 ({", ".join(low)}) with no fixes')
    if not isinstance(d.get('overall'), int) or not 1 <= d['overall'] <= 5:
        bad.append('overall is not an integer 1 to 5')
    for h in d.get('hard_fails') or []:
        if h.get('kind') not in HARD[role]:
            bad.append(f'hard fail {h.get("kind")!r} is not one {ROLES[role]} may call')
    for f in d.get('fixes') or []:
        if f.get('area') not in AREAS:
            bad.append(f'fix area {f.get("area")!r} is not one of the areas')
        if len(str(f.get('fix', ''))) < 12:
            bad.append('a fix with no exact change')
    return bad


def cmd_tally(a):
    rd = os.path.join(a.dir, f'r{a.round}')
    reviews, problems = {}, []
    for role in ROLES:
        p = os.path.join(rd, f'{role}.json')
        if not os.path.exists(p):
            continue
        try:
            d = json.load(open(p, encoding='utf-8'))
        except ValueError as e:
            problems.append(f'{role}: not JSON ({e})')
            continue
        for b in check_review(d, role):
            problems.append(f'{role}: {b}')
        reviews[role] = d
    if not reviews:
        sys.exit(f'no reviews in {rd}: each critic writes <role>.json there')
    missing = [r for r in ROLES if r not in reviews]
    hard = [(r, h) for r, d in reviews.items() for h in d.get('hard_fails') or [] if h.get('kind') in HARD[r]]
    by_area = {}
    for r, d in reviews.items():
        for f in d.get('fixes') or []:
            by_area.setdefault(f.get('area'), []).append((r, f.get('fix', ''), bool(f.get('must'))))
    agreed = {k: v for k, v in by_area.items() if len({r for r, _, _ in v}) >= 2}
    overall = {r: d.get('overall') for r, d in reviews.items()}
    nums = [v for v in overall.values() if isinstance(v, int)]
    mean = round(sum(nums) / len(nums), 2) if nums else None
    lowest = min(nums) if nums else None
    if a.round >= MAX_ROUNDS:
        nxt = f'This was round {a.round}, the last. Fix the must-fix list if you can, then report the scores of every round.'
    elif hard or (lowest is not None and lowest <= 2):
        nxt = f'Round {a.round + 1} is due: make every must-fix change, render again, and run the council again with fresh critics.'
    else:
        nxt = 'No second round is needed: make the must-fix changes, check the render, and deliver with these scores.'
    lines = [f'# Council, round {a.round}', '']
    if missing:
        lines += [f'Missing reviews: {", ".join(missing)}. A council needs every role it named.', '']
    if problems:
        lines += ['Reviews with problems (send that critic its prompt again, fresh):'] + [f'- {p}' for p in problems] + ['']
    lines += ['| Critic | ' + ' | '.join(['overall', 'scores']) + ' |', '| --- | --- | --- |']
    for r, d in reviews.items():
        sc = ', '.join(f'{k} {v}' for k, v in (d.get('scores') or {}).items())
        lines.append(f'| {ROLES[r]} | {d.get("overall")} | {sc} |')
    lines += ['', f'Mean overall {mean}, lowest {lowest}.', '', '## Must fix', '']
    n = 0
    for r, h in hard:
        n += 1
        lines.append(f'{n}. HARD FAIL {h.get("kind")} ({ROLES[r]}): {h.get("where", "")}. Fix: {h.get("fix", "")}')
    for area, items in sorted(agreed.items(), key=lambda kv: -len(kv[1])):
        n += 1
        who = sorted({ROLES[r] for r, _, _ in items})
        lines.append(f'{n}. {area}, flagged by {len(who)} critics ({", ".join(who)}):')
        lines += [f'   - {ROLES[r]}: {fx}' for r, fx, _ in items]
    if n == 0:
        lines.append('Nothing: no hard fail, and no area flagged by two critics.')
    rest = [(area, r, fx) for area, items in by_area.items() if area not in agreed for r, fx, _ in items]
    if rest:
        lines += ['', '## One critic each (your call)', ''] + [f'- {area} ({ROLES[r]}): {fx}' for area, r, fx in rest]
    lines += ['', '## Next', '', nxt]
    md = '\n'.join(lines) + '\n'
    open(os.path.join(rd, 'tally.md'), 'w', encoding='utf-8').write(md)
    json.dump({'round': a.round, 'overall': overall, 'mean': mean, 'lowest': lowest,
               'hard_fails': [{'role': r, **h} for r, h in hard], 'agreed_areas': sorted(agreed), 'missing': missing,
               'problems': problems, 'next': nxt}, open(os.path.join(rd, 'tally.json'), 'w'), indent=1)
    print(md)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('roles')
    p.add_argument('--medium', default='logo')
    p = sub.add_parser('brief')
    p.add_argument('--role', required=True)
    p.add_argument('--medium', required=True)
    p.add_argument('--brief', required=True, help='a file with the brief, or the brief itself')
    p.add_argument('--render', action='append', required=True)
    p.add_argument('--round', type=int, default=1)
    p.add_argument('--dir', default='council')
    p = sub.add_parser('shuffle')
    p.add_argument('files', nargs='+')
    p.add_argument('--dir', default=os.path.join('council', 'variants'))
    p = sub.add_parser('unblind')
    p.add_argument('--dir', default=os.path.join('council', 'variants'))
    p = sub.add_parser('tally')
    p.add_argument('--round', type=int, default=1)
    p.add_argument('--dir', default='council')
    a = ap.parse_args()
    {'roles': cmd_roles, 'brief': cmd_brief, 'shuffle': cmd_shuffle, 'unblind': cmd_unblind, 'tally': cmd_tally}[a.cmd](a)


if __name__ == '__main__':
    main()
