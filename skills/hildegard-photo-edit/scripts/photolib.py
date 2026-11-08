# SPDX-License-Identifier: AGPL-3.0-only
"""Shared by straighten.py, color.py, denoise_sharpen.py, crop.py, measure.py and fix.py in this folder. Not run on its own.

Needs Pillow and numpy:  python3 -m pip install pillow numpy
OpenCV is never needed or used. Everything here is plain numpy on float32 arrays, so a result is the same on every machine.

Conventions: pixel arrays are float32 RGB in [0, 1], gamma-encoded as stored (sRGB). A tilt is in degrees and is positive when the
picture is turned counter-clockwise (a horizon that rises toward the right), which is what Pillow's rotate(+a) does to a level one;
the fix is rotate(-tilt)."""
import io
import math
import os
import sys

try:
    import numpy as np
    from PIL import Image, ImageOps
except ImportError as e:  # one plain line, not a traceback
    sys.exit(f'{e.name or "Pillow or numpy"} is not installed. Run: python3 -m pip install pillow numpy')

INSTALL = 'python3 -m pip install pillow numpy'


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


# ---- files ----

def load(path):
    """Open a photo as RGB with the camera's rotation flag applied and a non-sRGB colour profile converted to sRGB."""
    try:
        im = Image.open(path)
        im.load()
    except Exception as e:
        die(f'cannot open {path}: {e}')
    icc = im.info.get('icc_profile')
    im = ImageOps.exif_transpose(im)
    im = im.convert('RGB')
    if icc and b'sRGB' not in icc[:400]:
        try:
            from PIL import ImageCms
            im = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(icc)), ImageCms.createProfile('sRGB'), outputMode='RGB')
        except Exception:
            pass
    return im


def save(path, im, quality=92, max_bytes=None):
    """Write a JPEG or PNG. With max_bytes a JPEG's quality steps down until it fits; returns (bytes, quality). Metadata, GPS included, is not copied."""
    ext = os.path.splitext(path)[1].lower()
    if ext == '.png':
        im.save(path, optimize=True)
        return os.path.getsize(path), None
    if ext not in ('.jpg', '.jpeg'):
        die(f'{path}: write a .jpg or .png')
    q = int(quality)
    while True:
        buf = io.BytesIO()
        im.save(buf, 'JPEG', quality=q, subsampling=0 if q >= 90 else 2, optimize=True)
        if max_bytes is None or buf.tell() <= max_bytes or q <= 45:
            break
        q -= 3
    if max_bytes is not None and buf.tell() > max_bytes:
        die(f'{path}: {buf.tell()} bytes at quality {q} is over the {max_bytes} byte cap; make the picture smaller')
    with open(path, 'wb') as f:
        f.write(buf.getvalue())
    return buf.tell(), q


def to_f(im):
    return np.asarray(im, dtype=np.float32) / 255.0


def from_f(a):
    return Image.fromarray(np.clip(np.rint(a * 255.0), 0, 255).astype(np.uint8))


def luma(a):
    """Rec. 709 luma of a float RGB array (gamma-encoded, as stored)."""
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def resize_w(im, w):
    return im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)


def srgb_to_lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055).astype(np.float32)


# ---- filters ----

def gblur(x, sigma):
    """Gaussian blur of a 2-D or 3-D float array over its first two axes, reflected at the edges."""
    r = max(1, int(3 * sigma + 0.5))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2).astype(np.float32)
    k /= k.sum()
    for axis in (0, 1):
        pad = [(0, 0)] * x.ndim
        pad[axis] = (r, r)
        p = np.pad(x, pad, mode='reflect')
        n = x.shape[axis]
        out = np.zeros(x.shape, dtype=np.float32)
        for i, w in enumerate(k):
            sl = [slice(None)] * x.ndim
            sl[axis] = slice(i, i + n)
            out += w * p[tuple(sl)]
        x = out
    return x


