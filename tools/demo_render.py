# SPDX-License-Identifier: AGPL-3.0-only
"""Renders a browser demo: the frames the harness caught, at a steady 30 a second, on a clean backdrop.

Reads one JSON job on stdin:
  frames   [{"file": path, "t": seconds}]   in order; a frame holds until the next one
  clicks   [{"t": seconds, "x": px, "y": px}] where the page was clicked, in its own pixels
  out      path of the .mp4 to write
  aspect   "16:9" | "1:1" | "9:16"
  backdrop {"kind": "none" | "solid" | "gradient" | "image", "colors": ["#rrggbb", ...], "image": path}
  padding  share of the frame's shorter side around the window (0 to 0.25)
  radius   corner radius of the window, in output pixels
  shadow   true for a soft shadow under the window
  zoom     true to ease toward each click and back
  seconds  how long the demo ran (the last frame holds to here)

Prints one JSON line: {"seconds": n, "width": w, "height": h, "frames": n}.
Uses only PyAV, numpy and Pillow, which the film export already needs.
"""

import json
import sys
from fractions import Fraction

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

FPS = 30
SIZES = {"16:9": (1920, 1080), "1:1": (1080, 1080), "9:16": (1080, 1920)}


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def backdrop(spec, w, h):
    kind = spec.get("kind", "gradient")
    colors = [hex_rgb(c) for c in spec.get("colors") or ["#1f5a3d", "#0a0e13"]]
    if kind == "image" and spec.get("image"):
        img = Image.open(spec["image"]).convert("RGB")
        # Cover: fill the frame, cropping what is over.
        k = max(w / img.width, h / img.height)
        img = img.resize((round(img.width * k), round(img.height * k)), Image.LANCZOS)
        x, y = (img.width - w) // 2, (img.height - h) // 2
        return img.crop((x, y, x + w, y + h))
    if kind == "solid" or len(colors) == 1:
        return Image.new("RGB", (w, h), colors[0])
    # A diagonal gradient through the colors.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = (xx / max(1, w - 1) + yy / max(1, h - 1)) / 2
    stops = np.linspace(0, 1, len(colors))
    out = np.zeros((h, w, 3), np.float32)
    for ch in range(3):
        out[..., ch] = np.interp(t, stops, [c[ch] for c in colors])
    return Image.fromarray(out.round().astype(np.uint8), "RGB")


def layout(job, src_w, src_h):
    """The output size, and where the window goes on it."""
    W, H = SIZES.get(job.get("aspect", "16:9"), SIZES["16:9"])
    kind = (job.get("backdrop") or {}).get("kind", "gradient")
    if kind == "none":
        # No backdrop: the window is the frame, at its own size, even.
        k = min(1.0, 1920 / src_w)
        W, H = int(src_w * k) & ~1, int(src_h * k) & ~1
        return W, H, (0, 0, W, H)
    pad = round(min(W, H) * max(0.0, min(0.25, float(job.get("padding", 0.06)))))
    k = min((W - 2 * pad) / src_w, (H - 2 * pad) / src_h)
    w, h = round(src_w * k), round(src_h * k)
    x, y = (W - w) // 2, (H - h) // 2
    return W, H, (x, y, w, h)


def ease(u):
    return u * u * (3 - 2 * u)


def zoom_at(t, clicks):
    """How far in, and toward where, at time t: in over 0.5 s before a click, hold 1 s, out over 0.6 s."""
    best = (1.0, 0.5, 0.5)
    for c in clicks:
        d = t - c["t"]
        if -0.5 <= d <= 1.6:
            if d < 0:
                u = ease((d + 0.5) / 0.5)
            elif d <= 1.0:
                u = 1.0
            else:
                u = 1 - ease((d - 1.0) / 0.6)
            z = 1 + 0.6 * u
            if z > best[0]:
                best = (z, c["nx"], c["ny"])
    return best


def main():
    job = json.load(sys.stdin)
    frames = job["frames"]
    if not frames:
        raise SystemExit("No frames were caught.")
    first = Image.open(frames[0]["file"])
    src_w, src_h = first.size
    W, H, (x, y, w, h) = layout(job, src_w, src_h)
    kind = (job.get("backdrop") or {}).get("kind", "gradient")
    base = backdrop(job.get("backdrop") or {}, W, H) if kind != "none" else Image.new("RGB", (W, H))
    radius = int(job.get("radius", 18)) if kind != "none" else 0
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w - 1, h - 1), radius=radius, fill=255)
    if kind != "none" and job.get("shadow", True):
        sh = Image.new("L", (W, H), 0)
        off = max(4, round(min(W, H) * 0.012))
        ImageDraw.Draw(sh).rounded_rectangle((x, y + off, x + w, y + h + off), radius=radius, fill=110)
        sh = sh.filter(ImageFilter.GaussianBlur(max(8, round(min(W, H) * 0.02))))
        base = Image.composite(Image.new("RGB", (W, H), (0, 0, 0)), base, sh)
    clicks = [
        {"t": c["t"], "nx": (x + c["x"] * w / src_w) / W, "ny": (y + c["y"] * h / src_h) / H}
        for c in job.get("clicks") or []
    ]
    seconds = max(float(job.get("seconds") or 0), frames[-1]["t"] + 1 / FPS)
    total = max(1, round(seconds * FPS))

    with av.open(job["out"], "w") as dst:
        vs = dst.add_stream("libx264", rate=FPS)
        vs.width, vs.height = W, H
        vs.pix_fmt = "yuv420p"
        vs.options = {"crf": "20", "preset": "veryfast"}
        vs.time_base = Fraction(1, FPS)
        i = 0
        cur = None
        cur_file = None
        for n in range(total):
            t = n / FPS
            while i + 1 < len(frames) and frames[i + 1]["t"] <= t:
                i += 1
            if frames[i]["file"] != cur_file:
                cur_file = frames[i]["file"]
                win = Image.open(cur_file).convert("RGB").resize((w, h), Image.LANCZOS)
                cur = base.copy()
                cur.paste(win, (x, y), mask)
            img = cur
            if job.get("zoom") and clicks:
                z, cx, cy = zoom_at(t, clicks)
                if z > 1.001:
                    cw, chh = W / z, H / z
                    left = min(max(0, cx * W - cw / 2), W - cw)
                    top = min(max(0, cy * H - chh / 2), H - chh)
                    img = cur.crop((round(left), round(top), round(left + cw), round(top + chh))).resize(
                        (W, H), Image.LANCZOS
                    )
            frame = av.VideoFrame.from_image(img)
            frame.pts = n
            for p in vs.encode(frame):
                dst.mux(p)
        for p in vs.encode():
            dst.mux(p)
    print(json.dumps({"seconds": total / FPS, "width": W, "height": H, "frames": total}))


if __name__ == "__main__":
    main()
