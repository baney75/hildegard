# SPDX-License-Identifier: AGPL-3.0-only
"""Level a crooked photo by measuring its straight lines, then cut away the corners the turn leaves empty.

  python3 straighten.py IN OUT [--family auto|h|v] [--angle DEG] [--max-angle 6] [--json]

  IN, OUT   a JPEG or PNG; OUT is a new file (a JPEG is written at quality 92)
  --family  which lines to trust: h = a horizon, a roof line, a table edge; v = a door frame, a pole, a building corner. auto takes
            whichever is clearer and refuses when the two disagree (perspective, a slanted subject)
  --angle   the tilt to remove, in degrees, when you know it or the measurement refused. Positive = the picture is turned
            counter-clockwise (the horizon rises toward the right); it is turned back clockwise by that much
  --max-angle  the biggest tilt to look for (default 6)

It prints the tilt it found. It refuses (exit 2, nothing written) when the lines are not clear enough to trust, unless --angle is given,
because turning a photo by a wrong guess makes it worse. The result is the largest rectangle with no empty corners: no black wedges.

Needs Pillow and numpy:  python3 -m pip install pillow numpy   (OpenCV is not used)"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import photolib as L  # noqa: E402


def find_tilt(im, family='auto', angle=None, max_angle=6.0):
    """(tilt, report dict). The tilt is None when the measurement is not clear enough. `angle` overrides the measurement."""
    if angle is not None:
        return float(angle), {'angle': float(angle), 'source': 'given', 'ok': True}
    est = L.estimate_tilt(im, family, span=max_angle)
    rep = {'angle': est['angle'], 'family': est['family'], 'conf': round(est['conf'], 2), 'source': 'measured', 'ok': est['ok'],
           'h': {k: round(v, 2) for k, v in est['h'].items()}, 'v': {k: round(v, 2) for k, v in est['v'].items()}}
    if not est['ok']:
        rep['why'] = est.get('why', 'not clear enough')
        return None, rep
    return est['angle'], rep


def describe(tilt):
    if abs(tilt) < 0.05:
        return 'level'
    return f'turned {"counter-clockwise" if tilt > 0 else "clockwise"} by {abs(tilt):.2f} degrees (a horizon would {"rise" if tilt > 0 else "fall"} toward the right)'


def main(argv=None):
    ap = argparse.ArgumentParser(description='Level a photo by measuring its straight lines; no black corners.')
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--family', choices=['auto', 'h', 'v'], default='auto')
    ap.add_argument('--angle', type=float, help='tilt to remove in degrees; positive = turned counter-clockwise')
    ap.add_argument('--max-angle', type=float, default=6.0)
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    im = L.load(a.src)
    tilt, rep = find_tilt(im, a.family, a.angle, a.max_angle)
    if tilt is None:
        if a.json:
            print(json.dumps({'ok': False, **rep}))
        print(f'not straightened: {rep["why"]}. Nothing was written. If you can see the tilt, give it with --angle DEG '
              f'(positive when the horizon rises toward the right), or leave the picture as it is.', file=sys.stderr)
        return 2
    if abs(tilt) < L.LEVEL and a.angle is None:
        tilt = 0.0  # under 0.6 degrees nobody can see it: written unchanged
    out, box = L.rotate_level(im, tilt)
    size, _ = L.save(a.dst, out)
    rep.update(ok=True, tilt=round(tilt, 2), size=list(out.size), box=list(box), wedges=L.corner_fill(out))
    if a.json:
        print(json.dumps(rep))
    else:
        print(f'tilt found: {tilt:+.2f} degrees, picture {describe(tilt)}' + (f' ({rep["family"]} lines, confidence {rep["conf"]})' if rep['source'] == 'measured' else ' (given)'))
        if abs(tilt) < 0.05:
            print(f'already level: written unchanged, {out.size[0]}x{out.size[1]}')
        else:
            print(f'turned back by {abs(tilt):.2f} degrees and cut to {out.size[0]}x{out.size[1]} (largest rectangle with no empty corners; {im.size[0]}x{im.size[1]} before)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