def box(x, k):
    """Mean over a k x k window, valid positions only, by cumulative sums."""
    c = np.cumsum(np.cumsum(np.pad(x.astype(np.float64), ((1, 0), (1, 0))), axis=0), axis=1)
    return ((c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)).astype(np.float32)


# ---- measurements ----

def noise_sigma(y):
    """Immerkaer's noise estimate on luma in [0, 1], as 8-bit levels. Texture inflates it a little. Compare like with like (same width)."""
    a = y * 255.0
    k = (a[:-2, :-2] - 2 * a[:-2, 1:-1] + a[:-2, 2:] - 2 * a[1:-1, :-2] + 4 * a[1:-1, 1:-1] - 2 * a[1:-1, 2:]
         + a[2:, :-2] - 2 * a[2:, 1:-1] + a[2:, 2:])
    return float(math.sqrt(math.pi / 2) / 6 * np.abs(k).mean())


def noise_of(im, width=1000):
    """The noise estimate of a PIL image taken at 1000 px wide (or its own width when smaller), so two photos compare."""
    if im.width > width:
        im = resize_w(im, width)
    return noise_sigma(luma(to_f(im)))


def gradient_energy(y):
    gy, gx = np.gradient(y)
    return float(np.hypot(gx, gy).mean() * 255)


def gray_world_error(a):
    """How far the mean colour is from grey: (max - min of the channel means) / their mean. 0 is neutral."""
    m = a.reshape(-1, 3).mean(0)
    return float((m.max() - m.min()) / (m.mean() + 1e-4))


def log_chroma(a):
    """(log R/G, log B/G) of the mean colour. A warm cast is R/G above 0 and B/G below 0."""
    m = a.reshape(-1, 3).mean(0) + 1e-4
    return float(math.log(m[0] / m[1])), float(math.log(m[2] / m[1]))


def clip_fractions(a):
    """(share of pixels with a channel at the top, share of dark pixels), the two numbers a clipped edit moves."""
    return float((a.max(axis=2) >= 0.992).mean()), float((luma(a) <= 0.025).mean())


def ssim(a, b, k=7):
    """Mean structural similarity of two same-size luma arrays in [0, 1] (uniform 7 x 7 window, the usual constants)."""
    a, b = a.astype(np.float64) * 255, b.astype(np.float64) * 255
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ma, mb = box(a, k).astype(np.float64), box(b, k).astype(np.float64)
    va, vb, cov = box(a * a, k) - ma * ma, box(b * b, k) - mb * mb, box(a * b, k) - ma * mb
    s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    return float(s.mean())


# ---- tilt ----

LEVEL = 0.6  # a tilt under this many degrees is left alone: it cannot be seen, and a turn costs a resample
AUTO_STRENGTH = 1.0  # when no family is named, the lines must be this clear: a table edge or a book is straight too, but is not a horizon
MIN_STRENGTH = 0.5  # below this the line evidence is no better than texture: on test photos every wrong estimate was under 0.45 and every right one over 0.5

def _edge_points(y, family, span):
    """Strong edge pixels whose edge direction is within span + 3 degrees of horizontal ('h') or vertical ('v'): (x, y, weight)."""
    gy, gx = np.gradient(y)
    m = np.hypot(gx, gy)
    thr = max(float(np.percentile(m, 96)), 0.01)
    ang = np.degrees(np.arctan2(gy, gx))
    dev = np.abs(np.abs(ang) - 90.0) if family == 'h' else np.minimum(np.abs(ang), 180.0 - np.abs(ang))
    sel = (m >= thr) & (dev <= span + 3.0)
    ys, xs = np.nonzero(sel)
    H, W = y.shape
    return xs.astype(np.float32) - W / 2, ys.astype(np.float32) - H / 2, m[sel].astype(np.float64), (W, H)


