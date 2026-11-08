# SPDX-License-Identifier: AGPL-3.0-only
"""Light denoise, then sharpen only as far as a measured noise ceiling allows.

  python3 denoise_sharpen.py IN OUT [--denoise auto|none|N] [--sharpen auto|none|AMOUNT] [--max-noise-increase PCT] [--json]

  --denoise   auto (default): strength from the measured noise, none when the photo is already clean; or a multiplier such as 0.5 or 1.5
  --sharpen   auto (default): the strongest unsharp mask whose result stays under the noise ceiling; none; or an amount from 0.1 to 1.5
  --max-noise-increase  how many percent above the denoised photo's noise the sharpened result may be (default 15). The ceiling is the
              lower of that and the photo's own noise before denoising: sharpening never gives back what denoising took out

Noise is Immerkaer's estimate on luma at 1000 px wide, in 8-bit levels, measured before, after denoising and after sharpening. Sharpening
is an unsharp mask on luma only, soft-thresholded below the noise and limited to the local range so no halos form. When even the lightest
sharpening would pass the ceiling, it is skipped and the report says so. It prints the three noise numbers and the detail kept.

Needs Pillow and numpy:  python3 -m pip install pillow numpy   (OpenCV is not used)"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import photolib as L  # noqa: E402
import numpy as np  # noqa: E402

CLEAN = 1.6  # below this noise level (8-bit levels at 1000 px) the photo is left alone
H_SCALE = 1.25  # non-local means filter strength, in noise sigmas
SEARCH = 2  # radius of the search window, in pixels (a 5 x 5 window)


def nlm(y, ycc, sigma, h_scale=H_SCALE):
    """Non-local means with 3 x 3 patches on luma `y` (H, W), the weights applied to every channel of `ycc` (H, W, 3). `sigma` is the
    per-pixel noise in [0, 1] units. Pure numpy."""
    H, W = y.shape
    R = SEARCH
    yp = np.pad(y, R + 1, mode='reflect')
    cp = np.pad(ycc, ((R, R), (R, R), (0, 0)), mode='reflect')
    h2 = (h_scale * sigma) ** 2 + 1e-12
    acc = np.zeros_like(ycc)
    wsum = np.zeros((H, W), np.float32)
    wmax = np.zeros((H, W), np.float32)
    base = yp[R + 1:R + 1 + H, R + 1:R + 1 + W]
    for dy in range(-R, R + 1):
        for dx in range(-R, R + 1):
            if dy == 0 and dx == 0:
                continue
            sh = yp[R + 1 + dy:R + 1 + dy + H, R + 1 + dx:R + 1 + dx + W]
            d = (sh - base) ** 2
            dp = np.pad(d, 1, mode='edge')  # 3 x 3 mean of the squared difference
            d3 = (dp[:-2, :-2] + dp[:-2, 1:-1] + dp[:-2, 2:] + dp[1:-1, :-2] + dp[1:-1, 1:-1] + dp[1:-1, 2:] + dp[2:, :-2] + dp[2:, 1:-1] + dp[2:, 2:]) / 9.0
            w = np.exp(-np.maximum(d3 - 2.0 * sigma * sigma, 0.0) / h2).astype(np.float32)
            acc += w[..., None] * cp[R + dy:R + dy + H, R + dx:R + dx + W]
            wsum += w
            np.maximum(wmax, w, out=wmax)
    wmax = np.maximum(wmax, 1e-3)  # the pixel itself counts as much as its best match
    return (acc + wmax[..., None] * ycc) / (wsum + wmax)[..., None]


def denoise(a, sigma_levels, strength=1.0):
    """Denoise a float RGB array. sigma_levels is the noise at the picture's own size in 8-bit levels. Colour noise is smoothed harder
    than luma noise: the eye forgives blotchy chroma less and there is little real detail in it."""
    y = L.luma(a)
    cb, cr = a[..., 2] - y, a[..., 0] - y
    ycc = np.stack([y, cb, cr], axis=-1).astype(np.float32)
    sg = max(sigma_levels / 255.0, 1e-4)
    out = nlm(y.astype(np.float32), ycc, sg, H_SCALE * strength)
    cs = float(np.clip(0.35 * sigma_levels, 0.5, 3.0)) * strength
    out[..., 1] = L.gblur(out[..., 1], cs)
    out[..., 2] = L.gblur(out[..., 2], cs)
    y2, cb2, cr2 = out[..., 0], out[..., 1], out[..., 2]
    r, b = cr2 + y2, cb2 + y2
    g = (y2 - 0.2126 * r - 0.0722 * b) / 0.7152
    return np.clip(np.stack([r, g, b], axis=-1), 0, 1)


def sharpen(a, amount, radius, noise_levels):
    """Unsharp mask on luma: the detail layer is soft-thresholded below the noise and the result limited to the local min and max plus a
    sliver, so edges gain contrast without a halo. The same gain is applied to the three channels (no colour shift)."""
    if amount <= 0:
        return a
    y = L.luma(a)
    detail = y - L.gblur(y, radius)
    t = 0.6 * noise_levels / 255.0
    detail = np.sign(detail) * np.maximum(np.abs(detail) - t, 0.0)
    y2 = y + amount * detail
    yp = np.pad(y, 1, mode='edge')
    stack = np.stack([yp[i:i + y.shape[0], j:j + y.shape[1]] for i in range(3) for j in range(3)])
    y2 = np.clip(y2, stack.min(axis=0) - 0.015, stack.max(axis=0) + 0.015)
    gain = (y2 - y)[..., None]
    return np.clip(a + gain, 0, 1)


def run(im, denoise_mode='auto', sharpen_mode='auto', max_increase=15.0):
    """Process a PIL image. Returns (PIL image, report dict). The report always has noise_in, noise_denoised, noise_out, ceiling."""
    a = L.to_f(im)
    n_in = L.noise_of(im)
    native = L.noise_sigma(L.luma(a))
    rep = {'noise_in': round(n_in, 2), 'detail_in': round(L.gradient_energy(L.luma(a)), 2)}
    if denoise_mode == 'none' or (denoise_mode == 'auto' and n_in < CLEAN):
        d, strength = a, 0.0
        rep['denoise'] = 'skipped (already clean)' if denoise_mode == 'auto' else 'off'
    else:
        strength = 1.0 if denoise_mode == 'auto' else float(denoise_mode)
        d = denoise(a, native, strength)
        rep['denoise'] = f'strength {strength:g}'
    n_dn = L.noise_of(L.from_f(d))
    rep['noise_denoised'] = round(n_dn, 2)
    ceiling = min(n_in, n_dn * (1.0 + max_increase / 100.0)) if strength else n_in * (1.0 + max_increase / 100.0)
    rep['ceiling'] = round(ceiling, 2)
    radius = float(np.clip(0.0009 * max(im.size), 0.6, 1.6))
    out, used = d, 0.0
    if sharpen_mode != 'none':
        wanted = [float(sharpen_mode)] if sharpen_mode != 'auto' else [0.9, 0.65, 0.45, 0.3, 0.18]
        for amount in wanted:
            cand = sharpen(d, amount, radius, n_dn)
            if L.noise_of(L.from_f(cand)) <= ceiling:
                out, used = cand, amount
                break
        else:
            rep['sharpen'] = 'skipped: even the lightest sharpening would pass the noise ceiling'
    if used:
        rep['sharpen'] = f'amount {used:g}, radius {radius:.2f} px'
    elif 'sharpen' not in rep:
        rep['sharpen'] = 'off'
    res = L.from_f(out)
    rep['noise_out'] = round(L.noise_of(res), 2)
    rep['detail_out'] = round(L.gradient_energy(L.luma(L.to_f(res))), 2)
    rep['ceiling_held'] = rep['noise_out'] <= rep['ceiling'] + 0.01
    return res, rep


def main(argv=None):
    ap = argparse.ArgumentParser(description='Light denoise, then sharpen up to a measured noise ceiling.')
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--denoise', default='auto')
    ap.add_argument('--sharpen', default='auto')
    ap.add_argument('--max-noise-increase', type=float, default=15.0, help='percent over the denoised noise sharpening may add')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args(argv)
    for name, v in (('--denoise', a.denoise), ('--sharpen', a.sharpen)):
        if v not in ('auto', 'none'):
            try:
                float(v)
            except ValueError:
                L.die(f'{name} takes auto, none or a number, not {v!r}')
    im = L.load(a.src)
    out, rep = run(im, a.denoise, a.sharpen, a.max_noise_increase)
    L.save(a.dst, out)
    if a.json:
        print(json.dumps({'ok': True, **rep}))
    else:
        print(f'noise (8-bit levels at 1000 px): {rep["noise_in"]} in, {rep["noise_denoised"]} after denoising, {rep["noise_out"]} out; ceiling {rep["ceiling"]}')
        print(f'denoise: {rep["denoise"]}; sharpen: {rep["sharpen"]}; detail {rep["detail_in"]} -> {rep["detail_out"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
