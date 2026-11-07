# SPDX-License-Identifier: AGPL-3.0-only
"""Objective scores for the media domains: photo editing, picture drawn in code, sound effects, music, video drawn in code.

Called by score.py (`score.py <task id> <run dir> --tasks ...`); each function takes (task, work folder, run folder) and returns
the dict that becomes score.json. The responder's script is never trusted: it is copied into a temp folder holding only the
task's input files and run there under sandbox.py (no network, read-only filesystem), `PATH=/usr/bin:/bin:/usr/local/bin` (no ~/.local/bin, which
holds a Chrome launcher that must never render here; the picture and video tasks name Playwright's Chromium instead), and a
timeout. See score_sound.py for sound and music, and the README for what each check means.

  photoedit    out.jpg against the clean photo it was made from: exact size, JPEG, file size cap, where the output sits in the
               reference (normalized cross-correlation over crop size and offset), whether the stated subject survived the crop,
               straightness (imglib.tilt_estimate, against the reference's own estimate), white balance (log R/G and B/G distance),
               exposure (mean luma, clipped highlights and shadows), noise (Immerkaer estimate against the input and the reference),
               detail kept (gradient energy), no empty corners, and SSIM against the aligned reference crop
  photocreate  art.svg, art.html (rendered here by Playwright's Chromium) or make.py (art.png): size, not blank, value range, no
               network references. The look is for the judge
  codevideo    out.mp4 from make.py or make.sh: duration, size, fps, codecs, file size, black stretches, motion, every required
               line found by OCR (tesseract) in the sampled frames, no extra numbers or dates, every given image shown; a contact
               sheet of 8 frames for the judge. Without tesseract the text checks are skipped and the result says so"""
import difflib, glob, json, os, re, shutil, subprocess, sys, tempfile, time
import numpy as np
from PIL import Image, ImageDraw
import imglib
import sandbox

E = os.environ.get('EVAL_DIR', os.path.expanduser('~/.cache/hildegard-creative-eval'))
HERE = os.path.dirname(os.path.abspath(__file__))
SANDBOX_PATH = '/usr/bin:/bin:/usr/local/bin'


def run_script(task_id, work, names, out_name, timeout=120):
    """Run the first of `names` found in `work` on a fresh copy of the task's inputs. Returns (ok, seconds, folder, log, exit code, script name)."""
    name = next((n for n in names if os.path.exists(os.path.join(work, n))), None)
    tmp = tempfile.mkdtemp(prefix=f'creative-{task_id}-')
    if name is None:
        return False, 0.0, tmp, 'no deliverable named ' + ' or '.join(names), -1, None
    ind = os.path.join(E, 'inputs', task_id)
    if os.path.isdir(ind):
        for f in os.listdir(ind):
            shutil.copy(os.path.join(ind, f), tmp)
    shutil.copy(os.path.join(work, name), os.path.join(tmp, name))
    env = {'PATH': SANDBOX_PATH, 'HOME': tmp, 'LANG': 'C.UTF-8', 'TMPDIR': tmp}
    cmd = ['python3', name] if name.endswith('.py') else ['bash', name]
    cmd = sandbox.wrap(cmd, tmp)
    t0 = time.time()
    try:
        r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True, timeout=timeout)
        log, code = (r.stdout + r.stderr)[-1500:], r.returncode
    except subprocess.TimeoutExpired:
        log, code = f'timed out after {timeout} s', -9
    outs = [out_name] if isinstance(out_name, str) else out_name
    ok = any(os.path.exists(os.path.join(tmp, o)) and os.path.getsize(os.path.join(tmp, o)) > 500 for o in outs) and code != -9  # a script that hit the time limit did not deliver; its partial file does not count
    return ok, round(time.time() - t0, 1), tmp, log, code, name


def finish(res, checks, tmp):
    res['checks'] = checks
    res['passed'], res['total'] = sum(checks.values()), len(checks)
    shutil.rmtree(tmp, ignore_errors=True)
    return res


# ---- photo editing ----