def _line_sharpness(xs, ys, w, size, family, angles):
    """For each candidate tilt, how much of the edge weight falls on a few lines (sum of squared bin masses over total squared): a Hough
    transform restricted to near-axis lines. Bins are 1 px wide at the analysis size."""
    W, H = size
    diag = int(math.hypot(W, H)) + 4
    out = np.empty(len(angles))
    tot = w.sum() ** 2 + 1e-12
    for i, a in enumerate(angles):
        t = math.radians(a)
        rho = ys * math.cos(t) + xs * math.sin(t) if family == 'h' else xs * math.cos(t) - ys * math.sin(t)
        h = np.bincount(np.floor(rho + diag / 2).astype(np.int64), weights=w, minlength=diag + 1)
        out[i] = float((h * h).sum() / tot)
    return out


def estimate_tilt(im, family='auto', span=6.0, width=800):
    """Tilt of the strongest straight lines near horizontal ('h': a horizon, a roof line, a table edge) or near vertical ('v': a door
    frame, a pole, a building corner), by an orientation-restricted Hough transform on the edge map, searched over +-span degrees at 0.1
    steps and refined to 0.02. Returns a dict: angle (degrees, positive = turned counter-clockwise), family used, conf (0 to 1), and each
    family's own angle and strength. `family='auto'` takes the family with the clearer lines; when both are clear and disagree by more
    than 1 degree it takes neither (angle None, why 'families disagree'): that is perspective or a slanted subject, and a person must name the family."""
    sm = resize_w(im, width) if im.width > width else im
    y = gblur(luma(to_f(sm)), 1.0)
    angles = np.round(np.arange(-span, span + 1e-9, 0.1), 3)
    fam = {}
    for f in ('h', 'v'):
        xs, ys, w, size = _edge_points(y, f, span)
        if len(w) < 200:
            fam[f] = {'angle': 0.0, 'strength': 0.0, 'n': int(len(w))}
            continue
        s = _line_sharpness(xs, ys, w, size, f, angles)
        k = int(np.argmax(s))
        fine = np.round(np.arange(angles[k] - 0.1, angles[k] + 0.1001, 0.02), 3)
        sf = _line_sharpness(xs, ys, w, size, f, fine)
        top = fine[sf >= sf.max() - 0.15 * (sf.max() - np.median(s))]
        ang = float(np.mean(top))
        # Strength: how far the peak stands above the typical angle. A flat curve (foliage, water, texture) has none; a horizon or a wall edge does.
        prom = float((s.max() - np.median(s)) / (np.median(s) + 1e-12))
        fam[f] = {'angle': ang, 'strength': prom, 'n': int(len(w))}
    h, v = fam['h'], fam['v']
    res = {'h': h, 'v': v, 'span': span}
    if family in ('h', 'v'):
        pick = family
    else:
        hi, lo = (h, v) if h['strength'] >= v['strength'] else (v, h)
        pick = 'h' if hi is h else 'v'
        if lo['strength'] >= MIN_STRENGTH and abs(h['angle'] - v['angle']) > 1.0:
            res.update(angle=None, family=None, conf=0.0, ok=False, why='the horizontal and vertical lines disagree by %.1f degrees (perspective or a slanted subject); say which to trust with --family h or v, or give --angle' % abs(h['angle'] - v['angle']))
            return res
    g = fam[pick]
    need = MIN_STRENGTH if family in ('h', 'v') else AUTO_STRENGTH
    res.update(angle=g['angle'], family=pick, conf=float(min(1.0, g['strength'] / 1.5)))
    if g['strength'] < need:
        res.update(conf=res['conf'], why='no clear straight lines near horizontal or vertical (strength %.2f, needs %.1f%s)' % (g['strength'], need, '' if family in ('h', 'v') else '; name the lines with --family h for a horizon or v for upright lines to accept clearer-than-%.1f evidence' % MIN_STRENGTH))
    if abs(g['angle']) >= span - 0.15:
        res.update(conf=0.0, why='the best angle is at the edge of the +-%.0f degree search: the lines are not a small tilt' % span)
    res['ok'] = res['angle'] is not None and 'why' not in res
    return res


# ---- geometry ----

