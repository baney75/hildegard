#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""logo_check.py: render a logo at the sizes it must survive, measure what breaks, and make the logo sheet.

  python3 logo_check.py mark.svg [logo-horizontal.svg logo-stacked.svg ...] [--name "Brickyard Press"]
                        [--max-colors 3] [--dark "#1d1a17"] [--clear 0.25] [--out logo-check] [--json]

The first file is the mark: the favicon and app icon come from it. The others are lockups. Into --out it writes
<file>-16/32/64/512.png, <file>-1c.svg (one color) and <file>-rev.svg (reversed), <file>-thin.png (thin parts in
magenta) when something is too thin, sheet.html and sheet.png (the logo sheet), and report.json. It prints one line per
check and exits 1 when a check fails.

Checks, all measured, none guessed:
  svg          parses, has a viewBox
  text         no live <text> (convert letters to paths; an embedded @font-face only warns)
  flat         no gradients, patterns, filters, masks or embedded images: it must print in one ink
  colors       at most --max-colors distinct colors
  hairlines    nothing thinner than 1 px when the mark is 32 px (strokes and the gaps between shapes)
  embroidery   nothing thinner than 1 mm when the mark is 1 inch wide (fails for the mark, warns for lockups)
  one-color    edges that disappear when every color becomes one ink (the mark leans on color to read)
  favicon-16   how much of the mark is finer than 1 px at 16 px (warns: draw a simpler favicon)
  transparent  no background box (it would show as a block when reversed or on a photo)

