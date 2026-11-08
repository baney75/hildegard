# SPDX-License-Identifier: AGPL-3.0-only
"""The judge's side of the media domains (photo editing, a picture drawn in code, sound effects, music, video drawn in code):
rubrics, what counts as a usable deliverable, the files copied into the judge's folder, and the measured table. judge.py calls
these; nothing here names an arm. The judge cannot hear: for sound it is given measurements and spectrogram pictures, and its
rubric says so."""
import os, shutil

DOMAINS = ('photoedit', 'photocreate', 'sfx', 'music', 'codevideo')
INVENTS = ('codevideo',)  # domains where the judge also lists invented facts (text that is not in the brief)

RUBRIC = {
    'photoedit': """You are a professional retoucher picking which edit the client would use. before.jpg is the client's photo. reference.jpg is the same photograph before it was damaged: the truth for colour, exposure and straightness (it is cut from the original at the original proportions, so the deliverables are cropped differently from it, on purpose, to the client's size). The measured table comes from the real output files and is reliable. Weigh, in this order:
1. The brief: the exact size and format, a crop that keeps the subject the client named, horizon and vertical lines level, no empty or smeared corners, nothing added (text, borders, filters, vignettes) that the brief did not ask for.
2. Colour and tone: a natural white balance and tonal range that match the reference (whites white, skin and foods honest), highlights kept, shadows opened without going milky or flat, saturation believable.
3. Technical quality: noise reduced without smearing detail or a plastic look, no halos, banding, posterisation, over-sharpening or resampling blur; clean edges after the straighten.
4. Judgment: would a client think this is simply a better version of their photo?""",
    'photocreate': """You are an art director choosing the illustration you would rather put in front of the client. Look at each image at the stated size and again shrunk to a thumbnail. Weigh, in this order:
1. Brief fit: the subject and theme, the style asked for, the palette limit, any space left empty on purpose, and no text where none was allowed. Anything the brief ruled out (faces, text, extra colors) is a serious fault.
2. Composition and value: a clear focal point, balance with intention, strong value structure, something that reads at thumbnail size, deliberate negative space.
3. Color and shape language: a coherent limited palette with a point of view, shapes drawn with intent (varied sizes, good silhouettes, overlap and depth), not primitives stacked by default.
4. Craft and originality: clean edges and layering, texture used with purpose, no stray artifacts or clipped shapes, and none of the generic AI-or-clip-art look (glowing gradients, symmetrical filler, floating random shapes).""",
    'sfx': """You are a sound designer choosing which script makes the better sound effect for the brief. YOU CANNOT HEAR EITHER SOUND, and neither could the scripts' authors. Judge from the measurements (taken from each script's real output, reliable) and the spectrogram pictures: time runs left to right, frequency runs up on a log scale (labels at 100 Hz, 1k, 10k), brighter is louder; the green strip above is the loudness over time. How to read them: a chime or bell is horizontal lines (partials) that start together and fade, stepping up if the notes rise; a page turn is a short broadband burst; rain is an even broadband wash with scattered short bright flecks; a whoosh is a band that sweeps up in frequency and then back down while swelling and fading. Weigh, in this order:
1. Does the measured sound behave like the asked effect (the check rows)? A failed length, loudness or peak limit is a fault; a script that wrote no WAV loses.
2. Does the spectrogram show a believable, designed sound: natural decay and variation, overtones with a reason, no clicks (a vertical line at the very start or end), no steady hum lines unless asked, no obvious loop seam?
3. The script: layered, shaped synthesis (envelopes, filtered noise, partials, randomness) against a crude sine or raw white noise, and whether it is robust.
4. Fit to the brief's length, character and use.""",
    'music': """You are a music editor choosing which script makes the better piece of music for the brief. YOU CANNOT HEAR EITHER PIECE, and neither could the scripts' authors. Judge from the measurements (taken from each script's real output, reliable) and the pictures: the top strip is loudness over time (green), then a spectrogram (time left to right, log frequency up, brighter is louder; vertical stripes are drum hits or plucks, horizontal bands are sustained notes), then a chromagram (twelve rows, C at the bottom up to B; bright rows are the pitch classes sounding; a piece in one key lights a stable set of seven, and chords show as rows lighting and moving). Weigh, in this order:
1. The brief's hard facts, as measured: length, loudness, true peak, tempo near the asked BPM, key. A failed one is a fault; a script that wrote no WAV loses.
2. Musical shape visible in the pictures: a pulse that holds, chords that move through a progression, a melodic line or hook, variation across the piece, an intentional ending (a fade or ring-out, not a hard cut), sensible loudness over time for its use (a bed under speech stays low and sparse).
3. Arrangement and sound: several layers (bass, harmony, rhythm, melody), with timbres shaped by envelopes, rather than raw sines stacked in one chord.
4. The script: sound structure and robustness.""",
    'codevideo': """You are a motion designer choosing which video you would rather post, from each script and a contact sheet of 8 frames spread across the finished video (the last frame is near the end; the time is written on each tile). The measured table is from the real MP4 and the OCR of its frames, and is reliable. Weigh, in this order:
1. The text: every line the brief asks for is present and spelled right, and nothing else is shown (an invented line, number or date is a serious fault). Trust the OCR rows for what the frames contain.
2. Design in the frames: one clear thing to read first, type big and contrasty enough for a phone, a palette with a point of view, composition and spacing with intent, not a default centered stack on a flat color.
3. Motion, from the sheet and the script: lines or elements arrive in a sensible order and at a readable pace, easing rather than linear slides, gentle where the brief asks for gentle, nothing that flickers, jitters or runs long without a reason; the video does not sit frozen.
4. The script: a sound structure, no fragile hard-coding. A script that wrote no video loses.""",
}