def inscribed_rect(w, h, deg):
    """Width and height of the largest axis-aligned rectangle (any aspect) inside a w x h picture turned by `deg` degrees, centred."""
    if abs(deg) < 1e-6:
        return float(w), float(h)
    t = math.radians(abs(deg))
    sin_a, cos_a = math.sin(t), math.cos(t)
    long_side, short_side = (w, h) if w >= h else (h, w)
    if short_side <= 2.0 * sin_a * cos_a * long_side or abs(sin_a - cos_a) < 1e-10:
        x = 0.5 * short_side
        wr, hr = (x / sin_a, x / cos_a) if w >= h else (x / cos_a, x / sin_a)
    else:
        c2 = cos_a * cos_a - sin_a * sin_a
        wr, hr = (w * cos_a - h * sin_a) / c2, (h * cos_a - w * sin_a) / c2
    return wr, hr


def rotate_level(im, tilt):
    """Turn a picture by -tilt degrees (undoing a counter-clockwise tilt) and cut it to the largest rectangle with no fill at all.
    Returns (picture, (left, top, right, bottom) of the kept rectangle in the rotated frame, which is the input's size)."""
    w, h = im.size
    if abs(tilt) < 0.05:
        return im.copy(), (0, 0, w, h)  # (rotate_level itself turns by any tilt it is given)
    rot = im.rotate(-tilt, resample=Image.BICUBIC, expand=False)
    wr, hr = inscribed_rect(w, h, tilt)
    cw, ch = max(2, int(wr) - 4), max(2, int(hr) - 4)  # a margin of 2 px a side: bicubic blends the fill into the edge
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    return rot.crop((x0, y0, x0 + cw, y0 + ch)), (x0, y0, x0 + cw, y0 + ch)


def map_box(box, size, tilt, offset):
    """Where a box (left, top, right, bottom in pixels of the original) lands after rotate_level(im, tilt) cut away `offset` = (x0, y0)."""
    w, h = size
    if abs(tilt) < 0.05:
        return (box[0] - offset[0], box[1] - offset[1], box[2] - offset[0], box[3] - offset[1])
    t = math.radians(-tilt)  # Pillow's rotate(angle) turns counter-clockwise on screen: x' = x cos + y sin, y' = -x sin + y cos
    c, s = math.cos(t), math.sin(t)
    pts = []
    for x, y in ((box[0], box[1]), (box[2], box[1]), (box[0], box[3]), (box[2], box[3])):
        dx, dy = x - w / 2, y - h / 2
        pts.append((w / 2 + dx * c + dy * s - offset[0], h / 2 - dx * s + dy * c - offset[1]))
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def corner_fill(im):
    """How many of the four corner patches are flat black or white: 0 means no wedge from a rotation."""
    a = np.asarray(im.convert('L'), dtype=np.float32)
    h, w = a.shape
    ph, pw = max(4, int(h * 0.04)), max(4, int(w * 0.04))
    n = 0
    for sl in (a[:ph, :pw], a[:ph, -pw:], a[-ph:, :pw], a[-ph:, -pw:]):
        if sl.std() < 2.0 and (sl.mean() < 12 or sl.mean() > 243):
            n += 1
    return n


def parse_aspect(text):
    """'4:5', '16:9', '1.5' or '1080x1350' as a width / height ratio."""
    t = text.lower().replace('x', ':').replace('/', ':')
    try:
        if ':' in t:
            a, b = t.split(':')
            return float(a) / float(b)
        return float(t)
    except (ValueError, ZeroDivisionError):
        die(f'cannot read the aspect {text!r}: write it as 4:5, 1:1, 16:9 or 9:16')


def parse_size(text):
    try:
        w, h = text.lower().split('x')
        w, h = int(w), int(h)
        if w < 16 or h < 16:
            raise ValueError
        return w, h
    except ValueError:
        die(f'cannot read the size {text!r}: write it as WIDTHxHEIGHT, for example 1600x900')
