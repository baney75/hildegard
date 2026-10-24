#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Background removal with a clean matte, plus optional compositing onto a new background.

  python3 cutout.py in.jpg out.png [--model birefnet-general|isnet-general-use|u2net] [--bg bg.jpg]
                    [--shadow] [--decontaminate] [--feather 1.0]

Uses rembg (pip install rembg onnxruntime); the model downloads on first use and needs network access to the
model host. The best quality open models today are BiRefNet / BRIA RMBG-2.0 (check the RMBG licence for
commercial use) and SAM 2 when you need to click a specific object. Hair is the hard case: always inspect
a 100% crop of the edge on both a black and a white background before delivering.

--decontaminate pulls the old background's colour out of semi-transparent edge pixels (colour spill), which
is what makes a cutout look pasted on. --shadow adds a soft contact shadow under the subject when compositing.
Writes out.png (RGBA) and, if --bg is given, out_comp.png plus edge-check crops.
"""
import argparse, sys
import numpy as np
from PIL import Image, ImageFilter

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("inp"); ap.add_argument("out")
    ap.add_argument("--model", default="birefnet-general"); ap.add_argument("--bg")
    ap.add_argument("--shadow", action="store_true"); ap.add_argument("--decontaminate", action="store_true")
    ap.add_argument("--feather", type=float, default=0.6)
    a = ap.parse_args()
    try:
        from rembg import remove, new_session
    except ImportError:
        sys.exit("pip install rembg onnxruntime  (or use SAM 2 / a hosted model; see image-editing.md)")
    im = Image.open(a.inp).convert("RGB")
    try:
        sess = new_session(a.model)
    except Exception:
        print(f"model {a.model} unavailable, falling back to isnet-general-use"); sess = new_session("isnet-general-use")
    rgba = remove(im, session=sess, post_process_mask=True)
    alpha = rgba.split()[-1]
    if a.feather > 0:
        alpha = alpha.filter(ImageFilter.GaussianBlur(a.feather))
    rgb = np.asarray(im, np.float32) / 255; al = np.asarray(alpha, np.float32)[..., None] / 255
    if a.decontaminate:
        # estimate the local background colour outside the subject and remove its contribution at the edges
        bgmask = (al[..., 0] < 0.05).astype(np.float32)
        from scipy import ndimage as ndi
        w = ndi.gaussian_filter(bgmask, 12) + 1e-4
        bgc = np.stack([ndi.gaussian_filter(rgb[..., c] * bgmask, 12) / w for c in range(3)], -1)
        fg = np.where(al > 0.02, (rgb - (1 - al) * bgc) / np.maximum(al, 0.02), rgb)
        rgb = np.clip(fg, 0, 1)
    out = np.concatenate([rgb, al], -1)
    Image.fromarray((out * 255).astype(np.uint8), "RGBA").save(a.out)
    print(f"wrote {a.out}")
    if a.bg:
        bg = Image.open(a.bg).convert("RGB").resize(im.size, Image.LANCZOS)
        B = np.asarray(bg, np.float32) / 255
        if a.shadow:
            from scipy import ndimage as ndi
            sh = ndi.gaussian_filter(al[..., 0], max(4, im.height / 120))
            sh = ndi.shift(sh, (im.height / 90, im.width / 200), order=1)
            B = B * (1 - 0.45 * sh[..., None])
        comp = rgb * al + B * (1 - al)
        stem = a.out.rsplit(".", 1)[0]
        Image.fromarray((comp * 255).astype(np.uint8)).save(stem + "_comp.png")
        # edge checks on black and white: hair and halo problems show on one or the other
        gy, gx = np.gradient(al[..., 0]); g = np.hypot(gx, gy)
        if g.max() > 0:
            from scipy import ndimage as ndi
            g = ndi.uniform_filter(g, max(16, min(im.size) // 16))     # the busiest stretch of edge (hair, fringe)
            cy, cx = np.unravel_index(np.argmax(g), g.shape); r = max(64, min(im.size) // 8)
            box = (max(0, cx - r), max(0, cy - r), min(im.width, cx + r), min(im.height, cy + r))
            for name, col in (("black", 0.0), ("white", 1.0)):
                e = rgb * al + col * (1 - al)
                Image.fromarray((e * 255).astype(np.uint8)).crop(box).resize((512, 512), Image.NEAREST).save(f"{stem}_edge_{name}.png")
        print(f"wrote {stem}_comp.png and edge checks {stem}_edge_black.png / _white.png: view them at 100%")

if __name__ == "__main__":
    main()
