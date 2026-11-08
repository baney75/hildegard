# SPDX-License-Identifier: AGPL-3.0-only
"""Correct white balance and exposure of a photo from its own measurements, with limits so it cannot overdo it.

  python3 color.py IN OUT [--wb auto|gray|white|none] [--exposure auto|none|+n|-n] [--warmth +n|-n] [--black auto|none]
                          [--contrast auto|none] [--json]

  --wb        auto (default): the brightest unclipped pixels (a cloud, snow, a white wall, a specular glint) are taken as the light and made
              neutral, held back when those pixels are strongly coloured themselves (a red sign, a sunset sun)
              gray: gray-world, the average colour is grey, with highlights and shadows left out of the average; white: the same
              white-patch rule without the hold-back; none: leave the colour alone
  --exposure  auto (default): place the highlights just under white and keep the mean brightness in a sane band, never by more than
              1.5 stops and never blowing more highlights than the photo had; none; or a number of stops (+0.5 brightens)
  --warmth    a manual nudge after the correction, in steps of about 2 percent (+3 warmer, -3 cooler); for light that should stay warm
  --black     auto (default): when more than 3 percent of the picture is crushed to pure black, lift the floor to a dark grey so shadows stay
              open; none for a silhouette or a night scene that should stay black
  --contrast  auto (default): a gentle S-curve only when the picture is flat; none

It never paints a gradient, a sky or any new pixels: it only multiplies and curves the colours that are there. It prints the
measurements before and after (mean colour, mean brightness, clipped highlights and shadows).

Needs Pillow and numpy:  python3 -m pip install pillow numpy   (OpenCV is not used)"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import photolib as L  # noqa: E402
import numpy as np  # noqa: E402  (photolib has already exited with the install line when numpy is missing)

MAX_STOPS = 1.5
TARGET_TOP = 0.96  # where the brightest 0.5 percent should sit after an exposure lift
LIFT_BELOW = 0.93  # a picture whose brightest 0.5 percent is under this is lifted
CLIP_SHARE = 0.03  # more than this share of pixels at the top, in a picture that is bright overall, is blown, and the exposure comes down
BRIGHT_MEAN = 0.40
AXIS_BOOST = 1.3
ORTH_KEEP = 0.8
HOLD_SAT = 0.20  # highlights more coloured than this are partly left alone by the white balance
SHADOW_SHARE = 0.03
SHADOW_FLOOR = 0.04


def measure(a):
    """The numbers the report shows for a float RGB array."""
    y = L.luma(a)
    hi, lo = L.clip_fractions(a)
    ra, ba = L.log_chroma(a)
    return {'mean_luma': round(float(y.mean()), 3), 'p1': round(float(np.percentile(y, 1)), 3), 'p99': round(float(np.percentile(y, 99)), 3),
            'gray_world_error': round(L.gray_world_error(a), 3), 'log_r_g': round(ra, 3), 'log_b_g': round(ba, 3),
            'clipped_highlights': round(hi, 4), 'clipped_shadows': round(lo, 4)}


def _valid(a):
    y = L.luma(a)
    return (a.max(axis=2) < 0.97) & (y > 0.04) & (y < 0.96)


def _norm(g):
    return g / math.exp(float(np.mean(np.log(g))))  # geometric mean 1: a colour change, not a brightness change


def gains_gray(a):
    m = a[_valid(a)].mean(axis=0) if _valid(a).sum() > 100 else a.reshape(-1, 3).mean(axis=0)
    return _norm(m.mean() / m)


def _bright_pixels(a):
    """Colours of the brightest 1.5 percent of the unclipped pixels. They are picked on a lightly blurred luma, so noise does not choose them
    (picking on raw luma favours pixels whose green happens to be high and turns a grey picture magenta)."""
    y = L.gblur(L.luma(a), float(max(1.5, 0.002 * max(a.shape[:2]))))
    ok = a.max(axis=2) < 0.98
    if ok.sum() < 100:
        return None
    sel = ok & (y >= np.percentile(y[ok], 98.5))
    return a[sel].mean(axis=0) if sel.sum() >= 30 else None


def gains_white(a):
    m = _bright_pixels(a)
    if m is None:
        return gains_gray(a)
    return _norm(m.max() / m)


def _shape(g):
    """Real light sits near the blue to orange axis, so the green to magenta part of a correction is trusted less, and a white-patch estimate
    reads a little under the true cast (highlights hold some of the light they are lit by), so the correction along the axis is taken a little further."""
    v = np.array([math.log(g[0] / g[1]), math.log(g[2] / g[1])])
    along, across = np.array([1.0, -1.0]) / math.sqrt(2), np.array([1.0, 1.0]) / math.sqrt(2)
    v = AXIS_BOOST * (float(v @ along) * along + ORTH_KEEP * float(v @ across) * across)
    return _norm(np.array([math.exp(v[0]), 1.0, math.exp(v[1])], np.float32))


def gains_auto(a):
    """White-patch with a hold-back. Returns (gains, evidence 0..1): evidence is how neutral the bright pixels are once corrected."""
    g = gains_white(a)
    m = _bright_pixels(a)
    if m is None:
        return g, 0.0
    sat = float((m.max() - m.min()) / (m.max() + 1e-4))  # how coloured the bright pixels are before correction
    hold = float(np.clip((sat - HOLD_SAT) / 0.4, 0.0, 0.8))  # a strongly coloured highlight is more likely the subject than the light
    g = _norm(g ** (1.0 - hold))
    return _shape(g), 1.0 - hold


def open_shadows(a):
    """When more than 3 percent of the picture is pure black, lift the floor to a dark grey so the shadows are open. Returns (picture, floor)."""
    if float((a.max(axis=2) <= 0.02).mean()) <= SHADOW_SHARE:
        return a, 0.0
    return SHADOW_FLOOR + (1.0 - SHADOW_FLOOR) * a, SHADOW_FLOOR


def exposure_stops(a, mode, clipped=None):
    """Stops to apply in linear light: a number given, or from the picture. Blown highlights come down; a picture whose brightest
    pixels sit well under white goes up until they are just under it. Nothing else moves it, so a dark scene that is meant to be dark stays dark."""
    if mode != 'auto':
        return float(np.clip(float(mode), -MAX_STOPS, MAX_STOPS))
    mx = a.max(axis=2)
    clipped = float((mx >= 0.992).mean()) if clipped is None else clipped  # measured before the white balance: a gain under 1 un-clips nothing
    top = float(np.percentile(mx, 99.5))
    if clipped > CLIP_SHARE and float(L.luma(a).mean()) >= BRIGHT_MEAN:  # a dark picture with a bright window is not overexposed
        return -float(min(MAX_STOPS, 0.2 + 1.4 * clipped))
    if top < LIFT_BELOW:
        return float(min(MAX_STOPS, math.log2(float(L.srgb_to_lin(np.float32(TARGET_TOP))) / max(float(L.srgb_to_lin(np.float32(top))), 1e-3))))
    return 0.0


def apply_exposure(a, stops):
    if abs(stops) < 0.03:
        return a
    return L.lin_to_srgb(L.srgb_to_lin(a) * np.float32(2.0 ** stops))


def contrast_amount(a):
    y = L.luma(a)
    spread = float(np.percentile(y, 98) - np.percentile(y, 2))
    return float(np.clip((0.62 - spread) / 0.62, 0.0, 0.25)) if spread < 0.62 else 0.0


def apply_contrast(a, amount):
    """A gentle S-curve around mid grey, the same on every channel (no hue shift): a blend of the picture and a smoothstep of it."""
    if amount <= 0.01:
        return a
    s = a * a * (3 - 2 * a)
    return np.clip(a * (1 - amount) + s * amount, 0, 1)


def correct(a, wb='auto', exposure='auto', warmth=0.0, black='auto', contrast='auto'):
    """Run the whole correction on a float RGB array. Returns (picture, what was done)."""
    done = {}
    clipped_before = float((a.max(axis=2) >= 0.992).mean())
    if wb != 'none':
        if wb == 'gray':
            g = gains_gray(a)
        elif wb == 'white':
            g = gains_white(a)
        else:
            g, ev = gains_auto(a)
            done['wb_evidence'] = round(ev, 3)
        done['wb_gains_rgb'] = [round(float(x), 3) for x in g]
        a = np.clip(a * g, 0, 1)
    if warmth:
        k = 0.02 * float(warmth)
        a = np.clip(a * np.array([math.exp(k), 1.0, math.exp(-k)], np.float32), 0, 1)
        done['warmth_steps'] = warmth
    if exposure != 'none':
        s = exposure_stops(a, exposure, clipped_before)
        done['exposure_stops'] = round(s, 2)
        a = apply_exposure(a, s)
    if contrast == 'auto':
        c = contrast_amount(a)
        if c > 0.01:
            done['contrast'] = round(c, 2)
            a = apply_contrast(a, c)
    if black == 'auto':
        a, k = open_shadows(a)
        if k:
            done['shadow_floor'] = k
    return a, done


def main(argv=None):
    ap = argparse.ArgumentParser(description='White balance and exposure from measurements, with limits.')
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--wb', choices=['auto', 'gray', 'white', 'none'], default='auto')
    ap.add_argument('--exposure', default='auto', help='auto, none, or stops such as +0.5 or -0.7')
    ap.add_argument('--warmth', type=float, default=0.0)
    ap.add_argument('--black', choices=['auto', 'none'], default='auto')
    ap.add_argument('--contrast', choices=['auto', 'none'], default='auto')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    if a.exposure not in ('auto', 'none'):
        try:
            float(a.exposure)
        except ValueError:
            L.die(f'--exposure takes auto, none or a number of stops such as +0.5, not {a.exposure!r}')
    im = L.load(a.src)
    src = L.to_f(im)
    out, done = correct(src, a.wb, a.exposure, a.warmth, a.black, a.contrast)
    size, q = L.save(a.dst, L.from_f(out))
    before, after = measure(src), measure(out)
    if a.json:
        print(json.dumps({'ok': True, 'before': before, 'after': after, 'done': done}))
        return 0
    print('done:', ', '.join(f'{k} {v}' for k, v in done.items()) or 'nothing needed')
    for k in ('mean_luma', 'p1', 'p99', 'gray_world_error', 'log_r_g', 'log_b_g', 'clipped_highlights', 'clipped_shadows'):
        print(f'  {k:19} {before[k]:>8} -> {after[k]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
