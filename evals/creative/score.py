# SPDX-License-Identifier: AGPL-3.0-only
"""Objective scores for one run: score.py <task id> <run dir> [--tasks tasks.json heldout.json]

<run dir> holds work/ (the responder's folder). Writes <run dir>/score.json and, where the domain has one, the picture the
judge looks at: design.png (the HTML rendered by Playwright's Chromium) or sheet.png (frames of the edited video).

  design    renders at the stated size; checks that it drew something and loads nothing beyond Google Fonts
  writing   runs skills/hildegard/scripts/prose_lint.py on the draft (front matter removed): fails and warns
  video     the plan is judged by rubric only; here only its size is recorded
  audio     score_audio.py
  videoedit runs edit.sh in a copy of the clips with no network; duration, size, fps, codecs, loudness, scene changes
            (ffmpeg scene score above 0.12), black stretches over half a second (blackdetect), which clips appear
  photoedit, photocreate, sfx, music, codevideo   score_media.py (and score_sound.py for sound and music)"""
import glob, json, os, re, shutil, subprocess, sys
import numpy as np
from audiolib import SR
import score_audio as sa

E = sa.E
HERE = sa.HERE
ROOT = os.path.dirname(os.path.dirname(HERE))
LINT = os.path.join(ROOT, 'skills', 'hildegard', 'scripts', 'prose_lint.py')
FRONT = re.compile(r'\A﻿?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\Z)')
DELIVERABLE = {'design': 'design.html', 'video': 'plan.md', 'audio': 'process.sh', 'writing': 'draft.md', 'videoedit': 'edit.sh'}


def chromium():
    """Playwright's Chromium, never the Helium launcher on PATH."""
    env = os.environ.get('HILDEGARD_EVAL_CHROMIUM')
    if env:
        return env
    c = sorted(glob.glob(os.path.expanduser('~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome')))
    if not c:
        raise SystemExit('no Playwright Chromium under ~/.cache/ms-playwright; run `npx playwright install chromium`')
    return c[-1]


def render(html, png, w, h):
    subprocess.run([chromium(), '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    f'--window-size={w},{h}', '--virtual-time-budget=12000', f'--screenshot={png}', 'file://' + os.path.abspath(html)],
                   capture_output=True, timeout=120, env={'PATH': '/usr/bin:/bin', 'HOME': os.path.expanduser('~'), 'DISPLAY': ''})


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
    render(f, png, w, h)
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


if __name__ == '__main__':
    args = sys.argv[1:]
    paths = args[args.index('--tasks') + 1:] if '--tasks' in args else [os.path.join(HERE, 'tasks.json'), os.path.join(HERE, 'heldout.json')]
    tasks = [t for p in paths for t in json.load(open(p))]
    task = next(t for t in tasks if t['id'] == args[0])
    run = args[1]
    res = {'task': task['id'], 'domain': task['domain']}
    import score_media  # photo editing, pictures and video drawn in code, sound effects, music
    fns = {'design': design, 'writing': writing, 'video': video, 'audio': audio, 'videoedit': videoedit, **score_media.DOMAINS}
    res.update(fns[task['domain']](task, os.path.join(run, 'work'), run))
    json.dump(res, open(os.path.join(run, 'score.json'), 'w'), indent=1)
