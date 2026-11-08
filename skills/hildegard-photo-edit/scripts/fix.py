# SPDX-License-Identifier: AGPL-3.0-only
"""Fix a photo in one go: straighten, crop, correct the colour, denoise and sharpen, in that order, and print a short report.

  python3 fix.py IN OUT [--aspect 4:5|1:1|16:9|9:16 | --size WxH] [--subject X,Y | X0,Y0,X1,Y1] [--family auto|h|v] [--angle DEG]
                        [--max-bytes N] [--wb auto|gray|white|none] [--exposure auto|none|+n] [--warmth +n] [--json]

Then run measure.py on OUT, and look at a before and after sheet (contact_sheet.py). Change one thing at a time if something is off.

  --aspect / --size   the shape of the result; --size also resizes to exactly that, and --max-bytes lowers the JPEG quality until it fits.
                      Leave both out to keep the picture's own shape
  --subject           what the crop must keep, from the brief: the centre (X,Y) or a box (LEFT,TOP,RIGHT,BOTTOM), as fractions of the
                      picture or pixels. Without it the crop guesses from a saliency map and says so
  --family, --angle   as in straighten.py; --angle 0 keeps the picture as shot
  --no-straighten --no-crop --no-color --no-denoise   skip a step (--no-denoise skips sharpening too)
  --wb, --exposure, --warmth, --black   as in color.py

The order: straighten (cut to no empty corners), crop to the shape, colour (measured on the picture as it will be seen), denoise, sharpen
last. A step that cannot be trusted (tilt not clear, nothing to correct) is skipped and the report says so. Exit codes: 0 written,
2 refused (the subject cannot fit the shape), 1 error.

Needs Pillow and numpy:  python3 -m pip install pillow numpy   (OpenCV is not used)"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import photolib as L  # noqa: E402
import straighten, crop, color, denoise_sharpen, measure  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402


def fix(im, aspect=None, size=None, subject=None, family='auto', angle=None, wb='auto', exposure='auto', warmth=0.0, black='auto',
        do_straighten=True, do_crop=True, do_color=True, do_denoise=True):
    """Run the pipeline on a PIL image. Returns (picture, report) or (None, report with `refused`)."""
    rep = {'steps': [], 'warnings': []}
    step = rep['steps'].append
    before = measure.measure(im, family)
    rep['before'] = before
    orig = im.size
    box = crop.parse_subject(subject, *orig) if subject else None
    tilt = 0.0
    if do_straighten:
        tilt, trep = straighten.find_tilt(im, family, angle)
        if tilt is None:
            tilt = 0.0
            rep['warnings'].append('NOT STRAIGHTENED: ' + trep['why'] + '. If you can see the tilt, rerun with --angle DEG')
            step('straighten: skipped, the lines are not clear enough to trust')
        elif abs(tilt) < L.LEVEL:
            step(f'straighten: already level ({tilt:+.2f} degrees)')
            tilt = 0.0
        else:
            im, rbox = L.rotate_level(im, tilt)
            if box:
                box = L.map_box(box, orig, tilt, (rbox[0], rbox[1]))
            step(f'straighten: tilt {tilt:+.2f} degrees ({trep.get("family") or "given"} lines), turned back, cut to {im.width}x{im.height} with no empty corners')
    rep['tilt_removed'] = round(tilt, 2)
    if do_crop and (aspect or size):
        asp = aspect if aspect else size[0] / size[1]
        guessed = box is None
        if guessed:
            box, _ = crop.saliency_box(im)
            box = crop.shrink_to_fit(box, im.width, im.height, asp)
            rep['warnings'].append('subject GUESSED from a saliency map; give --subject if the brief names one')
        box = (max(0, box[0]), max(0, box[1]), min(im.width, box[2]), min(im.height, box[3]))
        out, info = crop.crop_to(im, asp, box)
        if out is None:
            rep['refused'] = info
            return None, rep
        im = out
        step(f'crop: box {info[0]},{info[1]},{info[2]},{info[3]} -> {im.width}x{im.height}, subject {"guessed" if guessed else "given"} and kept')
    if size and im.size != tuple(size):
        if size[0] > im.width * 1.5:
            rep['warnings'].append(f'upscaled from {im.width}px to {size[0]}px wide: it will look soft')
        im = im.resize(tuple(size), Image.LANCZOS)
        step(f'resize: {im.width}x{im.height}')
    if do_color:
        a, done = color.correct(L.to_f(im), wb, exposure, warmth, black)
        im = L.from_f(a)
        step('color: ' + (', '.join(f'{k} {v}' for k, v in done.items()) or 'nothing needed'))
    if do_denoise:
        im, d = denoise_sharpen.run(im)
        step(f'denoise_sharpen: noise {d["noise_in"]} -> {d["noise_denoised"]} -> {d["noise_out"]} (ceiling {d["ceiling"]}); denoise {d["denoise"]}; sharpen {d["sharpen"]}')
    rep['after'] = measure.measure(im, 'auto')
    return im, rep


def main(argv=None):
    ap = argparse.ArgumentParser(description='Straighten, crop, colour, denoise and sharpen a photo in one go.')
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--aspect')
    ap.add_argument('--size')
    ap.add_argument('--subject')
    ap.add_argument('--family', choices=['auto', 'h', 'v'], default='auto')
    ap.add_argument('--angle', type=float)
    ap.add_argument('--max-bytes', type=int)
    ap.add_argument('--quality', type=int, default=92)
    ap.add_argument('--wb', choices=['auto', 'gray', 'white', 'none'], default='auto')
    ap.add_argument('--exposure', default='auto')
    ap.add_argument('--warmth', type=float, default=0.0)
    ap.add_argument('--black', choices=['auto', 'none'], default='auto')
    ap.add_argument('--no-straighten', action='store_true')
    ap.add_argument('--no-crop', action='store_true')
    ap.add_argument('--no-color', action='store_true')
    ap.add_argument('--no-denoise', action='store_true')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    size = L.parse_size(a.size) if a.size else None
    aspect = L.parse_aspect(a.aspect) if a.aspect else None
    im = L.load(a.src)
    out, rep = fix(im, aspect, size, a.subject, a.family, a.angle, a.wb, a.exposure, a.warmth, a.black,
                   not a.no_straighten, not a.no_crop, not a.no_color, not a.no_denoise)
    if out is None:
        print(f'not written: a crop of that shape cannot keep the subject ({rep["refused"]}). Pick another aspect or give a smaller --subject box.', file=sys.stderr)
        if a.json:
            print(json.dumps({'ok': False, **rep}))
        return 2
    nbytes, q = L.save(a.dst, out, a.quality, a.max_bytes)
    rep.update(ok=True, bytes=nbytes, quality=q, size=list(out.size))
    if a.json:
        print(json.dumps(rep))
        return 0
    for s in rep['steps']:
        print(s)
    b, f = rep['before'], rep['after']
    print(f'before -> after: mean luminance {b["mean_luma"]} -> {f["mean_luma"]}, gray-world error {b["gray_world_error"]} -> {f["gray_world_error"]}, '
          f'clipped highlights {b["clipped_highlights"]} -> {f["clipped_highlights"]}, shadows {b["clipped_shadows"]} -> {f["clipped_shadows"]}, noise {b["noise"]} -> {f["noise"]}')
    for w in rep['warnings']:
        print('WARNING:', w)
    print(f'wrote {a.dst}: {out.width}x{out.height}, {nbytes} bytes' + (f', quality {q}' if q else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