def corner_wedges(im):
    a = np.asarray(im.convert('L'), dtype=np.float32)
    h, w = a.shape
    ph, pw = max(4, int(h * 0.04)), max(4, int(w * 0.04))
    n = 0
    for sl in (a[:ph, :pw], a[:ph, -pw:], a[-ph:, :pw], a[-ph:, -pw:]):
        if sl.std() < 2.0 and (sl.mean() < 12 or sl.mean() > 243):
            n += 1
    return n


def photoedit(task, work, run):
    sc, tid = task['score'], task['id']
    ok, secs, tmp, log, code, name = run_script(tid, work, task['deliverable'], 'out.jpg')
    res = {'deliverable': name is not None, 'ran': ok, 'exit_code': code, 'seconds': secs, 'script': name, 'log_tail': log[-400:]}
    checks = {'wrote_out_jpg': ok}
    if not ok:
        return finish(res, checks, tmp)
    outp = os.path.join(tmp, 'out.jpg')
    try:
        raw = open(outp, 'rb').read()
        checks['is_jpeg'] = raw[:3] == b'\xff\xd8\xff'
        shutil.copy(outp, os.path.join(run, 'out.jpg'))
        im = imglib.load_rgb(outp)
        ref = imglib.load_rgb(os.path.join(E, 'ref', tid, 'reference.png'))
        inp = imglib.load_rgb(os.path.join(E, 'inputs', tid, 'photo.jpg'))
        ops = task['media']['ops']
        W, H = sc['size']
        res.update(size=list(im.size), bytes=len(raw))
        checks['size_exact'] = list(im.size) == [W, H]
        checks['file_size_cap'] = len(raw) <= sc['max_bytes']
        checks['no_empty_corners'] = corner_wedges(im) == 0
        box, ncc = imglib.place(im, ref)
        res['placed'] = {'box': [round(v) for v in box], 'ncc': round(ncc, 3), 'crop_frac': round((box[2] - box[0]) / ref.width, 2)}
        sx0, sy0, sx1, sy1 = [v * s for v, s in zip(sc['subject'], (ref.width, ref.height, ref.width, ref.height))]
        ix = max(0, min(box[2], sx1) - max(box[0], sx0))
        iy = max(0, min(box[3], sy1) - max(box[1], sy0))
        res['subject_inside'] = round(float(ix * iy / ((sx1 - sx0) * (sy1 - sy0))), 2)
        checks['subject_kept'] = res['subject_inside'] >= 0.9
        bx = tuple(int(round(v)) for v in box)
        rc = ref.crop(bx).resize(im.size, Image.LANCZOS)
        ic = inp.crop(bx).resize(im.size, Image.LANCZOS)
        a_out, a_ref, a_in = imglib.to_f(im), imglib.to_f(rc), imglib.to_f(ic)
        # structure
        sw = 384  # structure at the scale of the whole picture, lightly blurred so grain and resampling do not decide it
        sy = lambda i: imglib.blur(imglib.luma(imglib.to_f(imglib.resize_w(i, sw))), 0.8)
        res['ssim_out'] = round(imglib.ssim(sy(im), sy(rc)), 3)
        res['ssim_in'] = round(imglib.ssim(sy(inp), sy(ref)), 3)
        checks['similar_to_reference'] = res['ssim_out'] >= sc.get('ssim_min', 0.75)
        # straightness
        fam = sc.get('tilt_family', 'auto')
        t_ref_full = imglib.tilt_estimate(ref, fam)[0]
        t_in = imglib.tilt_estimate(inp, fam)[0]
        t_ref = imglib.tilt_estimate(rc, fam)[0]
        t_out = imglib.tilt_estimate(im, fam)[0]
        res['tilt_in_deg'] = round(t_in - t_ref_full, 2)
        res['tilt_out_deg'] = round(t_out - t_ref, 2)
        checks['straight'] = abs(res['tilt_out_deg']) <= 0.75
        # white balance and exposure, against the aligned reference crop
        res['wb_err_in'] = round(imglib.chroma_error(a_in, a_ref), 3)
        res['wb_err_out'] = round(imglib.chroma_error(a_out, a_ref), 3)
        res['grayworld_dev_out'] = round(imglib.gray_world_dev(a_out), 3)
        checks['white_balance'] = res['wb_err_out'] <= (max(0.05, 0.3 * res['wb_err_in']) if 'cast' in ops else 0.08)
        res['luma_err_in'] = round(float(imglib.luma(a_in).mean() - imglib.luma(a_ref).mean()), 3)
        res['luma_err_out'] = round(float(imglib.luma(a_out).mean() - imglib.luma(a_ref).mean()), 3)
        checks['exposure'] = abs(res['luma_err_out']) <= 0.06
        hi_r, lo_r = imglib.clip_fracs(a_ref)
        hi_o, lo_o = imglib.clip_fracs(a_out)
        res.update(clip_hi_out=round(hi_o, 3), clip_lo_out=round(lo_o, 3), clip_hi_ref=round(hi_r, 3), clip_lo_ref=round(lo_r, 3))
        checks['highlights_kept'] = hi_o <= hi_r + 0.02
        checks['shadows_kept'] = lo_o <= lo_r + 0.03
        # noise and detail at one analysis width
        aw = min(1000, im.width)
        no = imglib.noise_sigma(imglib.luma(imglib.to_f(imglib.resize_w(im, aw))))
        nr = imglib.noise_sigma(imglib.luma(imglib.to_f(imglib.resize_w(rc, aw))))
        ni = imglib.noise_sigma(imglib.luma(imglib.to_f(imglib.resize_w(ic, aw))))
        res.update(noise_in=round(ni, 2), noise_out=round(no, 2), noise_ref=round(nr, 2))
        go = imglib.gradient_energy(imglib.luma(imglib.to_f(imglib.resize_w(im, aw))))
        gr = imglib.gradient_energy(imglib.luma(imglib.to_f(imglib.resize_w(rc, aw))))
        res['detail_ratio'] = round(go / (gr + 1e-9), 2)
        if 'noise' in ops:
            checks['denoised'] = (no - nr) <= 0.5 * (ni - nr)
        checks['detail_kept'] = 0.6 <= res['detail_ratio'] <= 1.35
    except Exception as e:
        res['score_error'] = f'{type(e).__name__}: {e}'
        checks['measurable'] = False
    return finish(res, checks, tmp)


