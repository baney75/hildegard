# SPDX-License-Identifier: AGPL-3.0-only
"""The media domains' part of report.py: objective tables (checks passed, the metrics that decided them, which checks failed),
a count of the checks that failed most in the candidate arm, and contact sheets of the photo edits, the pictures drawn in code and
the motion pieces."""
import os
from collections import Counter

DOMAINS = ('photoedit', 'photocreate', 'sfx', 'music', 'codevideo')
KEYS = {
    'photoedit': ('size', 'bytes', 'tilt_in_deg', 'tilt_out_deg', 'wb_err_in', 'wb_err_out', 'luma_err_in', 'luma_err_out', 'noise_in', 'noise_out', 'ssim_in', 'ssim_out'),
    'photocreate': ('source', 'png_size', 'pixel_std', 'value_range', 'colors'),
    'sfx': ('dur', 'lufs', 'tp', 'flatness', 'centroid_hz', 'tonal_peak_db', 'pitch_hz', 'steady_db', 'droplet_cv', 'centroid_rise', 'centroid_fall'),
    'music': ('dur', 'lufs', 'tp', 'tempo_bpm', 'key_estimate', 'in_key_share', 'end_peak_db'),
    'codevideo': ('dur', 'size', 'fps', 'black_segments', 'static_window_frac', 'lines_missing', 'extra_numbers', 'extra_dates', 'images_seen'),
}


def objective(runs, verdicts, tasks, arms, models, cand, P=print):
    for d in DOMAINS:
        ts = [t for t in tasks if t['domain'] == d]
        if not ts:
            continue
        P(f'\n{d}, objective (script re-run here; checks passed/total):')
        for t in ts:
            for m in models:
                for arm in arms:
                    s = runs[arm][m][t['id']]['score']
                    bad = [k for k, v in s.get('checks', {}).items() if not v]
                    key = ', '.join(f'{k}={s[k]}' for k in KEYS[d] if s.get(k) not in (None, [], ''))
                    P(f'{t["id"]:<20} {m:<6} {arm:<5} ran={"y" if s.get("ran") else "n"} {str(s.get("passed", 0)) + "/" + str(s.get("total", 0)):>6}  failed: {bad}  {key}')
    for arm in arms:
        c, n = Counter(), 0
        for m in models:
            for t in tasks:
                if t['domain'] in DOMAINS:
                    s = runs[arm][m][t['id']]['score']
                    if s:
                        n += 1
                        for k, v in s.get('checks', {}).items():
                            if not v:
                                c[(t['domain'], k)] += 1
        if c:
            P(f'\nChecks that failed most in the {arm} arm ({n} media outputs):')
            for (d, k), v in c.most_common(12):
                P(f'  {v:>3}  {d}: {k}')


def contacts(label, tasks, arms, models, E):
    from PIL import Image, ImageDraw
    cols = [(arm, m) for m in models for arm in arms]
    out = []

    def cell(path, h, label_=''):
        if not os.path.exists(path):
            return None
        im = Image.open(path).convert('RGB')
        return im.resize((max(1, int(im.width * h / im.height)), h))

    def sheet(rows, heads, name, h):
        pad, head = 10, 30
        widths = [max([(c.width if c else 260) for c in col]) for col in zip(*[r[1] for r in rows])]
        W = sum(widths) + pad * (len(widths) + 1)
        sh = Image.new('RGB', (W, head + (h + pad + 16) * len(rows) + pad), (24, 24, 24))
        dr = ImageDraw.Draw(sh)
        x = pad
        for hd, w in zip(heads, widths):
            dr.text((x, 8), hd, fill=(255, 255, 255))
            x += w + pad
        for r, (tid, cells) in enumerate(rows):
            y = head + r * (h + pad + 16)
            x = pad
            dr.text((x, y), tid, fill=(170, 170, 170))
            for c, w in zip(cells, widths):
                if c:
                    sh.paste(c, (x, y + 16))
                else:
                    dr.rectangle([x, y + 16, x + w, y + 16 + h], outline=(120, 40, 40))
                    dr.text((x + 8, y + 30), 'no usable output', fill=(200, 80, 80))
                x += w + pad
        p = os.path.join(E, f'{name}-{label}.png')
        sh.save(p)
        out.append(p)

    pe = [t for t in tasks if t['domain'] == 'photoedit']
    if pe:
        rows = []
        for t in pe:
            cells = [cell(os.path.join(E, 'inputs', t['id'], 'photo.jpg'), 300), cell(os.path.join(E, 'ref', t['id'], 'reference.png'), 300)]
            cells += [cell(os.path.join(E, 'runs', a, m, t['id'], 'out.jpg'), 300) for a, m in cols]
            rows.append((t['id'], cells))
        sheet(rows, ['before', 'reference (clean)'] + [f'{m} / {a}' for a, m in cols], 'contact-photo-edit', 300)
    pc = [t for t in tasks if t['domain'] == 'photocreate']
    if pc:
        rows = [(t['id'], [cell(os.path.join(E, 'runs', a, m, t['id'], 'art.png'), 380) for a, m in cols]) for t in pc]
        sheet(rows, [f'{m} / {a}' for a, m in cols], 'contact-photo-create', 380)
    cv = [t for t in tasks if t['domain'] == 'codevideo']
    if cv:
        rows = []
        for t in cv:
            for m in models:
                rows.append((f'{t["id"]} ({m})', [cell(os.path.join(E, 'runs', a, m, t['id'], 'sheet.png'), 300) for a in arms]))
        sheet(rows, list(arms), 'contact-motion', 300)
    for p in out:
        print('Contact sheet:', p)
