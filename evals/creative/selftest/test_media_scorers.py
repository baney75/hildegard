# SPDX-License-Identifier: AGPL-3.0-only
"""Selftest for the media scorers: python3 evals/creative/selftest/test_media_scorers.py [photoedit sound photocreate video]

Each domain gets a reference (an oracle that knows what was done to the inputs, or a plain competent script) that must pass every
check, and controls that must fail the checks they should: a pass-through photo, a pure sine for a chime or a page turn, plain
white noise for rain, noise for music, a blank picture, a static video, a black one, and a video with an invented date and
number. Needs the pinned photos (downloaded once to $EVAL_DIR/photos), ffmpeg, tesseract, Playwright's Chromium; takes a few
minutes. Exit 1 on any miss."""
import json, os, shutil, sys, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
CREATIVE = os.path.dirname(HERE)
sys.path.insert(0, CREATIVE)
import make_media, score_media

M = os.path.join(HERE, 'media')
TASKS = {t['id']: t for f in ('tasks-media.json', 'heldout-media.json') for t in json.load(open(os.path.join(CREATIVE, f)))}
CENTER = {'p1-retreat-hero': (0.5, 0.45), 'p2-farm-stand': (0.62, 0.5), 'p3-barn-card': (0.8, 0.5), 'p4-bakery-shelf': (0.65, 0.55), 'p5-sanctuary-cover': (0.33, 0.4)}
TONIC = {'G': 7, 'A': 9, 'F': 5, 'Eb': 3}
bad = []


def fill(text, **kv):
    for k, v in kv.items():
        text = text.replace(k, str(v))
    return text


def check(name, res, must_pass_all=False, must_fail=()):
    failed = [k for k, v in res['checks'].items() if not v]
    ok = (not failed) if must_pass_all else all(k in failed for k in must_fail)
    print(('ok   ' if ok else 'FAIL ') + name, f"{res['passed']}/{res['total']}", 'failed:', failed, res.get('score_error', ''), '' if res.get('ran', True) else res.get('log_tail', ''))
    if not ok:
        bad.append(name)


def run(domain_fn, task, files):
    work, runf = tempfile.mkdtemp(), tempfile.mkdtemp()
    for name, text in files.items():
        open(os.path.join(work, name), 'w').write(text)
    try:
        return domain_fn(task, work, runf)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        shutil.rmtree(runf, ignore_errors=True)


def photoedit():
    oracle = open(os.path.join(M, 'photo_oracle.py.tmpl')).read()
    plain = open(os.path.join(M, 'photo_passthrough.py')).read()
    for tid, t in TASKS.items():
        if t['domain'] != 'photoedit':
            continue
        make_media.build(t)
        ops, size = t['media']['ops'], t['score']['size']
        o = fill(oracle, __OPS__=repr(ops), __SIZE__=repr(tuple(size)), __CENTER__=repr(CENTER[tid]), __Q__=80)
        check(f'{tid} oracle', run(score_media.photoedit, t, {'process.py': o}), must_pass_all=True)
        must = ['white_balance'] if 'cast' in ops else []
        must += ['exposure'] if ('stops' in ops and abs(ops['stops']) >= 0.8) else []
        must += ['straight'] if ops.get('tilt') else []
        must += ['denoised'] if ops.get('noise') else []
        check(f'{tid} pass-through (fixes nothing)', run(score_media.photoedit, t, {'process.py': fill(plain, __SIZE__=repr(tuple(size)))}), must_fail=must)


