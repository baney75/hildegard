# SPDX-License-Identifier: AGPL-3.0-only
"""Image helpers for the creative eval, numpy and Pillow only: load, resize, luminance, SSIM, tilt estimate, placement search,
noise estimate, white-balance and exposure statistics, and the degradations the photo-editing inputs are made with."""
import numpy as np
from PIL import Image


def load_rgb(path):
    im = Image.open(path)
    im.load()
    return im.convert('RGB')


def to_f(im):
    return np.asarray(im, dtype=np.float32) / 255.0


def luma(a):
    """Rec. 709 luma of a float RGB array in [0, 1] (gamma-encoded, as stored)."""
    return a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722


def resize_w(im, w):
    h = max(1, round(im.height * w / im.width))
    return im.resize((w, h), Image.LANCZOS)


def box(x, k):
    """Mean over a k x k window (valid positions only), by cumulative sums."""
    c = np.cumsum(np.cumsum(np.pad(x, ((1, 0), (1, 0))), axis=0), axis=1)
    return (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)


def ssim(a, b, k=7):
    """Mean structural similarity of two same-size luma arrays in [0, 1] (uniform 7 x 7 window, the usual constants)."""
    a, b = a.astype(np.float64) * 255, b.astype(np.float64) * 255
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ma, mb = box(a, k), box(b, k)
    va, vb, cov = box(a * a, k) - ma * ma, box(b * b, k) - mb * mb, box(a * b, k) - ma * mb
    s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))
    return float(s.mean())


def blur(x, sigma):
    r = max(1, int(3 * sigma))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    p = np.pad(x, r, mode='reflect')
    p = np.apply_along_axis(lambda v: np.convolve(v, k, mode='valid'), 0, p)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode='valid'), 1, p)


def grad(y):
    gx = (y[1:-1, 2:] - y[1:-1, :-2]) * 0.5
    gy = (y[2:, 1:-1] - y[:-2, 1:-1]) * 0.5
    return gx, gy


def tilt_estimate(im, family='auto', span=6.0):
    """Tilt of the image's dominant straight lines, in degrees (positive = the picture is turned counter-clockwise, which is what
    Pillow's rotate(+a) does). Projection profile, as in document deskew: the edge strength is turned through candidate angles and
    the angle at which the row sums (horizontal lines: a horizon, a roof line: family 'h') or the column sums (vertical lines: a
    door frame, a pole: family 'v') change most sharply is the tilt, searched over +-`span` degrees in 0.2 steps and refined to
    0.05. 'auto' takes the family with the clearer peak, or their mean when both are clear and agree. Returns (angle, prominence_h,
    prominence_v). It reads real structure, so it is a proxy: compare a result with the reference's own estimate, never with 0,
    and name the family a photo has (a task's `tilt_family`)."""
    y = blur(luma(to_f(resize_w(im, 700))), 1.0)
    gx, gy = grad(y)
    res = {}
    for k, g in (('h', np.abs(gy)), ('v', np.abs(gx))):
        e = Image.fromarray((g / (np.percentile(g, 99.5) + 1e-9)).astype(np.float32), 'F')
        w, h = e.size
        m = int(min(w, h) * 0.15)

        def score(a, e=e, k=k, m=m):
            r = np.asarray(e.rotate(-a, resample=Image.BILINEAR), dtype=np.float32)[m:-m, m:-m]
            p = r.sum(axis=1 if k == 'h' else 0)
            return float(np.sum(np.diff(p) ** 2))  # sharp rows or columns, not the overall spread of edge energy
        coarse = np.arange(-span, span + 1e-9, 0.2)
        sc = np.array([score(a) for a in coarse])
        a0 = coarse[int(np.argmax(sc))]
        fine = np.arange(a0 - 0.2, a0 + 0.2001, 0.05)
        sf = np.array([score(a) for a in fine])
        res[k] = (float(fine[int(np.argmax(sf))]), float((sc.max() - np.median(sc)) / (np.median(sc) + 1e-9)))
    (ah, ph), (av, pv) = res['h'], res['v']
    if family == 'h':
        ang = ah
    elif family == 'v':
        ang = av
    elif min(ph, pv) < 0.5 * max(ph, pv) or abs(ah - av) > 1.0:
        ang = ah if ph >= pv else av
    else:
        ang = (ah * ph + av * pv) / (ph + pv)
    return ang, ph, pv


