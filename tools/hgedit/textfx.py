# SPDX-License-Identifier: AGPL-3.0-only
"""Titles, lower thirds and captions: where they sit and how they are drawn.

The renderer draws from `layout_*` and the gate measures the same layouts, so "the captions stay inside the frame" is
checked on the numbers the picture was made from. Text is drawn with Pillow; the font is the computer's own sans if there
is one, else Pillow's bundled font."""

import os
import shutil
import subprocess
from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFont

SAFE = 0.04  # share of the frame kept clear on every side
FONT_FILES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/noto/NotoSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/arial.ttf",
)


@lru_cache(maxsize=1)
def font_file():
    if shutil.which("fc-match"):
        try:
            r = subprocess.run(["fc-match", "-f", "%{file}", "sans:bold"], capture_output=True, text=True, timeout=5)
            if r.returncode == 0 and os.path.exists(r.stdout.strip()):
                return r.stdout.strip()
        except Exception:
            pass
    for f in FONT_FILES:
        if os.path.exists(f):
            return f
    return None


@lru_cache(maxsize=64)
def font(size):
    size = max(8, int(size))
    f = font_file()
    if f:
        try:
            return ImageFont.truetype(f, size)
        except Exception:
            pass
    return ImageFont.load_default(size)


def text_size(fnt, text):
    l, t, r, b = fnt.getbbox(text)
    return r - l, b - t, l, t


class Overlay:
    """A drawn card: RGBA pixels and where its top-left corner sits in the frame."""

    def __init__(self, rgba, x, y):
        self.rgba, self.x, self.y = rgba, int(x), int(y)

    @property
    def box(self):
        h, w = self.rgba.shape[:2]
        return (self.x, self.y, self.x + w, self.y + h)


def _card(lines, fnt, pad, fg=(255, 255, 255), bg=(0, 0, 0, 150), gap=0.25, align="center", radius=None):
    sizes = [text_size(fnt, ln) for ln in lines]
    line_h = max(s[1] for s in sizes) + int(fnt.size * gap)
    w = max(s[0] for s in sizes) + 2 * pad
    h = line_h * len(lines) - int(fnt.size * gap) + 2 * pad
    img = Image.new("RGBA", (int(w), int(h)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = radius if radius is not None else pad // 2
    d.rounded_rectangle((0, 0, w - 1, h - 1), radius=r, fill=bg)
    y = pad
    for ln, (tw, th, ox, oy) in zip(lines, sizes):
        x = (w - tw) / 2 - ox if align == "center" else pad - ox
        d.text((x, y - oy), ln, font=fnt, fill=fg + (255,))
        y += line_h
    return np.asarray(img)


def layout_caption(lines, W, H, size=None, position="bottom"):
    """An Overlay for a caption cue. Text shrinks, down to 60 %, until the widest line fits inside the safe width."""
    vertical = H > W
    frac = size or (0.040 if vertical else 0.052)
    px = max(12, H * frac)
    if vertical:
        px = min(px, W * 0.058)
    fnt = font(px)
    for _ in range(12):
        widest = max(text_size(fnt, ln)[0] for ln in lines)
        if widest + px <= W * (1 - 2 * SAFE) or px <= H * frac * 0.6:
            break
        px *= 0.92
        fnt = font(px)
    pad = int(px * 0.4)
    rgba = _card(lines, fnt, pad)
    h, w = rgba.shape[:2]
    x = (W - w) // 2
    # Short-form video has the app's own buttons low on the screen; leave room for them.
    bottom_clear = 0.22 if vertical else 0.07
    if position == "bottom":
        y = int(H * (1 - bottom_clear)) - h
    elif position == "top":
        y = int(H * (0.12 if vertical else 0.06))
    else:
        y = (H - h) // 2
    return Overlay(rgba, x, y)


def layout_title(text, subtitle, kind, W, H):
    vertical = H > W
    base = H * (0.05 if vertical else 0.075)
    px = base if kind == "lower_third" else base * 1.5
    fnt = font(px)
    for _ in range(12):
        widest = text_size(fnt, text)[0]
        if widest + px <= W * (1 - 2 * SAFE) or px <= 14:
            break
        px *= 0.9
        fnt = font(px)
    pad = int(px * 0.45)
    lines = [text]
    rgba = _card(lines, fnt, pad, bg=(10, 20, 40, 190), align="left" if kind == "lower_third" else "center")
    if subtitle:
        sfnt = font(px * 0.55)
        sub = _card([subtitle], sfnt, int(pad * 0.7), fg=(220, 230, 245), bg=(10, 20, 40, 160), align="left" if kind == "lower_third" else "center")
        w = max(rgba.shape[1], sub.shape[1])
        out = np.zeros((rgba.shape[0] + sub.shape[0], w, 4), dtype=np.uint8)
        off_a = 0 if kind == "lower_third" else (w - rgba.shape[1]) // 2
        off_b = 0 if kind == "lower_third" else (w - sub.shape[1]) // 2
        out[: rgba.shape[0], off_a : off_a + rgba.shape[1]] = rgba
        out[rgba.shape[0] :, off_b : off_b + sub.shape[1]] = sub
        rgba = out
    h, w = rgba.shape[:2]
    if kind == "lower_third":
        x = int(W * SAFE * 2)
        y = int(H * (0.78 if not vertical else 0.66)) - h // 2
    else:
        x = (W - w) // 2
        y = (H - h) // 2
    return Overlay(rgba, x, y)


def inside(box, W, H, margin=0.0):
    x0, y0, x1, y1 = box
    return x0 >= W * margin and y0 >= H * margin and x1 <= W * (1 - margin) and y1 <= H * (1 - margin)


def blend(frame, overlay, scale=1.0):
    """Alpha-blends an Overlay onto an (H, W, 3) uint8 frame in place, clipped to the frame."""
    x0, y0, x1, y1 = overlay.box
    H, W = frame.shape[:2]
    cx0, cy0, cx1, cy1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    if cx1 <= cx0 or cy1 <= cy0:
        return
    src = overlay.rgba[cy0 - y0 : cy1 - y0, cx0 - x0 : cx1 - x0]
    a = (src[..., 3:4].astype(np.float32) / 255.0) * scale
    dst = frame[cy0:cy1, cx0:cx1].astype(np.float32)
    frame[cy0:cy1, cx0:cx1] = (dst * (1 - a) + src[..., :3].astype(np.float32) * a + 0.5).astype(np.uint8)


def fade(t, start, end, ramp=0.3):
    """0 to 1 over `ramp` seconds after start, 1, then back to 0 over the last `ramp` seconds."""
    ramp = min(ramp, (end - start) / 3)
    if ramp <= 0:
        return 1.0
    return float(max(0.0, min(1.0, (t - start) / ramp, (end - t) / ramp)))
