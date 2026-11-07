# SPDX-License-Identifier: AGPL-3.0-only
"""Objective scores for one run: score.py <task id> <run dir> [--tasks tasks.json heldout.json]

<run dir> holds work/ (the responder's folder). Writes <run dir>/score.json and, where the domain has one, the picture the
judge looks at: design.png (the HTML rendered by Playwright's Chromium) or sheet.png (frames of the edited video).

  design    renders at the stated size; checks that it drew something and loads nothing beyond Google Fonts
  writing   runs skills/hildegard/scripts/prose_lint.py on the draft (front matter removed): fails and warns
  video     the plan is judged by rubric only; here only its size is recorded
  audio     score_audio.py
  videoedit runs edit.sh in a copy of the clips under sandbox.py (no network, read-only filesystem); duration, size, fps, codecs, loudness, scene changes
            (ffmpeg scene score above 0.12), black stretches over half a second (blackdetect), which clips appear"""
import glob, json, os, re, shutil, subprocess, sys, tempfile
import numpy as np
from audiolib import SR
import score_audio as sa

E = sa.E
HERE = sa.HERE
ROOT = os.path.dirname(os.path.dirname(HERE))
LINT = os.path.join(ROOT, 'skills', 'hildegard', 'scripts', 'prose_lint.py')
FRONT = re.compile(r'\A﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\Z)')
DELIVERABLE = {'design': 'design.html', 'video': 'plan.md', 'audio': 'process.sh', 'writing': 'draft.md', 'videoedit': 'edit.sh',
               'logo': 'logo.svg', 'brand': 'guide.html', 'app': 'screen.html'}
BRAND_SCRIPTS = os.path.join(ROOT, 'skills', 'hildegard-brand', 'scripts')
APP_SCRIPTS = os.path.join(ROOT, 'skills', 'hildegard-app', 'scripts')
PLATFORM = lambda t: 'ios' if 'iOS' in t['platform'] else 'android' if 'Android' in t['platform'] else 'desktop'


def chromium():
    """Playwright's Chromium, never the Helium launcher on PATH."""
    env = os.environ.get('HILDEGARD_EVAL_CHROMIUM')
    if env:
        return env
    c = sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome')))
    if not c:
        raise SystemExit('no Playwright Chromium under ~/.cache/ms-playwright; run `npx playwright install chromium`')
    return c[-1]


GOOGLE_FONTS = ('fonts.googleapis.com', 'fonts.gstatic.com')


def render(html, png, w, h):
    """Render model HTML as untrusted: a throwaway profile and HOME, Chromium's own sandbox (dropped only if this machine cannot run
    it, which the return value says), and every request but Google Fonts sent to a dead proxy, loopback and IP addresses included.
    Returns {'sandbox': bool}."""
    base = tempfile.mkdtemp(prefix='creative-chromium-')
    env = {'PATH': '/usr/bin:/bin', 'HOME': base, 'XDG_CONFIG_HOME': base + '/config', 'XDG_CACHE_HOME': base + '/cache',
           'XDG_DATA_HOME': base + '/data', 'TMPDIR': base, 'DISPLAY': ''}
    try:
        for sandbox in (True, False):
            if os.path.exists(png):
                os.remove(png)
            subprocess.run([chromium(), '--headless=new'] + ([] if sandbox else ['--no-sandbox']) +
                           ['--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', f'--window-size={w},{h}',
                            '--virtual-time-budget=12000', f'--user-data-dir={base}/profile', '--proxy-server=socks5://127.0.0.1:9',
                            '--proxy-bypass-list=<-loopback>;' + ';'.join(GOOGLE_FONTS),
                            '--host-resolver-rules=MAP * ~NOTFOUND, ' + ', '.join('EXCLUDE ' + h for h in GOOGLE_FONTS),
                            f'--screenshot={png}', 'file://' + os.path.abspath(html)],
                           capture_output=True, timeout=120, env=env)
            if os.path.exists(png):
                return {'sandbox': sandbox}
        return {'sandbox': False}
    finally:
        shutil.rmtree(base, ignore_errors=True)


