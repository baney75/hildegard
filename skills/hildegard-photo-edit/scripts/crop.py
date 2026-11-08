# SPDX-License-Identifier: AGPL-3.0-only
"""Crop a photo to an aspect ratio (or an exact size) without cutting the subject.

  python3 crop.py IN OUT --aspect 4:5|1:1|16:9|9:16|W:H [--size WxH] [--subject X,Y | X0,Y0,X1,Y1] [--center] [--json]

  --aspect   the shape to cut: 4:5, 1:1, 16:9, 9:16, or any W:H
  --size     resize the cut to exactly this size afterwards (it also sets the aspect when --aspect is left out)
  --subject  where the subject is. Two numbers are its centre, four are its box (left, top, right, bottom). Fractions of the picture
             (0 to 1) or pixels. Name the subject from the brief ("the sun", "the price sign") by looking at the picture; leave it out
             and the crop guesses from a saliency map (centre-weighted contrast and edge density) and says so
  --center   centre the subject in the cut instead of placing it on a third

The window is the largest one of that aspect, so no pixels are thrown away that need not be. It always contains the whole subject box
with a small margin, and sits the subject on a third line (or the centre when it is large) the way the picture already leans.
It refuses (exit 2, nothing written) when no window of that shape can hold the subject: pick another aspect or a smaller box.
It prints the crop box in the input's pixels.

Needs Pillow and numpy:  python3 -m pip install pillow numpy   (OpenCV is not used)"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import photolib as L  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

MARGIN = 0.03  # of the window, kept between the subject box and the cut


def parse_subject(text, w, h):
    """'x,y' or 'x0,y0,x1,y1' as a box in pixels. Numbers up to 1.0 are fractions of the picture, larger ones are pixels."""
    try:
        v = [float(t) for t in text.replace(' ', '').split(',')]
    except ValueError:
        L.die(f'cannot read --subject {text!r}: write X,Y or LEFT,TOP,RIGHT,BOTTOM, as fractions (0.5,0.4) or pixels')
    if len(v) not in (2, 4):
        L.die(f'--subject takes 2 numbers (centre) or 4 (a box), not {len(v)}')
    frac = all(0 <= t <= 1.0 for t in v)
    sx, sy = (w, h) if frac else (1, 1)
    if len(v) == 2:
        cx, cy = v[0] * sx, v[1] * sy
        return (cx - 0.06 * w, cy - 0.06 * h, cx + 0.06 * w, cy + 0.06 * h)
    box = (v[0] * sx, v[1] * sy, v[2] * sx, v[3] * sy)
    if box[2] <= box[0] or box[3] <= box[1]:
        L.die('--subject box needs LEFT < RIGHT and TOP < BOTTOM')
    return box


def saliency_box(im):
    """A guess at the subject: where contrast, edges and colour that differs from the picture's own colour gather, weighted to the centre.
    Returns (box in pixels, how concentrated it is 0..1). It is a guess; name the subject when you can."""
    sm = L.resize_w(im, 256) if im.width > 256 else im
    a = L.to_f(sm)
    y = L.luma(a)
    h, w = y.shape
    local = np.abs(L.gblur(y, 1.5) - L.gblur(y, 12.0))
    gy, gx = np.gradient(L.gblur(y, 1.5))
    edges = L.gblur(np.hypot(gx, gy), 4.0)
    med = np.median(a.reshape(-1, 3), axis=0)
    color = L.gblur(np.linalg.norm(a - med, axis=2), 3.0)
    yy, xx = np.mgrid[0:h, 0:w]
    centre = np.exp(-(((xx - w / 2) / (0.4 * w)) ** 2 + ((yy - h / 2) / (0.4 * h)) ** 2) / 2)
    s = (local / (local.max() + 1e-6) + edges / (edges.max() + 1e-6) + color / (color.max() + 1e-6)) * (0.4 + 0.6 * centre)
    s = L.gblur(s, 3.0)
    thr = np.percentile(s, 88)
    ys, xs = np.nonzero(s >= thr)
    x0, x1 = np.percentile(xs, [4, 96])
    y0, y1 = np.percentile(ys, [4, 96])
    sc = im.width / w
    return (x0 * sc, y0 * sc, (x1 + 1) * sc, (y1 + 1) * sc), float(s[s >= thr].mean() / (s.mean() + 1e-9))


def window(iw, ih, aspect, box, center=False):
    """The crop window (x0, y0, x1, y1) of `aspect` in an iw x ih picture holding `box`, or None when none can."""
    ww, wh = (ih * aspect, ih) if iw / ih >= aspect else (iw, iw / aspect)
    bw, bh = box[2] - box[0], box[3] - box[1]
    if bw > ww + 1e-6 or bh > wh + 1e-6:
        return None, (ww, wh)
    out = []
    for lo_b, hi_b, size, full, centre_b, bsize in ((box[0], box[2], ww, iw, (box[0] + box[2]) / 2, bw), (box[1], box[3], wh, ih, (box[1] + box[3]) / 2, bh)):
        if size >= full - 1e-6:
            out.append(0.0)
            continue
        pad = MARGIN * size
        lo = max(0.0, hi_b + pad - size)  # the window must reach past the subject's far edge ...
        hi = min(full - size, lo_b - pad)  # ... and start before its near edge
        if lo > hi:  # no room for the margin: keep the box, drop the margin
            lo, hi = max(0.0, hi_b - size), min(full - size, lo_b)
        rel = centre_b / full  # which way the subject already leans in the picture
        t = 0.5 if center or bsize >= 0.45 * size else min((1 / 3, 1 / 2, 2 / 3), key=lambda k: abs(k - rel))
        out.append(float(min(max(centre_b - t * size, lo), hi)))
    return (out[0], out[1], out[0] + ww, out[1] + wh), (ww, wh)


def shrink_to_fit(box, iw, ih, aspect, share=0.9):
    """A guessed subject box wider or taller than the biggest window is pulled in around its centre; a box a person gave is never changed."""
    ww, wh = (ih * aspect, ih) if iw / ih >= aspect else (iw, iw / aspect)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    hw, hh = min((box[2] - box[0]) / 2, share * ww / 2), min((box[3] - box[1]) / 2, share * wh / 2)
    return (cx - hw, cy - hh, cx + hw, cy + hh)


def crop_to(im, aspect, box, center=False):
    """Cut the window out. Returns (picture, box in input pixels) or (None, message)."""
    win, (ww, wh) = window(im.width, im.height, aspect, box, center)
    if win is None:
        return None, f'the widest {aspect:.3g}:1 window in this picture is {ww:.0f}x{wh:.0f} px and the subject box is {box[2] - box[0]:.0f}x{box[3] - box[1]:.0f} px'
    x0, y0 = int(round(win[0])), int(round(win[1]))
    w, h = int(round(win[2] - win[0])), int(round(win[3] - win[1]))
    w, h = min(w, im.width - x0), min(h, im.height - y0)
    return im.crop((x0, y0, x0 + w, y0 + h)), (x0, y0, x0 + w, y0 + h)


def main(argv=None):
    ap = argparse.ArgumentParser(description='Crop to an aspect ratio without cutting the subject.')
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--aspect')
    ap.add_argument('--size')
    ap.add_argument('--subject')
    ap.add_argument('--center', action='store_true')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    if not a.aspect and not a.size:
        L.die('give --aspect (4:5, 1:1, 16:9, 9:16) or --size WIDTHxHEIGHT')
    size = L.parse_size(a.size) if a.size else None
    aspect = L.parse_aspect(a.aspect) if a.aspect else size[0] / size[1]
    im = L.load(a.src)
    guessed = a.subject is None
    if guessed:
        box, focus = saliency_box(im)
    else:
        box, focus = parse_subject(a.subject, im.width, im.height), None
    if guessed:
        box = shrink_to_fit(box, im.width, im.height, aspect)
    out, info = crop_to(im, aspect, box, a.center)
    if out is None:
        print(f'not cropped: {info}. Nothing was written. Pick another aspect, or give a smaller --subject box.', file=sys.stderr)
        return 2
    if size and out.size != size:
        if size[0] > out.width * 1.5:
            print(f'warning: {out.width}px wide stretched to {size[0]}px; it will look soft', file=sys.stderr)
        out = out.resize(size, Image.LANCZOS)
    L.save(a.dst, out)
    rep = {'ok': True, 'box': list(info), 'out_size': list(out.size), 'subject_box': [round(v) for v in box], 'subject_guessed': guessed}
    if a.json:
        print(json.dumps(rep))
    else:
        print(f'crop box (left, top, right, bottom): {info[0]}, {info[1]}, {info[2]}, {info[3]} of {im.width}x{im.height}; written {out.size[0]}x{out.size[1]}')
        print('subject:', 'GUESSED from a saliency map (name it with --subject if this is wrong)' if guessed else 'as given', 'box %d,%d,%d,%d' % tuple(round(v) for v in box), '- fully inside the crop')
    return 0


if __name__ == '__main__':
    sys.exit(main())
