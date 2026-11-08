# SPDX-License-Identifier: AGPL-3.0-only
"""A contact sheet of a finished cut, for a model (or a person) to look at: frames spread evenly through it, then each
join as a pair (the last frame before the cut and the first after), so a bad cut shows as two pictures that don't belong
together."""

import os

import av
from PIL import Image, ImageDraw

from . import textfx


def _frames_at(path, times):
    """{time: rgb} for the frame at or just before each time."""
    want = sorted(set(round(t, 4) for t in times))
    out = {}
    with av.open(path) as c:
        v = c.streams.video[0]
        i = 0
        last = None
        for f in c.decode(v):
            if f.pts is None:
                continue
            t = float(f.pts * f.time_base)
            while i < len(want) and want[i] < t - 1e-6:
                if last is not None:
                    out[want[i]] = last
                i += 1
            last = f.to_ndarray(format="rgb24")
            if i < len(want) and abs(want[i] - t) < 1e-6:
                out[want[i]] = last
                i += 1
            if i >= len(want):
                break
        while i < len(want):
            if last is not None:
                out[want[i]] = last
            i += 1
    return out


def make(path, out_path, plan=None, count=12, cols=4, thumb=360, max_joins=8):
    """Writes the sheet; returns {path, times, joins}."""
    with av.open(path) as c:
        v = c.streams.video[0]
        fps = float(v.average_rate or 30)
        seconds = float(c.duration / av.time_base) if c.duration else 0.0
    frame = 1.0 / fps
    times = [min(seconds - frame, (i + 0.5) * seconds / count) for i in range(count)]
    joins = []
    if plan is not None:
        pf = float(plan.fps)
        js = plan["joins"]
        if len(js) > max_joins:
            js = [js[int(i * len(js) / max_joins)] for i in range(max_joins)]
        joins = [(f / pf) for f in js]
    jt = []
    for j in joins:
        jt += [max(0.0, j - frame), j]
    got = _frames_at(path, times + jt)
    sample = next(iter(got.values()))
    h0, w0 = sample.shape[:2]
    tw = thumb
    th = max(2, int(round(tw * h0 / w0)))
    label_h = 20
    cell_w, cell_h = tw + 8, th + label_h + 8
    fnt = textfx.font(13)

    def tile(t, text):
        img = Image.fromarray(got[round(t, 4)]).resize((tw, th), Image.LANCZOS)
        card = Image.new("RGB", (cell_w, cell_h), (24, 26, 30))
        card.paste(img, (4, 4))
        ImageDraw.Draw(card).text((6, th + 8), text, font=fnt, fill=(230, 230, 235))
        return card

    rows = -(-len(times) // cols)
    jrows = -(-len(joins) // (cols // 2)) if joins else 0
    head = 28
    sheet = Image.new("RGB", (cols * cell_w, head * (1 + bool(joins)) + rows * cell_h + jrows * cell_h), (14, 15, 18))
    d = ImageDraw.Draw(sheet)
    d.text((8, 6), f"{os.path.basename(path)}  {seconds:.1f} s  {w0}x{h0}  frames spread evenly", font=textfx.font(15), fill=(255, 255, 255))
    for i, t in enumerate(times):
        sheet.paste(tile(t, f"{t:.1f} s"), ((i % cols) * cell_w, head + (i // cols) * cell_h))
    y0 = head + rows * cell_h
    if joins:
        d.text((8, y0 + 6), "the joins: the frame before the cut, then the frame after", font=textfx.font(15), fill=(255, 220, 120))
        per = cols // 2
        for k, j in enumerate(joins):
            col, row = k % per, k // per
            x = col * 2 * cell_w
            y = y0 + head + row * cell_h
            sheet.paste(tile(max(0.0, j - frame), f"cut {k + 1} before"), (x, y))
            sheet.paste(tile(j, f"after, {j:.1f} s"), (x + cell_w, y))
    sheet.save(out_path, quality=88)
    return {"path": out_path, "times": [round(t, 2) for t in times], "joins": [round(j, 2) for j in joins]}
