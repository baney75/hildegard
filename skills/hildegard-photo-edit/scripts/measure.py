# SPDX-License-Identifier: AGPL-3.0-only
"""Measure a photo: tilt, colour cast, brightness, clipping, noise, size and aspect, and similarity to a reference when you have one.

  python3 measure.py IN [REF] [--family auto|h|v] [--json]

  IN      the photo to measure (before or after an edit)
  REF     a second picture to compare against (SSIM on luma at 384 px wide); it must have the same aspect ratio as IN, and is
          resized to IN's size. Leave it out when there is no reference
  --family  which lines the tilt reads: h = horizon, roof line; v = door frame, building corner; auto = the clearer

Every number has a plain reading beside it: ok, or what to look at. A reading is a hint, not a verdict: a sunset is meant to be warm,
a night scene dark. Judge with your eyes as well, and change one thing at a time.

Needs Pillow and numpy:  python3 -m pip install pillow numpy   (OpenCV is not used)"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import photolib as L  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

NAMED = {'1:1': 1.0, '4:5': 0.8, '5:4': 1.25, '4:3': 4 / 3, '3:4': 0.75, '3:2': 1.5, '2:3': 2 / 3, '16:9': 16 / 9, '9:16': 9 / 16, '7:5': 1.4, '5:7': 5 / 7, '2.39:1': 2.39}


def aspect_name(w, h):
    r = w / h
    for k, v in NAMED.items():
        if abs(r - v) / v < 0.01:
            return k
    return f'{r:.3f}:1'


def measure(im, family='auto', ref=None):
    """All the measurements of a PIL image as a dict of numbers plus a `reading` for each."""
    a = L.to_f(im)
    y = L.luma(a)
    hi, lo = L.clip_fractions(a)
    ra, ba = L.log_chroma(a)
    n = L.noise_of(im)
    t = L.estimate_tilt(im, family)
    out = {'width': im.width, 'height': im.height, 'aspect': aspect_name(im.width, im.height), 'megapixels': round(im.width * im.height / 1e6, 2),
           'mean_luma': round(float(y.mean()), 3), 'p1': round(float(np.percentile(y, 1)), 3), 'p99': round(float(np.percentile(y, 99)), 3),
           'clipped_highlights': round(hi, 4), 'clipped_shadows': round(lo, 4), 'gray_world_error': round(L.gray_world_error(a), 3),
           'log_r_g': round(ra, 3), 'log_b_g': round(ba, 3), 'noise': round(n, 2), 'detail': round(L.gradient_energy(y), 2)}
    out['tilt'] = None if not t['ok'] else round(t['angle'], 2)
    out['tilt_family'] = t.get('family')
    out['tilt_confidence'] = round(t['conf'], 2)
    out['tilt_why'] = t.get('why')
    read = {}
    read['tilt'] = ('unclear: ' + t['why']) if not t['ok'] else ('level' if abs(t['angle']) < 0.3 else f'tilted {t["angle"]:+.2f} degrees ({"counter-clockwise" if t["angle"] > 0 else "clockwise"}); straighten.py fixes it')
    read['gray_world_error'] = 'near neutral' if out['gray_world_error'] < 0.08 else ('some cast' if out['gray_world_error'] < 0.2 else 'strong cast, or a scene that is one colour (a sunset, a forest)')
    read['mean_luma'] = 'dark' if out['mean_luma'] < 0.28 else ('bright' if out['mean_luma'] > 0.65 else 'ok')
    read['clipped_highlights'] = 'blown highlights' if hi > 0.05 else 'ok'
    read['clipped_shadows'] = 'crushed shadows' if lo > 0.08 else 'ok'
    read['noise'] = 'grainy' if n > 4.0 else ('slightly noisy' if n > 2.5 else 'clean')
    out['reading'] = read
    if ref is not None:
        ra_ = ref.width / ref.height
        if abs(ra_ - im.width / im.height) / ra_ > 0.03:
            out['ssim'] = None
            read['ssim'] = f'not compared: aspect {aspect_name(im.width, im.height)} against {aspect_name(ref.width, ref.height)}; crop one to match first'
        else:
            def look(i):  # luma at 384 px wide, lightly blurred so grain does not decide it
                return L.gblur(L.luma(L.to_f(L.resize_w(i, 384))), 0.8)
            out['ssim'] = round(L.ssim(look(im), look(ref.resize(im.size, Image.LANCZOS))), 3)
            read['ssim'] = 'close to the reference' if out['ssim'] >= 0.75 else 'differs from the reference'
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description='Measure tilt, cast, brightness, clipping, noise and size of a photo.')
    ap.add_argument('src')
    ap.add_argument('ref', nargs='?')
    ap.add_argument('--family', choices=['auto', 'h', 'v'], default='auto')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    m = measure(L.load(a.src), a.family, L.load(a.ref) if a.ref else None)
    if a.json:
        print(json.dumps(m))
        return 0
    r = m['reading']
    print(f'size            {m["width"]}x{m["height"]} ({m["aspect"]}, {m["megapixels"]} MP)')
    print(f'tilt            {"%+.2f degrees" % m["tilt"] if m["tilt"] is not None else "not measured"}  {r["tilt"]}')
    print(f'gray-world err  {m["gray_world_error"]}  {r["gray_world_error"]}  (log R/G {m["log_r_g"]:+}, log B/G {m["log_b_g"]:+}; warm is R/G up, B/G down)')
    print(f'mean luminance  {m["mean_luma"]}  {r["mean_luma"]}  (1st percentile {m["p1"]}, 99th {m["p99"]})')
    print(f'clipped         highlights {m["clipped_highlights"]}  {r["clipped_highlights"]}; shadows {m["clipped_shadows"]}  {r["clipped_shadows"]}')
    print(f'noise           {m["noise"]}  {r["noise"]}  (8-bit levels at 1000 px wide)')
    if 'ssim' in m:
        print(f'SSIM to REF     {m["ssim"]}  {r["ssim"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
