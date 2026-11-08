#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""lockup.py: put the mark and the wordmark together, by ratio, as one SVG.

  python3 lockup.py mark.svg wordmark.svg --layout horizontal [--mark-scale 1.5] [--gap 0.4] [--out logo-horizontal.svg]
  python3 lockup.py mark.svg wordmark.svg --layout stacked    [--mark-scale 2.5] [--gap 0.35] [--out logo-stacked.svg]

horizontal  the mark's height is --mark-scale times the wordmark's cap height (default 1.5); the mark's middle sits on
            the middle of the capitals; the gap is --gap times the mark's height (default 0.4).
stacked     the mark above, centered, its height --mark-scale times the cap height (default 2.5); the gap is --gap times
            the mark's height (default 0.35).

The wordmark should come from wordmark.py, which records its cap height and baseline; without them the wordmark's
ink box stands in. Paths only, no nested <svg>, so sign, embroidery and vinyl software read it. Standard library only."""
import argparse, re, sys


def load(path):
    t = open(path, encoding='utf-8').read()
    m = re.search(r'<svg\b([^>]*)>(.*)</svg>', t, re.S)
    if not m:
        sys.exit(f'{path} is not an SVG')
    attrs, body = m.groups()
    vb = re.search(r'viewBox\s*=\s*["\']([^"\']+)', attrs)
    if not vb:
        sys.exit(f'{path} needs a viewBox')
    x, y, w, h = (float(v) for v in re.split(r'[\s,]+', vb.group(1).strip()))
    get = lambda k: float(re.search(k + r'\s*=\s*["\']([-\d.]+)', attrs).group(1)) if re.search(k + r'\s*=', attrs) else None
    body = re.sub(r'<\?xml[^>]*>|<!DOCTYPE[^>]*>', '', body)
    return {'x': x, 'y': y, 'w': w, 'h': h, 'body': body.strip(), 'base': get('data-baseline'), 'cap': get('data-cap-height')}


def place(d, sx, tx, ty):
    """The drawing's contents scaled by sx and moved so its viewBox corner lands at (tx, ty)."""
    return (f'<g transform="translate({tx:.2f} {ty:.2f}) scale({sx:.5f}) translate({-d["x"]:.2f} {-d["y"]:.2f})">'
            f'{d["body"]}</g>')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('mark')
    ap.add_argument('wordmark')
    ap.add_argument('--layout', choices=['horizontal', 'stacked'], required=True)
    ap.add_argument('--mark-scale', type=float)
    ap.add_argument('--gap', type=float)
    ap.add_argument('--out')
    a = ap.parse_args()
    m, w = load(a.mark), load(a.wordmark)
    cap = w['cap'] or w['h']
    top_of_caps = (w['base'] - cap) if w['base'] is not None else w['y']  # in the wordmark's units
    if a.layout == 'horizontal':
        k = a.mark_scale or 1.5
        gap = a.gap if a.gap is not None else 0.4
        mh = k * cap                       # the mark's height, in wordmark units
        ms = mh / m['h']
        mw = m['w'] * ms
        cap_mid = top_of_caps + cap / 2    # wordmark units, from its own origin
        my = cap_mid - mh / 2              # mark top, in wordmark units
        gx = gap * mh
        top = min(my, w['y'])
        bottom = max(my + mh, w['y'] + w['h'])
        parts = [place(m, ms, 0, my - top), place(w, 1, mw + gx, w['y'] - top)]
        W, H = mw + gx + w['w'], bottom - top
    else:
        k = a.mark_scale or 2.5
        gap = a.gap if a.gap is not None else 0.35
        mh = k * cap
        ms = mh / m['h']
        mw = m['w'] * ms
        W = max(mw, w['w'])
        gy = gap * mh
        parts = [place(m, ms, (W - mw) / 2, 0), place(w, 1, (W - w['w']) / 2, mh + gy)]
        H = mh + gy + w['h']
    out = a.out or f'logo-{a.layout}.svg'
    open(out, 'w', encoding='utf-8').write(
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.2f} {H:.2f}">\n' + '\n'.join(parts) + '\n</svg>\n')
    print(f'{out}: {a.layout}, mark {k:g} x cap height, gap {gap:g} x mark height, {W:.0f} x {H:.0f} units')


if __name__ == '__main__':
    main()