# ---- a picture drawn in code ----

def photocreate(task, work, run):
    import score as S
    sc, tid = task['score'], task['id']
    W, H = task['size']
    ok, secs, tmp, log, code, name = (False, 0.0, tempfile.mkdtemp(prefix='creative-art-'), '', -1, None)
    png = os.path.join(run, 'art.png')
    if os.path.exists(png):
        os.remove(png)
    res = {'deliverable': False}
    src = None
    if os.path.exists(os.path.join(work, 'make.py')):
        ok, secs, tmp, log, code, name = run_script(tid, work, ['make.py'], ['art.png', 'art.svg', 'art.html'])
        res.update(ran=ok, exit_code=code, seconds=secs, log_tail=log[-400:])
        if os.path.exists(os.path.join(tmp, 'art.png')):
            shutil.copy(os.path.join(tmp, 'art.png'), png)
            src = 'make.py'
        else:
            for f in ('art.svg', 'art.html'):
                if os.path.exists(os.path.join(tmp, f)):
                    S.render(os.path.join(tmp, f), png, W, H)
                    src = f
                    break
    if src is None:
        for f in ('art.svg', 'art.html'):
            if os.path.exists(os.path.join(work, f)):
                S.render(os.path.join(work, f), png, W, H)
                src = f
                break
    res['deliverable'] = src is not None or name is not None
    res['source'] = src
    checks = {'rendered': os.path.exists(png)}
    if checks['rendered']:
        im = Image.open(png).convert('RGB')
        res['png_size'] = list(im.size)
        checks['size_exact'] = list(im.size) == [W, H]
        if im.size != (W, H):  # a window that comes out a little off is padded or cropped, so the judge sees the asked canvas
            canvas = Image.new('RGB', (W, H), (255, 255, 255))
            canvas.paste(im.crop((0, 0, min(W, im.size[0]), min(H, im.size[1]))), (0, 0))
            canvas.save(png)
            im = canvas
        a = imglib.to_f(im.resize((W // 8, H // 8)))
        y = imglib.luma(a)
        res['pixel_std'] = round(float(a.std() * 255), 1)
        res['value_range'] = round(float(np.percentile(y, 98) - np.percentile(y, 2)), 2)
        res['colors'] = int(len(np.unique((a * 255).astype(int).reshape(-1, 3) // 16, axis=0)))
        checks['not_blank'] = res['pixel_std'] >= 4
        checks['value_range'] = res['value_range'] >= 0.2
        checks['colors'] = res['colors'] >= 5
    texts = []
    for f in (os.path.join(work, 'art.svg'), os.path.join(work, 'art.html'), os.path.join(work, 'make.py')):
        if os.path.exists(f):
            texts.append(open(f, encoding='utf-8', errors='replace').read())
    ext = set()
    for t in texts:
        for pair in re.findall(r'(?:src|href)\s*=\s*["\'](https?://[^"\']+)|url\(\s*["\']?(https?://[^)"\']+)|@import\s+["\'](https?://[^"\']+)', t):
            ext |= {u for u in pair if u and not re.match(r'https?://(fonts\.(googleapis|gstatic)\.com|www\.w3\.org)/', u)}
    res['external_refs'] = sorted(ext)
    checks['no_network_refs'] = not ext
    return finish(res, checks, tmp)


# ---- video drawn in code ----

def norm(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())


MONTHS = ('january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december',
          'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
          'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun')


def ocr_words(png):
    """[(word, confidence)] from tesseract (sparse-text mode); also the inverted picture when the frame is dark."""
    out = []
    variants = [png]
    im = Image.open(png).convert('L')
    if np.asarray(im).mean() < 110:
        from PIL import ImageOps
        inv = png[:-4] + '-inv.png'
        ImageOps.invert(im).save(inv)
        variants.append(inv)
    for p in variants:
        r = subprocess.run(['tesseract', p, 'stdout', '--psm', '11', '-l', 'eng', 'tsv'], capture_output=True, text=True, timeout=60)
        for line in r.stdout.splitlines()[1:]:
            c = line.split('\t')
            if len(c) >= 12 and c[11].strip():
                try:
                    out.append((c[11].strip(), float(c[10])))
                except ValueError:
                    pass
    return out


def token_found(tok, words, joined):
    if len(tok) <= 1:
        return True
    if tok in joined:
        return True
    return any(difflib.SequenceMatcher(None, tok, w).ratio() >= 0.8 for w in words if len(w) >= 2)


def line_fraction(line, words, joined):
    toks = [norm(t) for t in line.split() if len(norm(t)) > 1]
    if not toks:
        return 1.0
    return sum(token_found(t, words, joined) for t in toks) / len(toks)


def num_norm(s):
    return re.sub(r'[^0-9]', '', s)


def lev1(a, b):
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    i = 0
    while i < min(len(a), len(b)) and a[i] == b[i]:
        i += 1
    return a[i + 1:] == b[i + 1:] or a[i:] == b[i + 1:] or a[i + 1:] == b[i:]


def numbers_ok(tok, allowed):
    n = num_norm(tok)
    if len(n) < 2:
        return True
    for a in allowed:
        if n == a or (len(a) >= 3 and (n in a or a in n)) or (len(n) >= 4 and lev1(n, a)):
            return True
    return False


def video_frames(path, fps, w, h):
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-vf', f'fps={fps},scale={w}:{h}', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True)
    return np.frombuffer(r.stdout, np.uint8).reshape(-1, h, w, 3)


def codevideo(task, work, run):
    sc, tid = task['score'], task['id']
    ok, secs, tmp, log, code, name = run_script(tid, work, task['deliverable'], 'out.mp4', timeout=300)
    res = {'deliverable': name is not None, 'ran': ok, 'exit_code': code, 'seconds': secs, 'script': name, 'log_tail': log[-400:]}
    checks = {'wrote_out_mp4': ok}
    if not ok:
        return finish(res, checks, tmp)
    out = os.path.join(tmp, 'out.mp4')
    try:
        p = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt:format=duration,size',
                                       '-of', 'json', out], capture_output=True, text=True).stdout)
        v = next(s for s in p['streams'] if s['codec_type'] == 'video')
        dur = float(p['format']['duration'])
        n, d = (v['avg_frame_rate'].split('/') + ['1'])[:2]
        fps = float(n) / float(d or 1)
        res.update(dur=round(dur, 2), size=[v['width'], v['height']], fps=round(fps, 2), vcodec=v['codec_name'], pix_fmt=v.get('pix_fmt'), bytes=int(p['format']['size']))
        checks['duration_in_range'] = sc['dur'][0] <= dur <= sc['dur'][1]
        checks['size_exact'] = [v['width'], v['height']] == sc['size']
        checks['fps_24_to_60'] = 23.9 <= fps <= 60.1
        checks['h264_yuv420p'] = v['codec_name'] == 'h264' and v.get('pix_fmt') == 'yuv420p'
        checks['file_size_cap'] = res['bytes'] <= sc.get('max_bytes', 40_000_000)
        blk = subprocess.run(['ffmpeg', '-nostats', '-i', out, '-vf', 'blackdetect=d=0.5:pix_th=0.04:pic_th=0.98', '-an', '-f', 'null', '-'], capture_output=True, text=True).stderr
        res['black_segments'] = [float(x) for x in re.findall(r'black_duration:([\d.]+)', blk)]
        checks['no_black_over_half_second'] = not res['black_segments']
        fr = video_frames(out, 8, 96, 54).astype(np.float32)
        if len(fr) > 9:
            dd = np.abs(np.diff(fr, axis=0)).mean(axis=(1, 2, 3))
            wins = [dd[i:i + 8].max() for i in range(0, len(dd) - 7, 4)]
            res['static_window_frac'] = round(float(np.mean([w < 0.15 for w in wins])), 2)
            res['motion_mean'] = round(float(dd.mean()), 2)
            res['motion_max'] = round(float(dd.max()), 1)
            checks['not_static'] = res['static_window_frac'] <= sc.get('max_static', 0.35)
        # sampled frames for OCR and the contact sheet
        ts = [dur * (i + 0.5) / 14 for i in range(13)] + [max(0.0, dur - 0.3)]
        pngs = []
        for i, t in enumerate(ts):
            pth = os.path.join(tmp, f'f{i:02d}.png')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', out, '-frames:v', '1', pth])
            if os.path.exists(pth):
                pngs.append((t, pth))
        # contact sheet: 8 frames across the piece, the last near the end
        cs = [dur * (i + 0.5) / 8 for i in range(7)] + [max(0.0, dur - 0.3)]
        tw, th = (480, 270) if v['width'] >= v['height'] else (270, 480)
        sheet = Image.new('RGB', (tw * 4, th * 2), (20, 20, 20))
        for i, t in enumerate(cs):
            pth = os.path.join(tmp, f'c{i}.png')
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', f'{t:.2f}', '-i', out, '-frames:v', '1', '-vf', f'scale={tw}:{th}:force_original_aspect_ratio=decrease,pad={tw}:{th}:(ow-iw)/2:(oh-ih)/2', pth])
            if os.path.exists(pth):
                tile = Image.open(pth).convert('RGB')
                ImageDraw.Draw(tile).text((6, 6), f'{t:.1f}s', fill=(255, 255, 0))
                sheet.paste(tile, ((i % 4) * tw, (i // 4) * th))
        sheet.save(os.path.join(run, 'sheet.png'))
        # given images: which of them appear
        if sc.get('images'):
            # which given photos show: correlation of 48 x 27 luma (a scrim, a slow zoom or a caption does not break it)
            def sig(a):
                y = imglib.luma(a.astype(np.float32) / 255.0)
                y = imglib.blur(y, 1.0)
                return (y - y.mean()) / (y.std() + 1e-6)
            refs = {nme: sig(np.asarray(Image.open(os.path.join(E, 'inputs', tid, nme)).convert('RGB').resize((48, 27), Image.LANCZOS))) for nme in sc['images']}
            used = set()
            for f in video_frames(out, 2, 48, 27):
                s_ = sig(f)
                score_ = {k: float((s_ * r).mean()) for k, r in refs.items()}
                k = max(score_, key=score_.get)
                if score_[k] >= 0.5:
                    used.add(k)
            res['images_seen'] = sorted(used)
            checks['all_images_shown'] = len(used) == len(refs)
        # text: every required line appears, nothing numeric or dated that is not in the brief
        if not shutil.which('tesseract'):
            res['ocr'] = 'skipped: tesseract is not installed'
        else:
            per = []
            for t, pth in pngs:
                ws = ocr_words(pth)
                per.append((t, ws))
            res['ocr'] = 'tesseract'
            found, missing = [], []
            for line in sc['lines']:
                best = 0.0
                for t, ws in per:
                    words = [norm(w) for w, c in ws if c >= 30]
                    best = max(best, line_fraction(line, words, ''.join(words)))
                (found if best >= 0.8 else missing).append(line)
            res['lines_missing'] = missing
            checks['every_line_present'] = not missing
            allowed = {num_norm(x) for x in sc.get('allowed_numbers', []) if num_norm(x)}
            for line in sc['lines']:
                allowed |= {num_norm(x) for x in re.findall(r'\d[\d,.:]*', line) if num_norm(x)}
            allowed_words = {norm(w) for line in sc['lines'] for w in line.split()} | {norm(w) for w in sc.get('allowed_words', [])}
            for nme in sc.get('images', []):  # text that is in a supplied photo (a price sign, say) is not an invention
                for w, c in ocr_words(os.path.join(E, 'inputs', tid, nme)):
                    allowed |= {num_norm(x) for x in re.findall(r'\d[\d,.:]*', w) if num_norm(x)}
                    allowed_words.add(norm(w))
            scope = per[-3:] if sc.get('count_up') else per
            extra_nums, extra_dates = {}, {}
            for t, ws in scope:
                seen_n, seen_d = set(), set()
                for w, c in ws:
                    if c < 85:  # tesseract invents digits from photographic texture at lower confidence
                        continue
                    for tok in re.findall(r'\d[\d,.:]*\d|\d', w):
                        if not numbers_ok(tok, allowed):
                            seen_n.add(num_norm(tok))
                    wn = norm(w)
                    if wn in MONTHS and not any(a == wn or (len(wn) >= 3 and a.startswith(wn)) for a in allowed_words):
                        seen_d.add(wn)
                for k in seen_n:
                    extra_nums.setdefault(k, 0)
                    extra_nums[k] += 1
                for k in seen_d:
                    extra_dates.setdefault(k, 0)
                    extra_dates[k] += 1
            res['extra_numbers'] = sorted(k for k, n in extra_nums.items() if n >= 2)
            res['extra_dates'] = sorted(k for k, n in extra_dates.items() if n >= 2)
            checks['no_extra_numbers_or_dates'] = not res['extra_numbers'] and not res['extra_dates']
    except Exception as e:
        res['score_error'] = f'{type(e).__name__}: {e}'
        checks['measurable'] = False
    return finish(res, checks, tmp)


def sound(task, work, run):
    import score_sound
    r = score_sound.score(task['id'], work, [task], run)
    r['deliverable'] = r.get('script') is not None
    return r


DOMAINS = {'photoedit': photoedit, 'photocreate': photocreate, 'codevideo': codevideo, 'sfx': sound, 'music': sound}