Needs Python 3.9+. Pillow for the pixel checks, and one of rsvg-convert, cairosvg or Chromium (Playwright's, or
chromium on PATH) to rasterize; without them only the SVG checks run, and it says so."""
import argparse, html, json, os, re, shutil, subprocess, sys, tempfile
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from browser import chromium_shot, find_chromium  # noqa: E402

try:
    from PIL import Image, ImageChops, ImageFilter
except ImportError:  # the SVG checks still run
    Image = None

NAMED = {'black': (0, 0, 0), 'white': (255, 255, 255), 'red': (255, 0, 0), 'green': (0, 128, 0), 'blue': (0, 0, 255),
         'yellow': (255, 255, 0), 'gray': (128, 128, 128), 'grey': (128, 128, 128), 'orange': (255, 165, 0),
         'navy': (0, 0, 128), 'maroon': (128, 0, 0), 'olive': (128, 128, 0), 'teal': (0, 128, 128),
         'purple': (128, 0, 128), 'silver': (192, 192, 192), 'brown': (165, 42, 42), 'gold': (255, 215, 0)}
KEEP = {'none', 'transparent', 'inherit', 'currentcolor', 'initial', 'unset'}
COLOR_RE = re.compile(r'((?:fill|stroke|stop-color|flood-color|lighting-color|color)\s*(?:=|:)\s*["\']?\s*)'
                      r'(url\([^)]*\)|#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)', re.I)
A = 480  # analysis size of the mark's long side: 1 px at 32 px is exactly 15 px here


# --- rasterizing ---------------------------------------------------------------------------------------------------

def view_box(svg_text):
    m = re.search(r'<svg\b[^>]*>', svg_text, re.S)
    tag = m.group(0) if m else ''
    vb = re.search(r'viewBox\s*=\s*["\']\s*([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)[\s,]+([-\d.eE]+)', tag)
    if vb:
        return tuple(float(x) for x in vb.groups())
    w = re.search(r'\swidth\s*=\s*["\']([\d.]+)', tag)
    h = re.search(r'\sheight\s*=\s*["\']([\d.]+)', tag)
    if w and h:
        return (0.0, 0.0, float(w.group(1)), float(h.group(1)))
    return None


def fit(svg_path, long_side):
    vb = view_box(open(svg_path, encoding='utf-8', errors='replace').read()) or (0, 0, 1, 1)
    vw, vh = max(vb[2], 1e-6), max(vb[3], 1e-6)
    if vw >= vh:
        return long_side, max(1, round(long_side * vh / vw))
    return max(1, round(long_side * vw / vh)), long_side


def rasterize(svg_path, png, long_side, tool):
    w, h = fit(svg_path, long_side)
    if tool == 'rsvg-convert':
        r = subprocess.run(['rsvg-convert', '-w', str(w), '-h', str(h), '-o', png, svg_path], capture_output=True)
        return r.returncode == 0 and os.path.exists(png)
    if tool == 'cairosvg':
        import cairosvg
        cairosvg.svg2png(url=svg_path, write_to=png, output_width=w, output_height=h)
        return os.path.exists(png)
    if tool == 'chromium':
        d = tempfile.mkdtemp(prefix='svg-')
        page = os.path.join(d, 'p.html')
        open(page, 'w').write(f'<!doctype html><html><body style="margin:0;background:transparent"><img src="file://'
                              f'{html.escape(os.path.abspath(svg_path))}" style="display:block;width:{w}px;height:{h}px"></body></html>')
        ok = chromium_shot(page, png, w, h)
        shutil.rmtree(d, ignore_errors=True)
        return ok
    return False


def pick_rasterizer():
    if shutil.which('rsvg-convert'):
        return 'rsvg-convert'
    try:
        import cairosvg  # noqa: F401
        return 'cairosvg'
    except Exception:
        pass
    return 'chromium' if find_chromium() else None


# --- reading the SVG -----------------------------------------------------------------------------------------------

def parse_color(tok):
    t = tok.strip().lower()
    if t in NAMED:
        return NAMED[t]
    if t.startswith('#'):
        h = t[1:]
        if len(h) in (3, 4):
            h = ''.join(c * 2 for c in h[:3])
        if len(h) in (6, 8):
            return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    m = re.match(r'rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)', t)
    if m:
        return tuple(round(float(v[:-1]) * 2.55) if v.endswith('%') else round(float(v)) for v in m.groups())
    return None


def svg_colors(text):
    found = {}
    for _, tok in COLOR_RE.findall(text):
        t = tok.strip().lower()
        if t in KEEP or t.startswith('url('):
            continue
        c = parse_color(t)
        key = '#%02x%02x%02x' % c if c else t
        found[key] = found.get(key, 0) + 1
    if not found:
        found['#000000'] = 1  # SVG's default fill
    return found


def luminance(rgb):
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = rgb
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def recolor(text, ink, paper):
    """Every color becomes ink, except near-white, which becomes paper (it is the paper showing through)."""
    def sub(m):
        t = m.group(2).strip().lower()
        if t in KEEP and t != 'currentcolor':
            return m.group(0)
        c = parse_color(t)
        out = paper if c is not None and luminance(c) > 0.85 else ink
        return m.group(1) + out
    out = COLOR_RE.sub(sub, text)
    # elements with no fill of their own inherit the root's (SVG's default is black)
    out = re.sub(r'<svg\b', f'<svg fill="{ink}" color="{ink}"', out, count=1)
    out = re.sub(r'(<svg\b[^>]*?)\s(fill|color)="[^"]*"([^>]*?)\s\2="[^"]*"', r'\1 \2="' + ink + r'"\3', out, count=2)
    return out


def svg_checks(path, max_colors, is_mark=True):
    text = open(path, encoding='utf-8', errors='replace').read()
    res = {}
    try:
        ET.fromstring(text.encode('utf-8'))
        ok = True
    except ET.ParseError as e:
        ok = False
        res['svg'] = ('fail', f'does not parse as XML: {e}')
    vb = view_box(text)
    if ok:
        res['svg'] = ('pass', f'viewBox {" ".join("%g" % v for v in vb)}') if vb and re.search(r'viewBox', text) else \
            ('warn', 'no viewBox: add viewBox="0 0 W H" so it scales cleanly')
    if re.search(r'<text\b', text):
        embedded = re.search(r'@font-face[^}]*src\s*:[^}]*data:', text, re.S)
        res['text'] = ('warn', 'live text with an embedded font: outline it before it goes to a printer or embroiderer') if embedded \
            else ('fail', 'live <text>: the letters change with whatever fonts the viewer has; convert them to paths (wordmark.py)')
    else:
        res['text'] = ('pass', 'all letters are paths')
    flat = [t for t in ('linearGradient', 'radialGradient', 'pattern', 'filter', 'mask', 'image', 'foreignObject')
            if re.search(r'<' + t + r'\b', text)]
    op = re.findall(r'(?:fill-|stroke-|stop-)?opacity\s*[:=]\s*["\']?\s*(0?\.\d+|0)\b', text)
    if flat:
        res['flat'] = ('fail', 'uses ' + ', '.join(flat) + ': it must read in one flat ink (sign vinyl, embroidery, a rubber stamp)')
    elif op:
        res['flat'] = ('warn', f'{len(op)} partly transparent fills: tints don\'t embroider or cut in vinyl; use a solid color')
    else:
        res['flat'] = ('pass', 'flat fills only')
    cols = svg_colors(text)
    n = len([c for c in cols if c not in ('#ffffff',)])
    res['colors'] = ('pass' if n <= max_colors else 'fail', f'{n} color{"s" * (n != 1)} besides white: {", ".join(sorted(cols))}'
                     + ('' if n <= max_colors else f' (at most {max_colors})'))
    # stroke widths from attributes: a first pass before the pixels say for sure
    if vb:
        # the mark at 32 px on its long side; a lockup at 40 px on its short side (a website header)
        scale, at = (32 / max(vb[2], vb[3]), '32 px') if is_mark else (40 / min(vb[2], vb[3]), '40 px tall')
        thin = []
        for m in re.finditer(r'<(\w+)\b([^>]*)>', text):
            attrs = m.group(2)
            if re.search(r'stroke\s*[:=]\s*["\']?\s*(?!none)[#\w(]', attrs):
                sw = re.search(r'stroke-width\s*[:=]\s*["\']?\s*([\d.]+)', attrs)
                w = float(sw.group(1)) if sw else 1.0
                if w * scale < 1:
                    thin.append(f'<{m.group(1)}> stroke-width {w:g} = {w * scale:.2f} px at {at}')
        res['strokes'] = ('fail', '; '.join(thin[:4])) if thin else ('pass', f'no stroke under 1 px at {at}')
    return res, cols, text


# --- measuring the pixels --------------------------------------------------------------------------------------------

def ink_mask(png, pad):
    """1-bit-ish L image: 255 where there is ink (opaque and dark) in a one-color render, padded with paper."""
    im = Image.open(png).convert('RGBA')
    white = Image.new('RGBA', im.size, (255, 255, 255, 255))
    flat = Image.alpha_composite(white, im).convert('L')
    m = flat.point(lambda v: 255 if v < 128 else 0)
    out = Image.new('L', (im.width + 2 * pad, im.height + 2 * pad), 0)
    out.paste(m, (pad, pad))
    return out


def erode(m, n):
    for _ in range(n):
        m = m.filter(ImageFilter.MinFilter(3))
    return m


def dilate(m, n):
    for _ in range(n):
        m = m.filter(ImageFilter.MaxFilter(3))
    return m


def count(m):
    return m.histogram()[255]


def thin_parts(m, p):
    """Ink and gaps narrower than 2p+1 px: (thin ink, thin gaps) as 255-masks."""
    opened = dilate(erode(m, p), p)
    thin = ImageChops.subtract(m, opened)
    closed = erode(dilate(m, p), p)
    gaps = ImageChops.subtract(closed, m)
    return thin, gaps


def finest(m, total, limit=60, share=0.01):
    """Width in px (2p+1) of the finest strokes, and of the finest gaps, that still hold at least `share` of the ink."""
    e, d, ink_w, gap_w = m, m, None, None
    for p in range(1, limit + 1):
        if ink_w is None:
            e = e.filter(ImageFilter.MinFilter(3))
            if count(ImageChops.subtract(m, dilate(e, p))) > share * total:
                ink_w = 2 * p - 1
        if gap_w is None:
            d = d.filter(ImageFilter.MaxFilter(3))
            if count(ImageChops.subtract(erode(d, p), m)) > share * total:
                gap_w = 2 * p - 1
        if ink_w is not None and gap_w is not None:
            break
    return ink_w or 2 * limit + 1, gap_w or 2 * limit + 1


def edge_map(rgb, thresh=40):
    d1 = ImageChops.difference(rgb, ImageChops.offset(rgb, -1, 0))
    d2 = ImageChops.difference(rgb, ImageChops.offset(rgb, 0, -1))
    r, g, b = ImageChops.lighter(d1, d2).split()
    return ImageChops.lighter(ImageChops.lighter(r, g), b).point(lambda v: 255 if v > thresh else 0)


def on_white(png, pad):
    im = Image.open(png).convert('RGBA')
    flat = Image.alpha_composite(Image.new('RGBA', im.size, (255, 255, 255, 255)), im).convert('RGB')
    out = Image.new('RGB', (im.width + 2 * pad, im.height + 2 * pad), (255, 255, 255))
    out.paste(flat, (pad, pad))
    return out


def magenta(png, thin, gaps, pad, out):
    base = on_white(png, pad).convert('RGBA')
    hot = ImageChops.lighter(thin, gaps)
    layer = Image.new('RGBA', base.size, (255, 0, 160, 255))
    base.paste(layer, (0, 0), dilate(hot, 1))
    base.crop((pad, pad, base.width - pad, base.height - pad)).save(out)


# --- the sheet --------------------------------------------------------------------------------------------------------

SHEET_CSS = """
:root{--ink:#1b1b1b;--muted:#5d5d5d;--rule:#d9d6d0;--paper:#ffffff;--ground:#f4f2ee}
*{box-sizing:border-box}body{margin:0;background:var(--ground);color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.sheet{width:1200px;padding:48px}
header{display:flex;justify-content:space-between;align-items:baseline;border-bottom:2px solid var(--ink);padding-bottom:14px;margin-bottom:28px}
h1{font-size:30px;margin:0;letter-spacing:-.01em}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0 0 12px;color:var(--muted)}
section{margin-bottom:32px}.row{display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start}
.tile{background:var(--paper);border:1px solid var(--rule);padding:20px;display:flex;flex-direction:column;gap:10px}
.cap{font-size:12px;color:var(--muted)}
.clear{position:relative;outline:1.5px dashed #c2410c;outline-offset:0;background:repeating-linear-gradient(45deg,#fff3ec 0 6px,#fff 6px 12px)}
.clear img{display:block;background:var(--paper)}
.px{image-rendering:pixelated;image-rendering:crisp-edges;display:block}
.dark{background:var(--darkc)}.dark .cap{color:#cfcac2}
.chip{width:120px}.chip>div:first-child{height:64px;border:1px solid var(--rule)}
table{border-collapse:collapse;width:100%;background:var(--paper)}td{border-top:1px solid var(--rule);padding:7px 10px;vertical-align:top}
.pass{color:#166534;font-weight:600}.warn{color:#92400e;font-weight:600}.fail{color:#b91c1c;font-weight:700}
"""


def sheet_html(name, files, rep, out, dark, clear, plain=False):
    mark = files[0]
    stem = lambda f: os.path.splitext(os.path.basename(f))[0]
    m = stem(mark)
    e = html.escape
    parts = [f'<!doctype html><html><head><meta charset="utf-8"><title>{e(name)} logo sheet</title><style>{SHEET_CSS}'
             f'.dark{{--darkc:{e(dark)}}}</style></head><body><div class="sheet">']
    fails = sum(1 for f in rep['files'].values() for c in f['checks'].values() if c[0] == 'fail')
    if plain:
        parts.append(f'<header><h1>{e(name)}</h1></header>')
    warns = sum(1 for f in rep['files'].values() for c in f['checks'].values() if c[0] == 'warn')
    if not plain:
        parts.append(f'<header><h1>{e(name)} &nbsp;<span style="font-weight:400;color:#5d5d5d">logo sheet</span></h1>'
                 f'<div class="cap">{fails} failing, {warns} warnings, measured by logo_check.py</div></header>')
    # lockups with clear space
    parts.append('<section><h2>Lockups, with clear space (hatched)</h2><div class="row">')
    for f in files[1:] + [mark]:
        s = stem(f)
        w, h = fit(f, 360 if f != mark else 200)
        padx = round(min(w, h) * clear)
        parts.append(f'<div class="tile"><div class="clear" style="padding:{padx}px"><img src="{e(os.path.basename(f))}" width="{w}" height="{h}"></div>'
                     f'<div class="cap">{e(s)}: clear space {round(clear * 100)}% of its height on every side</div></div>')
    parts.append('</div></section>')
    # sizes
    parts.append('<section><h2>The mark at size (actual pixels, then magnified 8 times)</h2><div class="row">')
    for size in (512, 64, 32, 16):
        p = f'{m}-{size}.png'
        if os.path.exists(os.path.join(out, p)):
            shown = 160 if size == 512 else size
            w, h = fit(mark, shown)
            parts.append(f'<div class="tile"><img class="px" src="{p}" width="{w}" height="{h}"><div class="cap">{size} px'
                         f'{" (shown at 160)" if size == 512 else ""}</div></div>')
    for size in (32, 16):
        p = f'{m}-{size}.png'
        if os.path.exists(os.path.join(out, p)):
            w, h = fit(mark, size * 8)
            parts.append(f'<div class="tile"><img class="px" src="{p}" width="{w}" height="{h}"><div class="cap">{size} px, 8x</div></div>')
    parts.append('</div></section>')
    # one color and reversed
    parts.append('<section><h2>One color and reversed</h2><div class="row">')
    for f in files:
        s = stem(f)
        w, h = fit(f, 260 if f != mark else 120)
        parts.append(f'<div class="tile"><img src="{e(s)}-1c.svg" width="{w}" height="{h}"><div class="cap">{e(s)}, one ink</div></div>')
        parts.append(f'<div class="tile dark"><img src="{e(s)}-rev.svg" width="{w}" height="{h}"><div class="cap">{e(s)}, reversed</div></div>')
    parts.append('</div></section>')
    # colors
    cols = sorted(set(c for f in rep['files'].values() for c in f['colors']))
    parts.append('<section><h2>Colors in the files</h2><div class="row">')
    for c in cols:
        parts.append(f'<div class="chip"><div style="background:{e(c)}"></div><div class="cap">{e(c)}</div></div>')
    parts.append('</div></section>')
    if plain:  # the pictures only, for a judge who should look rather than read our numbers
        parts.append('</div></body></html>')
        p = os.path.join(out, 'sheet.html')
        open(p, 'w', encoding='utf-8').write('\n'.join(parts))
        return p
    # measured
    parts.append('<section><h2>Measured</h2><table>')
    for f, r in rep['files'].items():
        sz = r.get('min_size')
        if sz:
            parts.append(f'<tr><td><b>{e(f)}</b></td><td>Minimum size</td><td>{e(sz["text"])}</td></tr>')
        for k, (state, msg) in r['checks'].items():
            parts.append(f'<tr><td>{e(f)}</td><td>{e(k)}</td><td><span class="{state}">{state}</span> {e(msg)}</td></tr>')
    parts.append('</table></section>')
    thin = [f'{stem(f)}-thin.png' for f in files if os.path.exists(os.path.join(out, f'{stem(f)}-thin.png'))]
    if thin:
        parts.append('<section><h2>Too thin (magenta): thicken these strokes or open these gaps</h2><div class="row">')
        for t in thin:
            parts.append(f'<div class="tile"><img src="{e(t)}" style="max-width:520px;max-height:300px"><div class="cap">{e(t)}</div></div>')
        parts.append('</div></section>')
    parts.append('</div></body></html>')
    p = os.path.join(out, 'sheet.html')
    open(p, 'w', encoding='utf-8').write('\n'.join(parts))
    return p


def trim_bottom(png, bg=(244, 242, 238)):
    im = Image.open(png).convert('RGB')
    w, h = im.size
    px = im.load()
    y = h - 1
    while y > 0 and all(abs(px[x, y][i] - bg[i]) < 3 for x in range(0, w, 7) for i in range(3)):
        y -= 1
    im.crop((0, 0, w, min(h, y + 40))).save(png)


# --- main ------------------------------------------------------------------------------------------------------------

def check_file(path, is_mark, a, tool, out):
    s = os.path.splitext(os.path.basename(path))[0]
    checks, cols, text = svg_checks(path, a.max_colors, is_mark)
    r = {'checks': checks, 'colors': sorted(cols)}
    one = os.path.join(out, f'{s}-1c.svg')
    open(one, 'w', encoding='utf-8').write(recolor(text, '#000000', '#ffffff'))
    open(os.path.join(out, f'{s}-rev.svg'), 'w', encoding='utf-8').write(recolor(text, '#ffffff', a.dark))
    shutil.copy(path, os.path.join(out, os.path.basename(path))) if os.path.abspath(os.path.dirname(path)) != os.path.abspath(out) else None
    if not (tool and Image):
        checks['pixels'] = ('warn', 'not measured: ' + ('install Pillow' if not Image else 'no rasterizer (rsvg-convert, cairosvg or Chromium)'))
        return r
    for size in (16, 32, 64, 512):
        rasterize(path, os.path.join(out, f'{s}-{size}.png'), size, tool)
    long_side = A if is_mark else 2 * A
    big, big1 = os.path.join(out, f'.{s}-a.png'), os.path.join(out, f'.{s}-a1.png')
    if not (rasterize(path, big, long_side, tool) and rasterize(one, big1, long_side, tool)):
        checks['pixels'] = ('warn', f'{tool} could not render it')
        return r
    pad = 70
    m = ink_mask(big1, pad)
    ink = count(m)
    if ink == 0:
        checks['pixels'] = ('fail', 'renders empty in one color')
        return r
    w, h = Image.open(big).size
    # what is too thin at 32 px (mark) and at 1 inch embroidered
    px_per_px32 = long_side / 32
    p32 = max(1, round((px_per_px32 - 1) / 2))
    thin, gaps = thin_parts(m, p32)
    t, g = count(thin) / ink, count(gaps) / ink
    if is_mark:
        bad = t > 0.01 or g > 0.01
        checks['hairlines'] = ('fail' if bad else 'pass',
                               f'at 32 px, strokes under 1 px are {t:.1%} of the ink and gaps under 1 px {g:.1%}' + (' (the magenta in the sheet)' if bad else ''))
        if bad:
            magenta(big, thin, gaps, pad, os.path.join(out, f'{s}-thin.png'))
        mm = long_side / 25.4  # px per mm at 1 inch
        pe = max(1, round((mm - 1) / 2))
        te, ge = thin_parts(m, pe)
        e1 = count(te) / ink + count(ge) / ink
        checks['embroidery'] = ('fail' if e1 > 0.02 else 'pass', f'{e1:.1%} of the mark is finer than 1 mm when it is 1 inch wide')
        p16 = max(1, round((long_side / 16 - 1) / 2))
        t16, g16 = thin_parts(m, p16)
        l16 = (count(t16) + count(g16)) / ink
        checks['favicon-16'] = ('warn' if l16 > 0.12 else 'pass', f'{l16:.0%} of the mark is finer than 1 px at 16 px'
                                + ('; draw a simpler favicon (fewer parts, thicker)' if l16 > 0.12 else ''))
    # the finest feature that matters, and from it the smallest sizes
    ink_w, gap_w = finest(m, ink)
    fw = min(ink_w, gap_w)
    short = min(w, h)
    min_px = long_side / fw  # long side at which the finest feature is 1 px
    min_short_px = min_px * short / max(w, h)
    emb_mm = long_side / fw  # 1 mm features
    print_mm = 0.15 * long_side / fw  # 0.15 mm, a fine offset or laser line
    r['min_size'] = {'finest_stroke_px': ink_w, 'finest_gap_px': gap_w, 'analysis_long_px': long_side, 'screen_long_px': round(min_px), 'screen_short_px': round(min_short_px),
                     'print_mm': round(print_mm, 1), 'embroidery_mm': round(emb_mm, 1),
                     'text': f'{round(min_px)} px wide on screen ({round(min_short_px)} px tall), {max(round(print_mm, 1), 6.0):g} mm printed, '
                             f'{round(emb_mm)} mm embroidered'}
    if not is_mark:
        checks['embroidery'] = ('pass' if emb_mm <= 100 else 'warn', f'embroiders from {round(emb_mm)} mm wide'
                                + ('' if emb_mm <= 100 else '; too fine for a left-chest logo (about 90 mm): use the mark there'))
        checks['small-header'] = ('pass' if min_short_px <= 40 else 'warn', f'holds 1 px detail from {round(min_short_px)} px tall'
                                  + ('' if min_short_px <= 40 else '; too fine for a 40 px website header: thicken the wordmark or use the mark'))
    # one color: edges that only color separates
    col = on_white(big, 4)
    mono = on_white(big1, 4).convert('L').point(lambda v: 255 if v < 128 else 0).convert('RGB')
    ce, me = edge_map(col), dilate(edge_map(mono), 2)
    lost = count(ImageChops.subtract(ce, me)) / max(1, count(ce))
    checks['one-color'] = ('fail' if lost > 0.08 else 'warn' if lost > 0.03 else 'pass',
                           f'{lost:.0%} of its edges vanish in one ink' + (': two colors touch with nothing else separating them' if lost > 0.03 else ''))
    # background box
    im = Image.open(big).convert('RGBA')
    corners = [im.getpixel((x, y))[3] for x, y in ((1, 1), (w - 2, 1), (1, h - 2), (w - 2, h - 2))]
    checks['transparent'] = ('warn', 'the corners are opaque: if that is a background box, take it out') if min(corners) > 200 else ('pass', 'transparent background')
    for f in (big, big1):
        os.remove(f)
    return r


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('files', nargs='+', help='the mark first, then the lockups')
    ap.add_argument('--name', default='')
    ap.add_argument('--max-colors', type=int, default=3)
    ap.add_argument('--dark', default='#1d1d1f', help='ground for the reversed version')
    ap.add_argument('--clear', type=float, default=0.25, help='clear space as a share of the height')
    ap.add_argument('--out', default='logo-check')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--plain', action='store_true', help='a sheet of pictures only, without the measured table')
    a = ap.parse_args()
    for f in a.files:
        if not os.path.exists(f):
            sys.exit(f'no such file: {f}')
    os.makedirs(a.out, exist_ok=True)
    tool = pick_rasterizer()
    rep = {'rasterizer': tool, 'pillow': bool(Image), 'files': {}}
    for i, f in enumerate(a.files):
        rep['files'][os.path.basename(f)] = check_file(f, i == 0, a, tool, a.out)
    name = a.name or os.path.splitext(os.path.basename(a.files[0]))[0]
    page = sheet_html(name, [os.path.join(a.out, os.path.basename(f)) for f in a.files], rep, a.out, a.dark, a.clear, a.plain)
    png = os.path.join(a.out, 'sheet.png')
    rep['sheet_html'] = page
    if Image and find_chromium() and chromium_shot(page, png, 1200, 3200):
        trim_bottom(png)
        rep['sheet_png'] = png
    json.dump(rep, open(os.path.join(a.out, 'report.json'), 'w'), indent=1)
    failed = False
    for f, r in rep['files'].items():
        if not a.json:
            print(f'\n{f}')
            if r.get('min_size'):
                print(f'  minimum size: {r["min_size"]["text"]}')
        for k, (state, msg) in r['checks'].items():
            failed |= state == 'fail'
            if not a.json:
                print(f'  {state.upper():<4} {k}: {msg}')
    if a.json:
        print(json.dumps(rep, indent=1))
    else:
        print(f'\nSheet: {rep.get("sheet_png") or page}' + ('' if rep.get('sheet_png') else ' (no Chromium to render it: open the HTML)'))
        print('Rasterizer:', tool or 'none, so only the SVG checks ran')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()