TABLE = {
    'photoedit': ['ran', 'size', 'bytes', 'placed', 'subject_inside', 'tilt_in_deg', 'tilt_out_deg', 'wb_err_in', 'wb_err_out', 'luma_err_in', 'luma_err_out',
                  'clip_hi_out', 'clip_hi_ref', 'clip_lo_out', 'clip_lo_ref', 'noise_in', 'noise_out', 'noise_ref', 'detail_ratio', 'ssim_in', 'ssim_out', 'seconds'],
    'photocreate': ['ran', 'source', 'png_size', 'pixel_std', 'value_range', 'colors', 'external_refs', 'seconds'],
    'sfx': ['ran', 'dur', 'channels', 'lufs', 'tp', 'peak_db', 'clip_count', 'flatness', 'centroid_hz', 'tonal_peak_db', 'band_spread_db', 'pitch_hz', 'pitch_prom_db', 'pitch_steps_hz',
            'attack_s', 'tail_1s_db', 'end_db', 'steady_db', 'droplet_cv', 'centroid_peak_at', 'centroid_rise', 'centroid_fall', 'level_peak_at', 'seconds'],
    'music': ['ran', 'dur', 'lufs', 'tp', 'clip_count', 'tempo_bpm', 'tempo_octave', 'key_estimate', 'in_key_share', 'in_key_thirds', 'dead_air_s', 'end_peak_db', 'seconds'],
    'codevideo': ['ran', 'dur', 'size', 'fps', 'vcodec', 'bytes', 'black_segments', 'static_window_frac', 'motion_mean', 'images_seen', 'lines_missing', 'extra_numbers', 'extra_dates', 'ocr', 'seconds'],
}


def available(s, domain):
    if s.get('score_error'):
        return False
    if domain == 'photocreate':  # nothing runs for an SVG or an HTML page, so there is no `ran`
        return bool(s.get('checks', {}).get('rendered')) and bool(s.get('checks', {}).get('not_blank'))
    if not s.get('ran'):
        return False
    if domain == 'photoedit':
        return 'size' in s
    return True


def table(sa, sb, domain):
    rows = ['| metric | A | B |', '| --- | --- | --- |']
    for k in TABLE[domain]:
        if k in sa or k in sb:
            rows.append(f'| {k} | {sa.get(k, "-")} | {sb.get(k, "-")} |')
    for k in sorted(set(sa.get('checks', {})) | set(sb.get('checks', {}))):
        f = lambda s: ('pass' if s['checks'][k] else 'FAIL') if k in s.get('checks', {}) else '-'
        rows.append(f'| check: {k} | {f(sa)} | {f(sb)} |')
    rows.append(f"| checks passed | {sa.get('passed', 0)}/{sa.get('total', 0)} | {sb.get('passed', 0)}/{sb.get('total', 0)} |")
    return '\n'.join(rows)


def stage(w, tag, rd, task, E):
    """Copy one arm's files into the judge's folder under neutral names."""
    d = task['domain']
    work = os.path.join(rd, 'work')
    script = next((n for n in task['deliverable'] if os.path.exists(os.path.join(work, n))), None)
    if d == 'photoedit':
        shutil.copy(os.path.join(rd, 'out.jpg'), os.path.join(w, f'{tag}.jpg'))
    elif d == 'photocreate':
        shutil.copy(os.path.join(rd, 'art.png'), os.path.join(w, f'{tag}.png'))
        if script and script.endswith('.py'):
            shutil.copy(os.path.join(work, script), os.path.join(w, f'{tag}-script.txt'))
        elif script:
            shutil.copy(os.path.join(work, script), os.path.join(w, f'{tag}-source.txt'))
        return
    elif d in ('sfx', 'music'):
        shutil.copy(os.path.join(rd, 'spec.png'), os.path.join(w, f'{tag}-spectrogram.png'))
    elif d == 'codevideo':
        shutil.copy(os.path.join(rd, 'sheet.png'), os.path.join(w, f'{tag}-frames.png'))
    if script:
        shutil.copy(os.path.join(work, script), os.path.join(w, f'{tag}-script.txt'))


def stage_shared(w, task, E):
    if task['domain'] == 'photoedit':
        from PIL import Image
        Image.open(os.path.join(E, 'inputs', task['id'], 'photo.jpg')).convert('RGB').save(os.path.join(w, 'before.jpg'), quality=92)
        Image.open(os.path.join(E, 'ref', task['id'], 'reference.png')).convert('RGB').save(os.path.join(w, 'reference.jpg'), quality=92)


def extra(task, sa, sb):
    d = task['domain']
    t = ''
    if d == 'photoedit':
        t = f"Read before.jpg, reference.jpg, A.jpg and B.jpg in the current folder (A and B are the two edits, each meant to be {task['score']['size'][0]} x {task['score']['size'][1]})."
    elif d == 'photocreate':
        t = f"Read the two images A.png and B.png in the current folder (both rendered at {task['size'][0]} x {task['size'][1]} px). The source of each is in A-script.txt or A-source.txt (and B-) if you want to see how it was made."
    elif d in ('sfx', 'music'):
        t = 'Read A-spectrogram.png and B-spectrogram.png, then A-script.txt and B-script.txt, in the current folder.'
    elif d == 'codevideo':
        t = 'Read A-frames.png and B-frames.png (contact sheets of the finished videos), then A-script.txt and B-script.txt, in the current folder.'
    if d != 'photocreate':
        t += '\n\nMEASURED RESULTS (each script was run on a fresh copy of the inputs with no network; check rows are pass or FAIL against the brief):\n' + table(sa, sb, d)
    else:
        t += '\n\nMEASURED (the file facts only; the look is yours to judge):\n' + table(sa, sb, d)
    return t