def ncc_map(R, O):
    """Normalized cross-correlation of the template O at every position inside R (valid positions only), by FFT and box sums."""
    ch, cw = O.shape
    H, W = R.shape
    n = ch * cw
    Oc = (O - O.mean()) / (O.std() + 1e-6)
    sh = (H + ch, W + cw)
    F = np.fft.irfft2(np.fft.rfft2(R, sh) * np.conj(np.fft.rfft2(Oc, sh)), sh)[:H - ch + 1, :W - cw + 1]
    s1 = box_rect(R, ch, cw)
    s2 = box_rect(R * R, ch, cw)
    var = np.maximum(s2 - s1 * s1, 1e-8)
    return F / n / np.sqrt(var)


def box_rect(x, ch, cw):
    c = np.cumsum(np.cumsum(np.pad(x, ((1, 0), (1, 0))), axis=0), axis=1)
    return (c[ch:, cw:] - c[:-ch, cw:] - c[ch:, :-cw] + c[:-ch, :-cw]) / (ch * cw)


def place(out_im, ref_im):
    """Where does the output sit inside the reference? Searches crop width fraction and offset by normalized cross-correlation of
    luma on blurred copies (colour and exposure differences do not matter), coarse (192 px wide) then fine (480 px wide, around the
    coarse best, a few widths either side). Returns (box in reference pixels (x0, y0, x1, y1), ncc)."""
    def prep(im, w):
        return blur(luma(to_f(resize_w(im, w))), 1.0)
    ow, oh = out_im.size
    rw, rh = ref_im.size
    asp = ow / oh
    best = (-2.0, None)
    R0, s0 = prep(ref_im, 192), 192 / rw
    for f in np.arange(0.35, 1.0001, 0.025):
        cw = int(round(f * 192))
        ch = int(round(cw / asp))
        if cw < 24 or ch < 16 or ch > R0.shape[0] or cw > R0.shape[1]:
            continue
        O = prep(out_im.resize((cw, ch), Image.LANCZOS), cw)
        if O.shape != (ch, cw):
            O = np.asarray(Image.fromarray(O).resize((cw, ch)))
        m = ncc_map(R0, O)
        i, j = np.unravel_index(np.argmax(m), m.shape)
        if m[i, j] > best[0]:
            best = (float(m[i, j]), (j / s0, i / s0, (j + cw) / s0, (i + ch) / s0))
    W = 480
    R1, s1 = prep(ref_im, W), W / rw
    x0, y0, x1, y1 = best[1]
    cx, cy, cw0 = (x0 + x1) / 2 * s1, (y0 + y1) / 2 * s1, (x1 - x0) * s1
    best2 = (-2.0, None)
    for dw in np.arange(-0.05, 0.0501, 0.0125):
        cw = int(round(cw0 * (1 + dw)))
        ch = int(round(cw / asp))
        if ch > R1.shape[0] or cw > R1.shape[1] or cw < 24:
            continue
        O = prep(out_im.resize((cw, ch), Image.LANCZOS), cw)
        if O.shape != (ch, cw):
            O = np.asarray(Image.fromarray(O).resize((cw, ch)))
        m = ncc_map(R1, O)
        ci, cj = int(round(cy - ch / 2)), int(round(cx - cw / 2))
        i0, i1, j0, j1 = max(0, ci - 8), min(m.shape[0], ci + 9), max(0, cj - 8), min(m.shape[1], cj + 9)
        if i1 <= i0 or j1 <= j0:
            continue
        sub = m[i0:i1, j0:j1]
        i, j = np.unravel_index(np.argmax(sub), sub.shape)
        if sub[i, j] > best2[0]:
            best2 = (float(sub[i, j]), ((j0 + j) / s1, (i0 + i) / s1, (j0 + j + cw) / s1, (i0 + i + ch) / s1))
    return (best2[1] or best[1]), (best2[0] if best2[1] else best[0])