def png_size(png):
    from PIL import Image
    with Image.open(png) as im:
        return im.size


def design(task, work, run):
    f = os.path.join(work, 'design.html')
    res = {'deliverable': os.path.exists(f)}
    if not res['deliverable']:
        return res
    w, h = task['size']
    png = os.path.join(run, 'design.png')
    res['chromium_sandbox'] = render(f, png, w, h)['sandbox']
    res['rendered'] = os.path.exists(png)
    if res['rendered']:
        from PIL import Image
        im = Image.open(png).convert('RGB')
        res['png_size'] = list(im.size)
        if im.size != (w, h):  # the window can come out a little off; crop or pad to the asked size so the judge sees the real canvas
            canvas = Image.new('RGB', (w, h), (255, 255, 255))
            canvas.paste(im.crop((0, 0, min(w, im.size[0]), min(h, im.size[1]))), (0, 0))
            canvas.save(png)
            res['size_fixed'] = True
        a = np.asarray(Image.open(png).convert('RGB').resize((w // 8, h // 8)))
        res['pixel_std'] = round(float(a.std()), 1)
        res['colors'] = int(len(np.unique(a.reshape(-1, 3) // 16, axis=0)))
        res['blank'] = res['pixel_std'] < 4
    src = open(f, encoding='utf-8', errors='replace').read()
    urls = set(re.findall(r'(?:src|href)\s*=\s*["\'](https?://[^"\']+)|url\(\s*["\']?(https?://[^)"\']+)', src))
    ext = sorted({u for pair in urls for u in pair if u and not re.match(r'https?://fonts\.(googleapis|gstatic)\.com/', u)})
    res['external_refs'] = ext
    res['has_script'] = bool(re.search(r'<script\b', src, re.I))
    res['bytes'] = len(src)
    return res


def writing(task, work, run):
    f = os.path.join(work, 'draft.md')
    res = {'deliverable': os.path.exists(f)}
    if not res['deliverable']:
        return res
    text = FRONT.sub('', open(f, encoding='utf-8', errors='replace').read()).strip()
    tmp = os.path.join(run, 'draft-nofront.md')
    open(tmp, 'w').write(text)
    r = subprocess.run([sys.executable, '-I', LINT, '--json', tmp], capture_output=True, text=True)
    d = json.loads(r.stdout)
    fails = [x for x in d['findings'] if x['severity'] == 'fail']
    warns = [x for x in d['findings'] if x['severity'] != 'fail']
    res.update(words=d['words'], lint_ok=d['ok'], fails=len(fails), warns=len(warns),
               fail_ids=[x['id'] for x in fails], warn_ids=[x['id'] for x in warns],
               lint_hits=[{'rule': x['id'], 'text': [m['text'] for m in x['matches']][:3]} for x in d['findings']][:12])
    if task['id'] == 'w4-cabinetmaker-bio':
        res['length_ok'] = 100 <= d['words'] <= 140
    return res


def video(task, work, run):
    f = os.path.join(work, 'plan.md')
    res = {'deliverable': os.path.exists(f)}
    if res['deliverable']:
        t = open(f, encoding='utf-8', errors='replace').read()
        res['words'] = len(t.split())
        res['has_table_or_list'] = bool(re.search(r'^\s*(\|.*\||[-*\d]+[.)]?\s)', t, re.M))
    return res


def audio(task, work, run):
    f = os.path.join(work, 'process.sh')
    if not os.path.exists(f):
        return {'deliverable': False}
    r = sa.score(task['id'], f, [task])
    r['deliverable'] = True
    return r


def clip_signature(rgb):
    """Colour histogram of the non-black pixels of a 64x36 frame (so letterbox bars and a black fade do not matter)."""
    a = rgb.reshape(-1, 3)
    a = a[a.max(axis=1) > 40] // 43
    if len(a) < 50:
        return None
    h = np.bincount((a[:, 0] * 36 + a[:, 1] * 6 + a[:, 2]).astype(int), minlength=216).astype(float)
    return h / h.sum()


def frames(path, fps, w=64, h=36, t0=None, dur=None):
    cmd = ['ffmpeg', '-v', 'error']
    cmd += ['-i', path, '-vf', f'fps={fps},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']
    b = subprocess.run(cmd, capture_output=True).stdout
    return np.frombuffer(b, np.uint8).reshape(-1, h, w, 3)


def videoedit(task, work, run):
    f = os.path.join(work, 'edit.sh')
    if not os.path.exists(f):
        return {'deliverable': False}
    sc = task['score']
    ok, secs, tmp, log, code = sa.run_script(task['id'], f, 'out.mp4', timeout=180)
    res = {'deliverable': True, 'ran': ok, 'exit_code': code, 'seconds': secs, 'log_tail': log[-400:]}
    checks = {'wrote_out_mp4': ok}
    if ok:
        out = os.path.join(tmp, 'out.mp4')
        try:
            p = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration',
                                           '-of', 'json', out], capture_output=True, text=True).stdout)
            v = next(s for s in p['streams'] if s['codec_type'] == 'video')
            a = next((s for s in p['streams'] if s['codec_type'] == 'audio'), None)
            dur = float(p['format']['duration'])
            n, d = (v['avg_frame_rate'].split('/') + ['1'])[:2]
            fps = float(n) / float(d or 1)
            res.update(dur=round(dur, 2), size=[v['width'], v['height']], fps=round(fps, 2), vcodec=v['codec_name'], acodec=a['codec_name'] if a else None)
            lufs, tp = sa.loudness(out) if a else (None, None)
            res.update(lufs=lufs, tp=tp)
            cuts = subprocess.run(['ffmpeg', '-nostats', '-i', out, '-vf', "select='gt(scene,0.12)',showinfo", '-an', '-f', 'null', '-'],
                                  capture_output=True, text=True).stderr
            res['scene_changes'] = len(re.findall(r'pts_time:', cuts))
            blk = subprocess.run(['ffmpeg', '-nostats', '-i', out, '-vf', 'blackdetect=d=0.5:pix_th=0.1:pic_th=0.98', '-an', '-f', 'null', '-'],
                                 capture_output=True, text=True).stderr
            res['black_segments'] = [float(x) for x in re.findall(r'black_duration:([\d.]+)', blk)]
            # which of the four clips show up (nearest reference by colour histogram, an estimate)
            refs = {}
            for c in ('a', 'b', 'c', 'd'):
                fr = frames(os.path.join(E, 'inputs', task['id'], f'clip_{c}.mp4'), 1)
                sigs = [s for s in map(clip_signature, fr) if s is not None]
                refs[c] = np.mean(sigs, axis=0)
            used = set()
            for fr in frames(out, 2):
                s = clip_signature(fr)
                if s is not None:
                    dist = {c: float(np.sum(np.abs(s - r))) for c, r in refs.items()}
                    k = min(dist, key=dist.get)
                    if dist[k] < 1.2:
                        used.add(k)
            res['clips_used_estimate'] = sorted(used)
            # Crossfades slip under the scene-change score, so also count how often the matched source clip changes (4 fps).
            seq = []
            for fr in frames(out, 4):
                sg = clip_signature(fr)
                if sg is not None:
                    dist = {c: float(np.sum(np.abs(sg - r))) for c, r in refs.items()}
                    k = min(dist, key=dist.get)
                    if dist[k] < 1.2:
                        seq.append(k)
            res['source_switches'] = sum(1 for x, y in zip(seq, seq[1:]) if x != y)
            # contact sheet for the judge: 12 frames across the piece, the last one near the end
            ts = [dur * (i + 0.5) / 12 for i in range(11)] + [max(0, dur - 0.4)]
            sheet = os.path.join(run, 'sheet.png')
            tiles = []
            from PIL import Image, ImageDraw
            for i, t in enumerate(ts):
                png = os.path.join(tmp, f'f{i}.png')
                subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', out, '-frames:v', '1', '-vf', 'scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2', png])
                if os.path.exists(png):
                    im = Image.open(png).convert('RGB')
                    ImageDraw.Draw(im).text((6, 6), f'{t:.1f}s', fill=(255, 255, 0))
                    tiles.append(im)
            if tiles:
                g = Image.new('RGB', (480 * 3, 270 * 4), (20, 20, 20))
                for i, im in enumerate(tiles):
                    g.paste(im, ((i % 3) * 480, (i // 3) * 270))
                g.save(sheet)
            checks['duration_in_range'] = sc['min_dur'] <= dur <= sc['max_dur']
            checks['size_1280x720'] = [v['width'], v['height']] == sc['size']
            checks['fps_30'] = abs(fps - 30) < 0.2
            checks['h264_aac'] = v['codec_name'] == 'h264' and bool(a) and a['codec_name'] == 'aac'
            checks['five_cuts'] = max(res['scene_changes'], res['source_switches']) >= sc['min_cuts']
            checks['loudness_within_2LU'] = lufs is not None and abs(lufs - sc['lufs']) <= 2.0
            checks['no_long_black'] = not res['black_segments']
            checks['all_four_clips'] = len(used) == 4
        except Exception as e:
            res['score_error'] = f'{type(e).__name__}: {e}'
            checks['measurable'] = False
    res['checks'] = checks
    res['passed'], res['total'] = sum(checks.values()), len(checks)
    shutil.rmtree(tmp, ignore_errors=True)
    return res


def py(script, *args, timeout=600):
    """Run one of the skills' checkers (from this checkout, the same for every arm) on a responder's files."""
    env = {'PATH': '/usr/bin:/bin', 'HOME': os.path.expanduser('~'), 'HILDEGARD_CHROMIUM': chromium()}
    return subprocess.run([sys.executable, '-I', script, *args], capture_output=True, text=True, timeout=timeout, env=env)


def logo(task, work, run):
    """logo_check.py on the responder's mark and lockup: the measured checks, and a plain sheet (pictures only) for the judge."""
    mark, lg = os.path.join(work, 'mark.svg'), os.path.join(work, 'logo.svg')
    res = {'deliverable': os.path.exists(lg) or os.path.exists(mark), 'has_mark': os.path.exists(mark), 'has_logo': os.path.exists(lg),
           'has_sheet': os.path.exists(os.path.join(work, 'sheet.png'))}
    if not res['deliverable']:
        return res
    files = [mark if os.path.exists(mark) else lg] + ([lg] if os.path.exists(mark) and os.path.exists(lg) else [])
    out = os.path.join(run, 'logo-check')
    shutil.rmtree(out, ignore_errors=True)
    r = py(os.path.join(BRAND_SCRIPTS, 'logo_check.py'), *files, '--name', ' ', '--out', out, '--json', '--plain')
    try:
        rep = json.load(open(os.path.join(out, 'report.json')))
    except (OSError, ValueError):
        res['score_error'] = (r.stderr or r.stdout)[-400:]
        return res
    checks = {}
    for f, fr in rep['files'].items():
        for k, (state, msg) in fr['checks'].items():
            checks[f'{f}:{k}'] = state
    res['checks_failed'] = sorted(k for k, v in checks.items() if v == 'fail')
    res['checks_warned'] = sorted(k for k, v in checks.items() if v == 'warn')
    res['fails'] = len(res['checks_failed'])
    m = rep['files'].get(os.path.basename(files[0]), {})
    for k in ('hairlines', 'embroidery', 'one-color', 'favicon-16', 'text', 'flat', 'colors'):
        if k in m.get('checks', {}):
            res[k] = m['checks'][k][0]
    res['min_size'] = m.get('min_size', {}).get('text')
    res['live_text'] = any(fr['checks'].get('text', ('pass',))[0] == 'fail' for fr in rep['files'].values())
    if rep.get('sheet_png') and os.path.exists(rep['sheet_png']):
        shutil.copy(rep['sheet_png'], os.path.join(run, 'logo-sheet.png'))
        res['sheet_rendered'] = True
    return res


def brand(task, work, run):
    """guide.html rendered at one US letter page; brand.json parsed; the page's text contrast, overflow and clipping audited."""
    g, bj = os.path.join(work, 'guide.html'), os.path.join(work, 'brand.json')
    res = {'deliverable': os.path.exists(g), 'has_json': os.path.exists(bj)}
    try:
        b = json.load(open(bj))
        res['json_ok'] = True
        res['json_keys'] = sorted(b)[:20] if isinstance(b, dict) else []
    except (OSError, ValueError):
        res['json_ok'] = False
    if not res['deliverable']:
        return res
    sys.path.insert(0, APP_SCRIPTS)
    import browser, screen_check
    os.environ['HILDEGARD_CHROMIUM'] = chromium()
    png = os.path.join(run, 'guide.png')
    res['rendered'] = browser.chromium_shot(g, png, 816, 1056, scale=1275 / 816)
    a = screen_check.audit(g, 816, 1056, 'web') or {}
    if a and not a.get('error'):
        res.update(contrast_fails=len(a['contrast']), contrast_examples=a['contrast'][:3], clipped=len(a['clipped']) + len(a['offscreen']),
                   one_page=a['scrollH'] <= 1056 + 4 and a['scrollW'] <= 816 + 4, scroll=[a['scrollW'], a['scrollH']],
                   placeholder=len(a['placeholder']), fonts=a['fonts'], smallest_px=min((x[0] for x in a['sizes']), default=None))
    return res


def app(task, work, run):
    """screen_check.py on every state the brief asks for, at the device size; screens.png side by side for the judge."""
    w, h = task['size']
    files = [os.path.join(work, f'{s}.html') for s in task['states']]
    have = [f for f in files if os.path.exists(f)]
    res = {'deliverable': bool(have), 'states_delivered': len(have), 'states_asked': len(files)}
    if not have:
        return res
    out = os.path.join(run, 'screen-check')
    shutil.rmtree(out, ignore_errors=True)
    py(os.path.join(APP_SCRIPTS, 'screen_check.py'), *have, '--device', f'{w}x{h}', '--platform', PLATFORM(task), '--out', out, '--json')
    try:
        rep = json.load(open(os.path.join(out, 'report.json')))
    except (OSError, ValueError):
        res['score_error'] = 'screen_check gave no report'
        return res
    fails = [f'{n}:{c["check"]}' for n, sc in rep['screens'].items() for c in sc['checks'] if c['state'] == 'fail']
    warns = [f'{n}:{c["check"]}' for n, sc in rep['screens'].items() for c in sc['checks'] if c['state'] == 'warn']
    res.update(checks_failed=fails, checks_warned=warns, fails=len(fails) + len(files) - len(have))
    au = [sc['audit'] for sc in rep['screens'].values()]
    res.update(contrast_fails=sum(len(x.get('contrast', [])) for x in au), small_targets=sum(len(x.get('small', [])) for x in au),
               overflow=any(x.get('scrollW', 0) > w + 1 for x in au), clipped=sum(len(x.get('clipped', [])) + len(x.get('offscreen', [])) for x in au),
               placeholder=sum(len(x.get('placeholder', [])) for x in au))
    if rep.get('sheet') and os.path.exists(rep['sheet']):
        shutil.copy(rep['sheet'], os.path.join(run, 'screens.png'))
        res['sheet'] = True
    return res


if __name__ == '__main__':
    args = sys.argv[1:]
    paths = args[args.index('--tasks') + 1:] if '--tasks' in args else [os.path.join(HERE, 'tasks.json'), os.path.join(HERE, 'heldout.json')]
    tasks = [t for p in paths for t in json.load(open(p))]
    task = next(t for t in tasks if t['id'] == args[0])
    run = args[1]
    if not os.path.exists(os.path.join(run, 'done')):  # the responder timed out or died: whatever it left is partial work
        sys.exit(f'not scoring {run}: no done file (the responder did not finish)')
    res = {'task': task['id'], 'domain': task['domain']}
    res.update({'design': design, 'writing': writing, 'video': video, 'audio': audio, 'videoedit': videoedit,
                'logo': logo, 'brand': brand, 'app': app}[task['domain']](task, os.path.join(run, 'work'), run))
    json.dump(res, open(os.path.join(run, 'score.json'), 'w'), indent=1)
