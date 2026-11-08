# SPDX-License-Identifier: AGPL-3.0-only
"""Synthetic photos for photo-tools.test.ts: a scene with a level horizon, upright edges, neutral whites and a marked subject, and the
degradations the tests apply to it.

  python3 photo_fixture.py scene OUT                 a 1500 x 1000 clean scene (JSON: where the subject box is, as fractions of a 1200 x 800 window)
  python3 photo_fixture.py tilt IN OUT DEG           turn by DEG degrees counter-clockwise, then cut the centre 1200 x 800 (no empty corners)
  python3 photo_fixture.py cast IN OUT R G B         multiply the channels
  python3 photo_fixture.py stops IN OUT STOPS        change exposure in linear light
  python3 photo_fixture.py noise IN OUT SIGMA        add luma and colour noise (sigma in 8-bit levels)
  python3 photo_fixture.py darkbright OUT PATCH      a dark grey picture (mean luma about 0.2) with a bright patch of value PATCH over 5 percent of it
  python3 photo_fixture.py flat OUT                  a grey picture with only noise: no lines at all
  python3 photo_fixture.py stats IN [REF]            JSON: mean colour as log R/G and log B/G, mean luma, corner and border blackness"""
import json
import math
import sys

import numpy as np
from PIL import Image


def scene():
    W, H = 1500, 1000
    rng = np.random.default_rng(7)
    y = np.linspace(0, 1, H)[:, None]
    a = np.zeros((H, W, 3), np.float32)
    hz = 0.5
    sky = np.clip(0.55 + 0.4 * (y / hz), 0, 0.93)
    a[..., 0] = sky * 0.97
    a[..., 1] = sky * 0.985
    a[..., 2] = sky * 1.0
    ground = 0.30 + 0.12 * rng.random((H // 8 + 1, W // 8 + 1))
    ground = np.kron(ground, np.ones((8, 8)))[:H, :W]
    g = (y >= hz)
    for c, k in enumerate((0.9, 1.0, 0.85)):
        a[..., c] = np.where(g, ground * k, a[..., c])
    a[(np.arange(H) >= int(hz * H) - 1) & (np.arange(H) <= int(hz * H) + 1), :, :] *= 0.8  # a clear horizon line
    # tower: dark upright rectangle; white building: a neutral bright block; subject: a red square
    a[250:520, 300:380] = (0.12, 0.13, 0.15)
    a[330:520, 800:1050] = (0.82, 0.82, 0.82)
    a[340:400, 820:1030] = (0.5, 0.52, 0.6)
    a[560:700, 420:560] = (0.8, 0.1, 0.1)
    a += rng.normal(0, 0.004, a.shape).astype(np.float32)
    return Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8))


def lin(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def unlin(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def f(path):
    return np.asarray(Image.open(path).convert('RGB'), np.float32) / 255.0


def save(a, path):
    Image.fromarray(np.clip(np.rint(a * 255), 0, 255).astype(np.uint8)).save(path, quality=95) if path.endswith('.jpg') else Image.fromarray(np.clip(np.rint(a * 255), 0, 255).astype(np.uint8)).save(path)


def main(argv):
    cmd = argv[1]
    if cmd == 'scene':
        im = scene()
        im.save(argv[2])
        # the subject (red square, 420..560 x 560..700 of 1500 x 1000) after the central 1200 x 800 cut (offset 150, 100)
        print(json.dumps({'subject': [(420 - 150) / 1200, (560 - 100) / 800, (560 - 150) / 1200, (700 - 100) / 800]}))
    elif cmd == 'tilt':
        im = Image.open(argv[2]).convert('RGB')
        r = im.rotate(float(argv[4]), resample=Image.BICUBIC)
        w, h = r.size
        r.crop(((w - 1200) // 2, (h - 800) // 2, (w - 1200) // 2 + 1200, (h - 800) // 2 + 800)).save(argv[3])
    elif cmd == 'cast':
        save(np.clip(f(argv[2]) * np.array([float(v) for v in argv[4:7]], np.float32), 0, 1), argv[3])
    elif cmd == 'stops':
        save(unlin(lin(f(argv[2])) * 2.0 ** float(argv[4])), argv[3])
    elif cmd == 'noise':
        a = f(argv[2])
        rng = np.random.default_rng(3)
        s = float(argv[4]) / 255.0
        save(np.clip(a + (0.7 * rng.standard_normal(a.shape[:2])[..., None] + 0.5 * rng.standard_normal(a.shape)) * s, 0, 1), argv[3])
    elif cmd == 'darkbright':
        rng = np.random.default_rng(11)
        a = np.clip(0.17 + rng.normal(0, 0.004, (800, 1200, 3)), 0, 1).astype(np.float32)
        a[:200, :240] = float(argv[3])
        save(a, argv[2])
    elif cmd == 'flat':
        rng = np.random.default_rng(5)
        save(np.clip(0.5 + rng.normal(0, 0.05, (700, 900, 3)), 0, 1).astype(np.float32), argv[2])
    elif cmd == 'stats':
        a = f(argv[2])
        m = a.reshape(-1, 3).mean(0) + 1e-4
        out = {'log_r_g': math.log(m[0] / m[1]), 'log_b_g': math.log(m[2] / m[1]), 'mean_luma': float((a * np.array([0.2126, 0.7152, 0.0722])).sum(-1).mean()),
               'black_border': int((a.max(axis=2)[:3].reshape(-1) < 0.012).sum() + (a.max(axis=2)[-3:].reshape(-1) < 0.012).sum()
                                   + (a.max(axis=2)[:, :3].reshape(-1) < 0.012).sum() + (a.max(axis=2)[:, -3:].reshape(-1) < 0.012).sum())}
        if len(argv) > 3:
            r = f(argv[3])
            mr = r.reshape(-1, 3).mean(0) + 1e-4
            d = np.array([math.log(m[0] / m[1]) - math.log(mr[0] / mr[1]), math.log(m[2] / m[1]) - math.log(mr[2] / mr[1])])
            out['chroma_error'] = float(np.hypot(*d))
            out['luma_error'] = out['mean_luma'] - float((r * np.array([0.2126, 0.7152, 0.0722])).sum(-1).mean())
        print(json.dumps(out))


if __name__ == '__main__':
    main(sys.argv)