def noise_sigma(y):
    """Immerkaer's noise estimate on luma in [0, 1] (as 8-bit levels). Texture inflates it a little; compare against the reference."""
    a = y * 255.0
    k = a[:-2, :-2] - 2 * a[:-2, 1:-1] + a[:-2, 2:] - 2 * a[1:-1, :-2] + 4 * a[1:-1, 1:-1] - 2 * a[1:-1, 2:] + a[2:, :-2] - 2 * a[2:, 1:-1] + a[2:, 2:]
    return float(np.sqrt(np.pi / 2) / 6 * np.abs(k).mean())


def gradient_energy(y):
    gx, gy = grad(y)
    return float(np.hypot(gx, gy).mean() * 255)


def chroma_error(a, b):
    """Difference in mean colour between two float RGB arrays as the distance between their log R/G and log B/G ratios."""
    ma, mb = a.reshape(-1, 3).mean(0) + 1e-4, b.reshape(-1, 3).mean(0) + 1e-4
    d = np.log(ma[[0, 2]] / ma[1]) - np.log(mb[[0, 2]] / mb[1])
    return float(np.hypot(*d))


def gray_world_dev(a):
    m = a.reshape(-1, 3).mean(0)
    return float((m.max() - m.min()) / (m.mean() + 1e-4))


def clip_fracs(a):
    mx, y = a.max(axis=2), luma(a)
    return float((mx >= 0.992).mean()), float((y <= 0.025).mean())


# ---- degradations for the photo-editing inputs (applied to the full clean photo, then cropped) ----

def srgb_to_lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def inscribed(w, h, deg):
    """Largest centred rectangle of the same aspect that fits inside a w x h picture turned by `deg` degrees."""
    t = np.radians(abs(deg))
    s = 1.0 / (np.cos(t) + (max(w, h) / min(w, h)) * np.sin(t))
    return int(w * s) // 2 * 2, int(h * s) // 2 * 2


def degrade_photo(im, ops, seed=1):
    """im: clean PIL RGB. ops: tilt (degrees, + = counter-clockwise), stops (exposure in stops, linear light), cast [r, g, b] gains,
    crush (black point raised to this level), noise (sigma in 8-bit levels), jpeg (quality). Returns (degraded, reference, (w, h))
    where the reference is the clean photo cut to the same centred window. The window is the largest one without empty corners
    for the tilt, so the input has none and the responder meets the corners only when it straightens the photo."""
    rng = np.random.default_rng(seed)
    w, h = im.size
    tilt = float(ops.get('tilt', 0))
    cw, ch = inscribed(w, h, tilt) if tilt else (w, h)
    box_ = ((w - cw) // 2, (h - ch) // 2, (w - cw) // 2 + cw, (h - ch) // 2 + ch)
    ref = im.crop(box_)
    src = im.rotate(tilt, resample=Image.BICUBIC, expand=False).crop(box_) if tilt else ref.copy()
    a = to_f(src)
    if 'stops' in ops:
        a = lin_to_srgb(srgb_to_lin(a) * 2.0 ** ops['stops'])
    if 'cast' in ops:
        a = np.clip(a * np.array(ops['cast'], dtype=np.float32), 0, 1)
    if 'crush' in ops:
        k = ops['crush']
        a = np.clip((a - k) / (1 - k), 0, 1)
    if 'noise' in ops:
        s = ops['noise'] / 255.0
        lum = rng.standard_normal(a.shape[:2])[..., None]
        chrom = rng.standard_normal(a.shape)
        gain = 0.55 + 0.45 * np.sqrt(np.clip(luma(a), 0, 1))[..., None]
        a = np.clip(a + (0.7 * lum + 0.5 * chrom) * s * gain, 0, 1)
    out = Image.fromarray(np.round(a * 255).astype(np.uint8))
    return out, ref, (cw, ch)
