#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""brand_guide.py: check a brand.json and lay it out as a one-page brand guide.

  python3 brand_guide.py brand.json [--out guide] [--check] [--offline]

You fill brand.json (templates/brand.json shows every field); this script does the arithmetic and the layout:
  - checks every field the guide needs, and the lengths that keep it to one page;
  - works out the WCAG contrast of every text and background pair, says which pass for body text (4.5:1), large text
    and controls (3:1), and for a failing pair finds the nearest color that passes;
  - writes <out>/guide.html (letter size, one page), and with Chromium <out>/guide.png (1275 x 1650) and guide.pdf,
    and checks that the page did not overflow;
  - writes <out>/contrast.json.
--check stops after the checks. Exits 1 on a failing check. Fonts load from Google Fonts, so the families must be
there. Standard library; Chromium (Playwright's or on PATH) for the PNG and PDF."""
import argparse, base64, colorsys, html, json, os, re, sys, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from browser import chromium_dom, chromium_shot, find_chromium  # noqa: E402

ROLES = ('ground', 'surface', 'ink', 'muted', 'accent', 'on-accent', 'support')
NEEDS = {'body': 4.5, 'small': 4.5, 'large': 3.0, 'ui': 3.0}
PAGE_W, PAGE_H = 816, 1056  # US letter at 96 CSS px per inch
LIMITS = {'summary': 160, 'voice line': 90, 'example': 110, 'imagery rule': 90, 'color use': 60}


def hex_rgb(h):
    h = h.strip().lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    if not re.fullmatch(r'[0-9a-fA-F]{6}', h):
        raise ValueError(f'#{h} is not a 6-digit hex color')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def lum(rgb):
    f = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (x / 255 for x in rgb)
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def ratio(a, b):
    la, lb = lum(hex_rgb(a)), lum(hex_rgb(b))
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def nearest_passing(text, bg, need):
    """The text color moved in lightness only (hue and saturation kept) until it passes against bg."""
    r, g, b = (x / 255 for x in hex_rgb(text))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    darker = lum(hex_rgb(bg)) > 0.18
    for i in range(1, 101):
        nl = max(0.0, l - i / 100) if darker else min(1.0, l + i / 100)
        c = '#%02x%02x%02x' % tuple(round(v * 255) for v in colorsys.hls_to_rgb(h, nl, s))
        if ratio(c, bg) >= need:
            return c
    return '#000000' if darker else '#ffffff'


def load(path):
    try:
        return json.load(open(path, encoding='utf-8'))
    except ValueError as e:
        sys.exit(f'{path} is not valid JSON: {e}')


def check(b, base):
    fails, warns = [], []
    for k in ('name', 'summary', 'colors', 'type', 'voice', 'imagery', 'logo'):
        if not b.get(k):
            fails.append(f'missing "{k}"')
    if fails:
        return fails, warns, {}, []
    if len(b['summary']) > LIMITS['summary']:
        warns.append(f'summary is {len(b["summary"])} characters; keep it under {LIMITS["summary"]} so the page holds')
    cols = {}
    for c in b['colors']:
        try:
            hex_rgb(c.get('hex', ''))
        except ValueError as e:
            fails.append(f'color {c.get("name")}: {e}')
            continue
        if c.get('role') not in ROLES:
            fails.append(f'color {c.get("name")}: role must be one of {", ".join(ROLES)}')
        elif c['role'] in cols:
            fails.append(f'two colors have the role {c["role"]}')
        else:
            cols[c['role']] = c
        if len(c.get('use', '')) > LIMITS['color use']:
            warns.append(f'color {c.get("name")}: "use" over {LIMITS["color use"]} characters')
    for r in ('ground', 'ink', 'accent'):
        if r not in cols:
            fails.append(f'no color with the role "{r}"')
    if len(b['colors']) > 6:
        fails.append(f'{len(b["colors"])} colors: a brand needs at most 6 (ground, surface, ink, muted, accent, on-accent)')
    t = b['type']
    for k in ('display', 'text'):
        if not (t.get(k) or {}).get('family'):
            fails.append(f'type.{k}.family is missing')
    if not t.get('scale'):
        fails.append('type.scale is missing: list the sizes, largest first')
    else:
        px = [s.get('px') for s in t['scale']]
        if any(not isinstance(p, (int, float)) for p in px):
            fails.append('every type.scale step needs a number "px"')
        elif px != sorted(px, reverse=True):
            fails.append('type.scale must run largest to smallest')
        else:
            if min(px) < 12:
                fails.append(f'the smallest size is {min(px)} px; nothing under 12')
            close = [(a, c) for a, c in zip(px, px[1:]) if a / c < 1.12]
            if close:
                warns.append('scale steps too close to tell apart: ' + ', '.join(f'{a} and {c}' for a, c in close))
    v = b['voice']
    if len(v.get('lines') or []) != 3:
        fails.append('voice.lines needs exactly three lines')
    for line in v.get('lines') or []:
        if len(line) > LIMITS['voice line']:
            warns.append(f'voice line over {LIMITS["voice line"]} characters: "{line[:40]}..."')
    pairs = v.get('examples') or []
    if not pairs or any(not (p.get('do') and p.get('dont')) for p in pairs):
        fails.append('voice.examples needs one to three {"do": ..., "dont": ...} pairs')
    for p in pairs:
        for k in ('do', 'dont'):
            if len(p.get(k, '')) > LIMITS['example']:
                warns.append(f'voice example over {LIMITS["example"]} characters: "{p[k][:40]}..."')
    im = b['imagery']
    if not im.get('do') or not im.get('dont'):
        fails.append('imagery needs "do" and "dont" lists')
    for f in ('horizontal', 'mark'):
        p = (b['logo'] or {}).get(f)
        if not p:
            fails.append(f'logo.{f} is missing')
        elif not os.path.exists(os.path.join(base, p)):
            fails.append(f'logo.{f}: no file {p}')
    # contrast
    want = [('ink', 'ground', 'body'), ('muted', 'ground', 'small'), ('on-accent', 'accent', 'body'), ('accent', 'ground', 'ui'),
            ('ink', 'surface', 'body'), ('muted', 'surface', 'small')]
    want += [(p['text'], p['on'], p.get('use', 'body')) for p in b.get('pairs') or []]
    table, seen = [], set()
    for tr, br, use in want:
        if tr not in cols or br not in cols or (tr, br) in seen:
            continue
        seen.add((tr, br))
        need = NEEDS.get(use, 4.5)
        r = ratio(cols[tr]['hex'], cols[br]['hex'])
        row = {'text': tr, 'on': br, 'use': use, 'ratio': round(r, 2), 'need': need, 'pass': r >= need}
        if not row['pass']:
            row['fix'] = nearest_passing(cols[tr]['hex'], cols[br]['hex'], need)
            fails.append(f'{tr} {cols[tr]["hex"]} on {br} {cols[br]["hex"]} is {r:.2f}:1, under {need}:1 for {use} text; '
                         f'{row["fix"]} reaches {ratio(row["fix"], cols[br]["hex"]):.2f}:1')
        table.append(row)
    return fails, warns, cols, table


def fonts_url(t):
    fams = []
    for k in ('display', 'text'):
        f = t.get(k) or {}
        if f.get('family'):
            w = sorted({int(f.get('weight', 400)), 400} if k == 'text' else {int(f.get('weight', 700))})
            fams.append(f'family={urllib.parse.quote_plus(f["family"])}:wght@{";".join(map(str, w))}')
    return 'https://fonts.googleapis.com/css2?' + '&'.join(dict.fromkeys(fams)) + '&display=block'


def on_google(url):
    try:
        urllib.request.urlopen(url, timeout=8).read(64)
        return True
    except urllib.error.HTTPError:
        return False
    except Exception:
        return None


def data_uri(path):
    return 'data:image/svg+xml;base64,' + base64.b64encode(open(path, 'rb').read()).decode()


def page(b, base, cols, table):
    e = html.escape
    c = lambda r, d: cols[r]['hex'] if r in cols else d
    ground, ink, accent = c('ground', '#ffffff'), c('ink', '#111111'), c('accent', '#333333')
    surface, muted, on_acc = c('surface', ground), c('muted', ink), c('on-accent', '#ffffff')
    t = b['type']
    disp, text = t['display'], t['text']
    lg = b['logo']
    horiz = data_uri(os.path.join(base, lg['horizontal']))
    mark = data_uri(os.path.join(base, lg['mark']))
    chips = []
    for col in b['colors']:
        best = max((x['hex'] for x in b['colors']), key=lambda x: ratio(x, col['hex']))
        chips.append(f'<div class="chip"><div class="sw" style="background:{e(col["hex"])};color:{e(best)}">Aa'
                     f'<small>{ratio(best, col["hex"]):.1f}:1</small></div><b>{e(col.get("name", ""))}</b>'
                     f'<span>{e(col["role"])} · {e(col["hex"].lower())}</span><span>{e(col.get("use", ""))}</span></div>')
    rows = ''.join(f'<tr><td><i style="background:{e(cols[r["text"]]["hex"])}"></i>{e(r["text"])} on '
                   f'<i style="background:{e(cols[r["on"]]["hex"])}"></i>{e(r["on"])}</td><td>{r["ratio"]:.2f}:1</td>'
                   f'<td class="{"ok" if r["pass"] else "no"}">{"passes" if r["pass"] else "fails"} {e(r["use"])}</td></tr>' for r in table)
    scale = ''.join(f'<li><span style="font-family:var(--{"d" if i < 2 else "t"});font-weight:{disp.get("weight", 700) if i < 2 else text.get("weight", 400)};'
                    f'font-size:{min(s["px"], 28)}px;line-height:1.1">{e(s.get("name", ""))}</span><em>{s["px"]} px</em></li>'
                    for i, s in enumerate(t['scale']))
    voice = ''.join(f'<li>{e(x)}</li>' for x in b['voice']['lines'])
    ex = ''.join(f'<div class="ex"><p><b>Say</b> {e(p["do"])}</p><p><b>Not</b> {e(p["dont"])}</p></div>' for p in b['voice']['examples'][:3])
    img_do = ''.join(f'<li>{e(x)}</li>' for x in b['imagery']['do'][:4])
    img_dont = ''.join(f'<li>{e(x)}</li>' for x in b['imagery']['dont'][:4])
    files = ', '.join(e(v) for k, v in lg.items() if isinstance(v, str) and v.endswith('.svg'))
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{e(b['name'])} brand guide</title>
<link rel="stylesheet" href="{e(fonts_url(t))}">
<style>
@page{{size:letter;margin:0}}
:root{{--ground:{ground};--surface:{surface};--ink:{ink};--muted:{muted};--accent:{accent};--on-accent:{on_acc};
--d:"{e(disp['family'])}",Georgia,serif;--t:"{e(text['family'])}",system-ui,sans-serif}}
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:{PAGE_W}px;height:{PAGE_H}px;overflow:hidden;background:var(--ground)}}
body{{color:var(--ink);font:400 11px/1.45 var(--t);font-weight:{text.get('weight', 400)}}}
.page{{width:{PAGE_W}px;height:{PAGE_H}px;padding:44px 48px 36px;display:grid;grid-template-rows:auto auto 1fr auto;gap:22px}}
header{{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid var(--ink);padding-bottom:14px}}
header img{{height:46px;display:block}}
header .lab{{font:600 10px/1 var(--t);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);text-align:right}}
.lede{{font:{disp.get('weight', 700)} 20px/1.25 var(--d);max-width:36em;text-wrap:balance}}
.lede small{{display:block;font:400 11px/1.4 var(--t);color:var(--muted);margin-top:6px}}
.cols{{display:grid;grid-template-columns:1fr 228px;gap:36px;min-height:0}}
h2{{font:600 9.5px/1 var(--t);letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 9px;display:flex;gap:8px;align-items:center}}
h2::after{{content:"";flex:1;height:1px;background:color-mix(in srgb,var(--ink) 18%,transparent)}}
section+section{{margin-top:18px}}
.logos{{display:grid;grid-template-columns:1.35fr 1fr .62fr;gap:8px}}
.tile{{background:var(--surface);height:72px;display:grid;place-items:center;padding:14px;border:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}}
.tile img{{max-width:100%;max-height:44px;width:auto;height:auto}}.tile.rev{{background:var(--ink)}}.tile.rev img{{filter:brightness(0) invert(1)}}
.tile.acc{{background:var(--accent)}}.tile.acc img{{filter:brightness(0) invert(1)}}
.note{{color:var(--muted);margin-top:6px}}
.chips{{display:grid;grid-template-columns:repeat(3,1fr);gap:10px 8px}}
.chip b{{display:block;font-weight:600;margin-top:5px}}.chip span{{display:block;color:var(--muted);font-size:10px;line-height:1.35}}
.sw{{height:46px;padding:7px 8px;font:{disp.get('weight', 700)} 18px/1 var(--d);display:flex;justify-content:space-between;align-items:flex-start;border:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}}
.sw small{{font:500 9px/1 var(--t)}}
table{{width:100%;border-collapse:collapse;margin-top:10px;font-size:10px}}td{{padding:3px 0;border-top:1px solid color-mix(in srgb,var(--ink) 12%,transparent)}}
td i{{display:inline-block;width:9px;height:9px;border:1px solid color-mix(in srgb,var(--ink) 30%,transparent);margin:0 4px -1px 0}}
td.ok{{color:var(--ink)}}td.no{{font-weight:700;color:#b42318}}
.spec{{display:grid;grid-template-columns:1fr 1fr;gap:14px}}
.big{{font:{disp.get('weight', 700)} 28px/1.05 var(--d);letter-spacing:-.01em}}
.fam{{color:var(--muted);margin-top:4px}}.fam b{{color:var(--ink)}}
.scale{{list-style:none;display:grid;gap:3px}}.scale li{{display:flex;justify-content:space-between;align-items:baseline;gap:8px;border-top:1px solid color-mix(in srgb,var(--ink) 10%,transparent);padding-top:3px}}
.scale em{{font-style:normal;color:var(--muted);font-size:9.5px;white-space:nowrap}}
.voice{{padding-left:16px;display:grid;gap:5px;font:{disp.get('weight', 700)} 13px/1.3 var(--d)}}
.voice li::marker{{color:var(--accent);font:600 11px var(--t)}}
.ex{{margin-top:9px;display:grid;gap:3px}}.ex p{{padding-left:36px;text-indent:-36px}}.ex b{{display:inline-block;width:32px;text-indent:0;font-weight:600;color:var(--accent)}}
.ex p+p{{color:var(--muted)}}.ex p+p b{{color:var(--muted)}}
ul.rules{{padding-left:14px;display:grid;gap:3px}}.rules+h3{{margin-top:8px}}
h3{{font:600 10px/1 var(--t);margin-bottom:5px}}
footer{{display:flex;justify-content:space-between;color:var(--muted);font-size:9.5px;border-top:1px solid color-mix(in srgb,var(--ink) 18%,transparent);padding-top:8px}}
</style></head><body><div class="page">
<header><img src="{horiz}" alt="{e(b['name'])}"><div class="lab">Brand guide<br><br>{e(b.get('date', ''))}</div></header>
<div class="lede">{e(b['summary'])}{f'<small>For {e(b["audience"])}</small>' if b.get('audience') else ''}</div>
<div class="cols"><div>
<section><h2>Logo</h2><div class="logos"><div class="tile"><img src="{horiz}" alt=""></div><div class="tile rev"><img src="{horiz}" alt=""></div><div class="tile acc"><img src="{mark}" alt=""></div></div>
<p class="note">{e(lg.get('clear_space', 'Clear space: the height of the mark’s top block on every side.'))} {e(lg.get('min_size', ''))}</p></section>
<section><h2>Color</h2><div class="chips">{''.join(chips)}</div><table>{rows}</table></section>
<section><h2>Type</h2><div class="spec"><div><div class="big" style="font-family:var(--d)">{e(b['name'])}</div>
<p class="fam"><b>{e(disp['family'])}</b> {e(str(disp.get('weight', 700)))}, {e(disp.get('use', 'headlines'))}<br><b>{e(text['family'])}</b> {e(str(text.get('weight', 400)))}, {e(text.get('use', 'text'))}<br>Both from Google Fonts, free to use.</p></div>
<ul class="scale">{scale}</ul></div></section>
</div><div>
<section><h2>Voice</h2><ol class="voice">{voice}</ol>{ex}</section>
<section><h2>Imagery</h2><h3>Do</h3><ul class="rules">{img_do}</ul><h3>Don’t</h3><ul class="rules">{img_dont}</ul></section>
</div></div>
<footer><span>{e(b['name'])} · files: {files}</span><span>Made with Hildegard</span></footer>
</div></body></html>"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('brand')
    ap.add_argument('--out', default='guide')
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--offline', action='store_true', help="don't ask Google Fonts whether the families exist")
    a = ap.parse_args()
    b = load(a.brand)
    base = os.path.dirname(os.path.abspath(a.brand))
    fails, warns, cols, table = check(b, base)
    if not fails and b.get('type') and not a.offline:
        g = on_google(fonts_url(b['type']))
        if g is False:
            fails.append('Google Fonts does not serve that family or weight: check the names on fonts.google.com')
        elif g is None:
            warns.append('could not reach Google Fonts to check the families (offline?)')
    print('Contrast (WCAG 2): body and small text need 4.5:1, large text and controls 3:1')
    for r in table:
        print(f'  {"PASS" if r["pass"] else "FAIL"} {r["text"]:<9} on {r["on"]:<8} {r["ratio"]:>5.2f}:1  ({r["use"]}, needs {r["need"]})'
              + (f'  try {r["fix"]}' if not r['pass'] else ''))
    for w in warns:
        print('WARN', w)
    for f in fails:
        print('FAIL', f)
    os.makedirs(a.out, exist_ok=True)
    json.dump(table, open(os.path.join(a.out, 'contrast.json'), 'w'), indent=1)
    if fails or a.check:
        sys.exit(1 if fails else 0)
    p = os.path.join(a.out, 'guide.html')
    open(p, 'w', encoding='utf-8').write(page(b, base, cols, table))
    print(f'\nWrote {p}')
    chrome = find_chromium()
    if not chrome:
        print('No Chromium: open guide.html in a browser and print it to PDF on letter paper, no margins.')
        return
    fit = chromium_dom(p, PAGE_W, PAGE_H, '(()=>{const pg=d.querySelector(".page");const ft=d.querySelector("footer").getBoundingClientRect().top;'
                                        'const over=[...d.querySelectorAll(".cols *")].filter(n=>{const r=n.getBoundingClientRect();'
                                        'return r.height>0&&r.bottom>ft+1}).map(n=>(n.textContent||n.tagName).trim().slice(0,30));'
                                        'return {over,inner:pg.scrollHeight}})()')
    if fit is None:
        print('WARN could not measure whether the page fits; look at guide.png for anything running into the footer')
    elif fit.get('over') or fit.get('inner', 0) > PAGE_H + 1:
        print(f'FAIL the guide runs past one page, into the footer at: {", ".join(fit.get("over", [])[:5])}. '
              'Shorten the longest texts (voice examples, imagery rules, color uses) or drop a scale step')
        sys.exit(1)
    png = os.path.join(a.out, 'guide.png')
    if chromium_shot(p, png, PAGE_W, PAGE_H, chrome, scale=1275 / PAGE_W):
        print(f'Wrote {png}')
    import subprocess
    pdf = os.path.abspath(os.path.join(a.out, 'guide.pdf'))
    args = [chrome, '--no-sandbox', '--disable-gpu', '--virtual-time-budget=8000', '--no-pdf-header-footer',
            '--print-to-pdf-no-header', f'--print-to-pdf={pdf}', 'file://' + os.path.abspath(p)]
    if 'headless-shell' not in os.path.basename(chrome):
        args.insert(1, '--headless=new')
    subprocess.run(args, capture_output=True, timeout=120)
    if os.path.exists(pdf):
        print(f'Wrote {pdf}')
    print('Now look at guide.png at full size: every section, every number.')


if __name__ == '__main__':
    main()