def sound():
    def f(name):
        return open(os.path.join(M, name)).read()
    cases = [('s1-ui-chime', 'sfx_chime.py', True, ()), ('s1-ui-chime', 'sfx_sine.py', False, ('rising_steps',)), ('s2-page-turn', 'sfx_page.py', True, ()),
             ('s2-page-turn', 'sfx_sine.py', False, ('noisy', 'no_tonal_peak')), ('s3-rain-tin-roof', 'sfx_rain.py', True, ()), ('s3-rain-tin-roof', 'sfx_white30.py', False, ('droplets',)),
             ('s4-title-whoosh', 'sfx_whoosh.py', True, ()), ('s4-title-whoosh', 'sfx_sine.py', False, ('noisy', 'centroid_arc')), ('s5-shop-bell', 'sfx_bell.py', True, ())]
    for tid, fn, good, must in cases:
        check(f'{tid} {fn}', run(score_media.sound, TASKS[tid], {'make.py': f(fn)}), must_pass_all=good, must_fail=must)
    for tid in ('m1-church-announce', 'm2-shop-promo', 'm3-podcast-intro', 'm4-radio-jingle', 'm5-memorial-bed'):
        sc = TASKS[tid]['score']
        root, mode = sc['key'].split()
        s = fill(f('music_ref.py.tmpl'), __BPM__=sc['bpm'], __TONIC__=TONIC[root], __MODE__=mode, __DUR__=sc['dur'], __LUFS__=sc['lufs'], __DRUMS__=sc['bpm'] >= 100)
        check(f'{tid} reference', run(score_media.sound, TASKS[tid], {'make.py': s}), must_pass_all=True)
    check('m1-church-announce noise', run(score_media.sound, TASKS['m1-church-announce'], {'make.py': f('music_noise.py')}), must_fail=('tempo', 'key', 'no_hard_cut'))


def photocreate():
    t = TASKS['c3-soup-card']
    W, H = t['size']
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"><rect width="{W}" height="{H}" fill="#3b2a24"/><rect y="640" width="{W}" height="360" fill="#8a5a3a"/>'
           f'<rect x="900" y="80" width="460" height="380" fill="#9fb4c8"/><circle cx="500" cy="660" r="190" fill="#f3e4c9"/><ellipse cx="500" cy="640" rx="170" ry="60" fill="#c8432f"/></svg>')
    check('c3 svg reference', run(score_media.photocreate, t, {'art.svg': svg}), must_pass_all=True)
    py = f"from PIL import Image, ImageDraw\nim = Image.new('RGB', ({W}, {H}), (30, 60, 40)); ImageDraw.Draw(im).ellipse((300, 200, 1200, 800), fill=(240, 200, 90)); im.save('art.png')\n"
    check('c3 python reference', run(score_media.photocreate, t, {'make.py': py}), must_pass_all=True)
    check('c3 blank', run(score_media.photocreate, t, {'art.svg': f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}"><rect width="100%" height="100%" fill="#fff"/></svg>'}), must_fail=('not_blank',))
    check('c3 network image', run(score_media.photocreate, t, {'art.svg': svg.replace('<rect width', '<image href="https://example.com/x.png" width="9" height="9"/><rect width', 1)}), must_fail=('no_network_refs',))


def video():
    if not shutil.which('tesseract'):
        print('skip video: tesseract is not installed')
        return

    def script(tmpl, t, extra=()):
        sc = t['score']
        d = (sc['dur'][0] + sc['dur'][1]) / 2
        return fill(open(os.path.join(M, tmpl)).read(), __SIZE__=repr(tuple(sc['size'])), __DUR__=d, __LINES__=repr(list(sc['lines']) + list(extra)),
                    __IMAGES__=repr(sc.get('images', [])), __W__=sc['size'][0], __H__=sc['size'][1])
    for tid in ('v1-pancake-promo', 'v2-verse-card', 'v3-pantry-reveal', 'v4-csa-slideshow', 'v5-save-the-date'):
        t = TASKS[tid]
        make_media.build(t)
        check(f'{tid} reference', run(score_media.codevideo, t, {'make.py': script('video_ref.py.tmpl', t)}), must_pass_all=True)
    t = TASKS['v1-pancake-promo']
    check('v1 static', run(score_media.codevideo, t, {'make.py': script('video_static.py.tmpl', t)}), must_fail=('not_static',))
    check('v1 black', run(score_media.codevideo, t, {'make.py': script('video_black.py.tmpl', t)}), must_fail=('no_black_over_half_second', 'every_line_present'))
    t = TASKS['v3-pantry-reveal']  # the smaller canvas: the 1080 x 1920 reference can pass the time limit on a busy machine
    check('v3 invented date and number', run(score_media.codevideo, t, {'make.py': script('video_ref.py.tmpl', t, ('Saturday, April 19', 'Call 555 0142'))}), must_fail=('no_extra_numbers_or_dates',))


if __name__ == '__main__':
    which = sys.argv[1:] or ['photoedit', 'sound', 'photocreate', 'video']
    for w in which:
        {'photoedit': photoedit, 'sound': sound, 'photocreate': photocreate, 'video': video}[w]()
    print('\n' + ('all media scorer checks behaved' if not bad else f'{len(bad)} did not: {bad}'))
    sys.exit(1 if bad else 0)
