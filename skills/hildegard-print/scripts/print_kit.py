# SPDX-License-Identifier: AGPL-3.0-only
# Portions adapted from print3d by mfranzon (https://github.com/mfranzon/print3d), MIT License,
# Copyright (c) 2026 mfranzon: the photo grid, perspective rectifying, the scale references, the measuring tolerance
# and the evidence file (print3d's photo.py and spec.py), and the fit coupon (coupons/fit_coupon.py).
# See THIRD_PARTY_NOTICES.md.
"""Measuring a real object for a print, and keeping the evidence.

A vision model guesses pixel positions to within a few percent of the image: centimetres on a desk photo. So points
are read off a ruler instead. `grid` draws labelled pixel coordinates over the photo or a zoomed crop of it, and every
other command takes the pixels read off those grids. Every dimension keeps where it came from (measured off a photo,
given by your user, quoted from a listing, or assumed and why) and how far off it can be, in `spec.json`. `loop`
prints what `loop_start` takes: `evidence`, and `views` with each photographed outline in millimetres.

    python print_kit.py grid photo.jpg                                   # the whole photo, with a ruler
    python print_kit.py grid photo.jpg --crop 800,400,1300,900           # zoom in to read a feature's ends
    python print_kit.py scale front photo.jpg card 812,1490,1490,1488    # a bank card's long edge in the photo
    python print_kit.py rectify top photo.jpg 410,300,1620,340,1580,1100,380,1050 297x210   # an A4 sheet at an angle
    python print_kit.py dim width front 860,700,1410,702                 # measured, with its tolerance
    python print_kit.py give wall 2.4 --source assumed --why "PLA, 0.4 mm nozzle: six perimeters"
    python print_kit.py listing https://example.com/clip --title "Shelf clip, 4 pack" --price 6.99 --currency USD
    python print_kit.py listed hole 5 --quote "fits 5 mm shelf pins"
    python print_kit.py outline front 860,700,1410,702,1408,1210,862,1208  # or: --mask cutout.png
    python print_kit.py meet 100,100,400,110,390,500,380,900             # a corner hidden behind something
    python print_kit.py unknown "the depth of the slot: no photo shows it"
    python print_kit.py loop                                             # JSON for loop_start
    python print_kit.py coupon fit_coupon.obj                            # print it once to calibrate the fits

The job folder is ./print-job unless you pass --job. Needs Pillow and numpy.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageOps

# Objects people photograph next to a part, by the length the two points span (mm).
REFERENCES_MM = {
    "card": 85.6,  # ISO/IEC 7810 ID-1: a bank card or ID card, long edge
    "card-short": 53.98,
    "a4": 297.0,
    "a4-short": 210.0,
    "letter": 279.4,
    "letter-short": 215.9,
    "euro-1": 23.25,
    "euro-2": 25.75,
    "euro-0.50": 24.25,
    "us-quarter": 24.26,
    "us-penny": 19.05,
    "uk-pound": 23.43,
}
# How far off a point picked off a grid crop can be, in photo pixels.
PICK_ERROR_PX = 3.0
# A listed size is rounded: whole millimetres unless the listing says otherwise.
LISTING_TOLERANCE_MM = 0.5
# The camera's axes per view, in the printed part's frame (z up off the bed): where it looks, and up in the photo.
VIEW_AXES = {
    "front": ("+y", "+z"),
    "back": ("-y", "+z"),
    "left": ("+x", "+z"),
    "right": ("-x", "+z"),
    "top": ("-z", "+y"),
    "bottom": ("+z", "-y"),
}
AXES = ("+x", "-x", "+y", "-y", "+z", "-z")
RECTIFY_PX_PER_MM = 20
RECTIFY_MARGIN = 0.25  # room around a rectified face, as a fraction of its longer side, for what overhangs it
GRID_LONG_SIDE_PX = 1600
MAX_ZOOM = 8.0
NICE_STEPS = (1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000)
# The usual clearances per side (mm) the fit coupon brackets; Hildegard's printer_profile keeps the calibrated ones.
COUPON_CLEARANCES = (0.00, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40)


class KitError(ValueError):
    """A request that can't be honoured, said plainly."""


# ── Photos ──────────────────────────────────────────────────────────────────────────────────────────────────────


def open_upright(photo):
    """The photo as a viewer shows it (EXIF rotation applied); a cut-out on transparency reads as on white."""
    with Image.open(Path(photo).expanduser()) as image:
        upright = ImageOps.exif_transpose(image)
        if "A" not in upright.getbands() and upright.mode != "P":
            return upright.convert("RGB")
        rgba = upright.convert("RGBA")
        flat = Image.new("RGB", rgba.size, "white")
        flat.paste(rgba, mask=rgba.getchannel("A"))
        return flat


def grid(photo, out=None, crop=None, step=None):
    """Labelled photo-pixel coordinates over the photo, or over a zoomed crop of it."""
    image = open_upright(photo)
    width, height = image.size
    x0, y0, x1, y1 = crop or (0, 0, width, height)
    x0, y0, x1, y1 = max(0, int(x0)), max(0, int(y0)), min(width, int(x1)), min(height, int(y1))
    if x1 - x0 < 2 or y1 - y0 < 2:
        raise KitError(f"The crop {crop} is empty inside a {width}x{height} photo.")
    region = image.crop((x0, y0, x1, y1))
    zoom = min(MAX_ZOOM, GRID_LONG_SIDE_PX / max(region.size))
    view = region.resize((round(region.width * zoom), round(region.height * zoom)), Image.LANCZOS)
    span = max(x1 - x0, y1 - y0)
    step = step or next((s for s in NICE_STEPS if s >= span / 16), NICE_STEPS[-1])
    draw = ImageDraw.Draw(view, "RGBA")
    font = ImageFont.load_default(size=max(12, GRID_LONG_SIDE_PX // 90))
    line, label = (255, 0, 255, 150), (255, 255, 255, 255)
    for x in range(-(-x0 // step) * step, x1 + 1, step):
        px = (x - x0) * zoom
        draw.line([(px, 0), (px, view.height)], fill=line, width=1)
        draw.text((px + 2, 2), str(x), fill=label, font=font, stroke_width=2, stroke_fill="black")
    for y in range(-(-y0 // step) * step, y1 + 1, step):
        py = (y - y0) * zoom
        draw.line([(0, py), (view.width, py)], fill=line, width=1)
        draw.text((2, py + 2), str(y), fill=label, font=font, stroke_width=2, stroke_fill="black")
    stem = Path(photo).stem + ("_" + "_".join(str(v) for v in (x0, y0, x1, y1)) if crop else "")
    out = Path(out) if out else Path(photo).with_name(f"{stem}.grid.png")
    out.parent.mkdir(parents=True, exist_ok=True)
    view.save(out)
    return {"grid": str(out), "photo_px": [width, height], "crop": [x0, y0, x1, y1], "step_px": step,
            "zoom": round(zoom, 3), "next": "The labels are photo pixels. Crop tighter around a feature to read its ends."}


def meet(a1, a2, b1, b2):
    """Where line a1-a2 crosses line b1-b2: a corner hidden behind something, from its two edges."""
    (x1, y1), (x2, y2), (x3, y3), (x4, y4) = a1, a2, b1, b2
    d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(d) < 1e-9:
        raise KitError("Those two edges are parallel; they never meet.")
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d
    return [round(x1 + t * (x2 - x1), 1), round(y1 + t * (y2 - y1), 1)]


def _homography(src, dst):
    """Coefficients that map each `src` point onto its `dst` point, in Pillow's PERSPECTIVE order."""
    a, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -x * u, -y * u])
        b.append(u)
        a.append([0, 0, 0, x, y, 1, -x * v, -y * v])
        b.append(v)
    a, b = np.array(a, float), np.array(b, float)
    if abs(np.linalg.det(a)) < 1e-9:
        raise KitError("Three of the corners are in a line; pick the four corners of the face.")
    return list(np.linalg.solve(a, b))


def rectify(photo, corners, size_mm, out):
    """The photo warped so the face with these corners (clockwise from its top-left) is seen square-on."""
    w, h = size_mm
    margin = RECTIFY_MARGIN * max(w, h)
    ppm = RECTIFY_PX_PER_MM
    face = [(margin, margin), (margin + w, margin), (margin + w, margin + h), (margin, margin + h)]
    face_px = [(x * ppm, y * ppm) for x, y in face]
    size = (round((w + 2 * margin) * ppm), round((h + 2 * margin) * ppm))
    coeffs = _homography(face_px, [tuple(c) for c in corners])  # Pillow maps output pixels back to the photo
    warped = open_upright(photo).transform(size, Image.Transform.PERSPECTIVE, coeffs, Image.Resampling.BICUBIC,
                                           fillcolor="white")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    warped.save(out)
    edges = [math.dist(corners[i], corners[(i + 1) % 4]) for i in range(4)]
    return face_px, min(edges)


def trace_mask(mask_path, photo_size):
    """The outline of the largest shape in a mask (white, or opaque, on the object), as photo pixels."""
    with Image.open(mask_path) as raw:
        up = ImageOps.exif_transpose(raw)
        grey = up.getchannel("A") if "A" in up.getbands() else up.convert("L")
    if grey.size != tuple(photo_size):
        raise KitError(f"The mask is {grey.size[0]}x{grey.size[1]} but the photo is {photo_size[0]}x{photo_size[1]}.")
    k = max(1.0, max(grey.size) / 600)  # trace at about 600 px; the outline is simplified anyway
    small = grey.resize((max(1, round(grey.width / k)), max(1, round(grey.height / k))), Image.BILINEAR)
    on = np.pad(np.asarray(small) > 127, 1)
    seen = np.zeros_like(on)
    best, best_n = None, 0
    for start in zip(*np.nonzero(on)):
        if seen[start]:
            continue
        seen[start] = True
        q, n = deque([start]), 0
        while q:
            y, x = q.popleft()
            n += 1
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                p = (y + dy, x + dx)
                if on[p] and not seen[p]:
                    seen[p] = True
                    q.append(p)
        if n > best_n:
            best, best_n = start, n
    if best is None:
        raise KitError("The mask is empty: nothing in it is white or opaque.")
    # Only the largest shape, then walk its border (Moore neighbours), starting from its topmost-leftmost pixel.
    keep = np.zeros_like(on)
    keep[best] = True
    q = deque([best])
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            p = (y + dy, x + dx)
            if on[p] and not keep[p]:
                keep[p] = True
                q.append(p)
    ys, xs = np.nonzero(keep)
    first = min(zip(ys, xs))
    ring = [(0, -1), (-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1)]
    path, cur, back = [first], first, 0  # we came from the left, which is outside
    for _ in range(8 * int(keep.sum()) + 8):
        for i in range(8):
            d = (back + 1 + i) % 8
            p = (cur[0] + ring[d][0], cur[1] + ring[d][1])
            if keep[p]:
                back = (d + 4) % 8
                cur = p
                break
        else:
            break  # a single pixel
        if cur == first:
            break
        path.append(cur)
    pts = np.array([((x - 1 + 0.5) * k, (y - 1 + 0.5) * k) for y, x in path])
    # The walk joins pixel centres, half a pixel inside the edge all round: grow it back out by that half pixel.
    lo, hi = pts.min(0), pts.max(0)
    mid, span = (lo + hi) / 2, np.maximum(hi - lo, 1e-9)
    pts = mid + (pts - mid) * (span + k) / span
    return [[round(x, 1), round(y, 1)] for x, y in simplify(pts, 1.0 * k)]


def simplify(points, eps):
    """Douglas-Peucker on a closed outline: the fewest points within `eps` of it."""
    if len(points) < 4:
        return points
    pts = np.array(points, float)
    far = int(np.argmax(np.linalg.norm(pts - pts[0], axis=1)))

    def dp(a):
        if len(a) < 3:
            return list(a)
        s, e = a[0], a[-1]
        d = e - s
        ln = np.hypot(*d)
        dist = np.abs(d[0] * (a[:, 1] - s[1]) - d[1] * (a[:, 0] - s[0])) / ln if ln > 0 else np.linalg.norm(a - s, axis=1)
        i = int(np.argmax(dist))
        if dist[i] <= eps:
            return [s, e]
        return dp(a[: i + 1])[:-1] + dp(a[i:])

    first = dp(pts[: far + 1])
    second = dp(np.vstack([pts[far:], pts[:1]]))
    return [list(p) for p in first[:-1] + second[:-1]]


# ── The evidence ────────────────────────────────────────────────────────────────────────────────────────────────


def points(text, count=None):
    """`"x1,y1,x2,y2"` as [[x1, y1], [x2, y2]]."""
    try:
        vals = [float(v) for v in text.replace(" ", "").split(",") if v]
    except ValueError:
        raise KitError(f"Points are numbers: {text!r}") from None
    if len(vals) % 2:
        raise KitError(f"Points come in x,y pairs; got {len(vals)} numbers.")
    pts = [vals[i: i + 2] for i in range(0, len(vals), 2)]
    if count is not None and len(pts) != count:
        raise KitError(f"Expected {count} points, got {len(pts)}.")
    return pts


def load(job):
    path = Path(job) / "spec.json"
    if path.is_file():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"views": {}, "dims": {}, "unknowns": []}


def save(job, spec):
    Path(job).mkdir(parents=True, exist_ok=True)
    (Path(job) / "spec.json").write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")


def reference_mm(spec, ref):
    """A reference's length and how far off it can be, both in mm."""
    if ref.startswith("dim:"):
        d = spec["dims"].get(ref[4:])
        if d is None or d["source"] not in ("user", "listing"):
            raise KitError(f"{ref!r} must name a dimension your user gave or the listing states.")
        return d["mm"], d.get("tolerance_mm", 0.0)
    if ref in REFERENCES_MM:
        return REFERENCES_MM[ref], 0.0
    try:
        return float(ref), 0.0
    except ValueError:
        raise KitError(f"Unknown reference {ref!r}. Use a length in mm, dim:<name>, or one of: "
                       f"{', '.join(sorted(REFERENCES_MM))}.") from None


def axes_for(view, look, up):
    dl, du = VIEW_AXES.get(view, (None, None))
    look, up = look or dl, up or du
    if look is None or up is None:
        raise KitError(f"The view {view!r} isn't one of {', '.join(VIEW_AXES)}; pass --look and --up.")
    if look not in AXES or up not in AXES or look[1] == up[1]:
        raise KitError(f"--look and --up are two different axes from {', '.join(AXES)}.")
    return look, up


def set_scale(spec, view, photo, ref, pts, look=None, up=None):
    ref_px = math.dist(*pts)
    if ref_px < 1:
        raise KitError("The reference's two points are the same point.")
    look, up = axes_for(view, look, up)
    ref_len, ref_tol = reference_mm(spec, ref)
    e = spec["views"].setdefault(view, {})
    e.update({
        "photo": str(Path(photo).expanduser().resolve()), "look": look, "up": up,
        "scale": {"ref": ref, "ref_mm": ref_len, "ref_tolerance_mm": ref_tol, "points": pts,
                  "ref_px": round(ref_px, 2), "mm_per_px": ref_len / ref_px},
        "assumes": "The reference lies in the same plane as what is measured, and the photo is square-on from a distance.",
    })
    return e


def tolerance(scale, mm, pick_px):
    """How far off a length read off a scaled view can be: its own picking error, plus the reference's picking
    error and rounding, carried as a ratio of the length."""
    ratio = pick_px / scale["ref_px"] + scale.get("ref_tolerance_mm", 0.0) / scale["ref_mm"]
    return pick_px * scale["mm_per_px"] + mm * ratio


def scaled(spec, view):
    e = spec["views"].get(view)
    if not e or "scale" not in e:
        raise KitError(f"The view {view!r} has no scale yet: run `scale {view} ...` or `rectify {view} ...` first.")
    return e


def outline_mm(view):
    """A view's outline in millimetres, u right and v up, from the bottom-left of its bounds."""
    mpp = view["scale"]["mm_per_px"]
    o = np.array(view["outline"], float)
    u = (o[:, 0] - o[:, 0].min()) * mpp
    v = (o[:, 1].max() - o[:, 1]) * mpp  # photo rows run down; the loop's v runs up
    size = max(np.ptp(u), np.ptp(v))
    return [[round(a, 2), round(b, 2)] for a, b in zip(u, v)], tolerance(view["scale"], size, math.sqrt(2) * PICK_ERROR_PX)


def for_loop(spec):
    """What loop_start takes: `evidence`, and `views` for every view with an outline."""
    dims = []
    for name, d in spec["dims"].items():
        how = d.get("why") or (f"“{d['quote']}”" if d.get("quote") else None)
        if d["source"] == "measured":
            how = f"off the {d['view']} photo, {d['px']:.0f} px against {spec['views'][d['view']]['scale']['ref']}"
        entry = {"name": name, "mm": d["mm"], "source": d["source"]}
        if d.get("tolerance_mm") is not None:
            entry["tolerance_mm"] = d["tolerance_mm"]
        if how:
            entry["how"] = how[:300]
        dims.append(entry)
    evidence = {"dims": dims, "unknowns": spec["unknowns"]}
    listing = spec.get("listing")
    if listing and listing.get("price") is not None and listing.get("currency"):
        evidence["listing"] = {k: listing[k] for k in ("title", "url", "price", "currency") if k in listing}
    views = []
    for name, v in spec["views"].items():
        if "outline" in v and "scale" in v:
            o, tol = outline_mm(v)
            views.append({"name": name, "look": v["look"], "up": v["up"], "outline": o, "tolerance_mm": round(max(tol, 0.5), 2)})
    out = {"evidence": evidence}
    if views:
        out["views"] = views
    return out


# ── The fit coupon ──────────────────────────────────────────────────────────────────────────────────────────────


def _extrude(tris2d, h):
    """A watertight solid from a 2D triangulation: the top, the bottom, and walls along every open edge."""
    key, verts, faces = {}, [], []
    for t in tris2d:
        ids = []
        for x, y in t:
            k = (round(x, 6), round(y, 6))
            if k not in key:
                key[k] = len(verts)
                verts.append(k)
            ids.append(key[k])
        a, b, c = (np.array(verts[i]) for i in ids)
        if (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0:
            ids = [ids[0], ids[2], ids[1]]  # every triangle anticlockwise, seen from above
        faces.append(ids)
    n = len(verts)
    edges = {}
    for f in faces:
        for i in range(3):
            a, b = f[i], f[(i + 1) % 3]
            edges[(a, b)] = edges.get((a, b), 0) + 1
    v = [[x, y, 0.0] for x, y in verts] + [[x, y, h] for x, y in verts]
    f = [[a + n, b + n, c + n] for a, b, c in faces] + [[a, c, b] for a, b, c in faces]
    for a, b in edges:
        if (b, a) not in edges:  # an open edge: the outside, or a hole's rim
            f += [[a, b, b + n], [a, b + n, a + n]]
    return np.array(v, float), np.array(f)


def _lathe(profile, segments=96):
    """A solid of revolution about z from an (r, z) profile that starts and ends on the axis."""
    v, rings = [], []
    for r, z in profile:
        if r == 0:
            rings.append([len(v)])
            v.append([0.0, 0.0, z])
        else:
            rings.append(list(range(len(v), len(v) + segments)))
            v += [[r * math.cos(2 * math.pi * j / segments), r * math.sin(2 * math.pi * j / segments), z]
                  for j in range(segments)]
    f = []
    for a, b in zip(rings, rings[1:]):
        for j in range(segments):
            k = (j + 1) % segments
            if len(a) == 1:
                f.append([a[0], b[k], b[j]])
            elif len(b) == 1:
                f.append([a[j], a[k], b[0]])
            else:
                f += [[a[j], a[k], b[k]], [a[j], b[k], b[j]]]
    return np.array(v, float), np.array(f)


def coupon(pin_d=8.0, clearances=COUPON_CLEARANCES, segments=48):
    """A strip of holes, each looser than the last, and the pin to try in them.

    The holes run from the tab (0.00 mm per side) to the far end; the clearances are in the order given. The pin
    stands on a grip flange, so the first layer's squish lands on the flange and not on the surface you're measuring.
    """
    if segments % 8:
        raise KitError("segments must be a multiple of 8, so the cells' corners line up.")
    s = pin_d / 2 + max(clearances) + 3.0  # half a cell: three millimetres of wall past the loosest hole
    tris = []
    for i, c in enumerate(clearances):
        cx = i * 2 * s
        r = pin_d / 2 + c
        th = [2 * math.pi * j / segments for j in range(segments)]
        sq = [(cx + s * math.cos(t) / max(abs(math.cos(t)), abs(math.sin(t))),
               s * math.sin(t) / max(abs(math.cos(t)), abs(math.sin(t)))) for t in th]
        ci = [(cx + r * math.cos(t), r * math.sin(t)) for t in th]
        for j in range(segments):
            k = (j + 1) % segments
            tris += [(sq[j], sq[k], ci[k]), (sq[j], ci[k], ci[j])]
        if i == 0:
            # The tab that marks the tight end: it meets the first cell's left side at that side's own points.
            left = [p for p in sq if p[0] <= cx - s + 1e-9]
            left.sort(key=lambda p: -p[1])
            tab = (cx - 1.5 * s, 0.0)
            ring = left + [(cx - 2 * s, -s), (cx - 2 * s, s)]
            tris += [(tab, ring[j], ring[(j + 1) % len(ring)]) for j in range(len(ring))]
    plate = _extrude(tris, 5.0)
    shaft = 12.0
    pin = _lathe([(0, 0), (7.0, 0), (7.0, 3.0), (pin_d / 2, 3.0), (pin_d / 2, 3.0 + shaft - 0.4),
                  (pin_d / 2 - 0.4, 3.0 + shaft), (0, 3.0 + shaft)], segments * 2)
    pv, pf = pin
    pv = pv + [len(clearances) * 2 * s + 8.0, 0, 0]
    return [("holes", plate), ("pin", (pv, pf))]


def write_obj(path, parts):
    lines, n = [], 0
    for name, (v, f) in parts:
        lines.append(f"o {name}")
        lines += [f"v {x:.4f} {y:.4f} {z:.4f}" for x, y, z in v]
        lines += [f"f {a + n + 1} {b + n + 1} {c + n + 1}" for a, b, c in f]
        n += len(v)
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


# ── The command line ────────────────────────────────────────────────────────────────────────────────────────────


def main(argv=None):
    ap = argparse.ArgumentParser(prog="print_kit.py", description=__doc__.split("\n\n")[0])
    ap.add_argument("--job", default="print-job", help="the folder that keeps spec.json (default ./print-job)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("grid", help="a ruler over the photo, or over a crop of it")
    g.add_argument("photo")
    g.add_argument("--crop", help="x0,y0,x1,y1 in photo pixels")
    g.add_argument("--step", type=int)
    g.add_argument("--out")
    s = sub.add_parser("scale", help="a view's scale, from a reference of known length")
    s.add_argument("view")
    s.add_argument("photo")
    s.add_argument("ref", help=f"a length in mm, dim:<name>, or {', '.join(REFERENCES_MM)}")
    s.add_argument("points", help="x1,y1,x2,y2: the reference's two ends")
    s.add_argument("--look", choices=AXES)
    s.add_argument("--up", choices=AXES)
    r = sub.add_parser("rectify", help="a view from a flat face of known size seen at an angle")
    r.add_argument("view")
    r.add_argument("photo")
    r.add_argument("corners", help="eight numbers: the face's corners clockwise from its top-left")
    r.add_argument("size", help="the face's width x height in mm, such as 297x210")
    r.add_argument("--look", choices=AXES)
    r.add_argument("--up", choices=AXES)
    d = sub.add_parser("dim", help="a dimension measured off a scaled view")
    d.add_argument("name")
    d.add_argument("view")
    d.add_argument("points", help="x1,y1,x2,y2")
    gv = sub.add_parser("give", help="a dimension your user gave, or one you assumed")
    gv.add_argument("name")
    gv.add_argument("mm", type=float)
    gv.add_argument("--source", choices=("user", "assumed"), required=True)
    gv.add_argument("--why")
    ls = sub.add_parser("listed", help="a dimension the shop states, with its words")
    ls.add_argument("name")
    ls.add_argument("mm", type=float)
    ls.add_argument("--quote", required=True)
    ls.add_argument("--tolerance", type=float)
    li = sub.add_parser("listing", help="what the part replaces: where it's sold and what it costs")
    li.add_argument("url")
    li.add_argument("--title")
    li.add_argument("--price", type=float)
    li.add_argument("--currency")
    o = sub.add_parser("outline", help="the object's outline in a scaled view, for the likeness check")
    o.add_argument("view")
    o.add_argument("points", nargs="?", help="x,y,x,y,... around the object, in photo pixels")
    o.add_argument("--mask", help="or a mask (a background-removed cut-out, or white on black)")
    m = sub.add_parser("meet", help="where two edges cross")
    m.add_argument("points", help="x1,y1,x2,y2 on one edge, then x3,y3,x4,y4 on the other")
    u = sub.add_parser("unknown", help="what no photo shows")
    u.add_argument("text")
    sub.add_parser("show", help="the evidence so far")
    sub.add_parser("loop", help="evidence and views as loop_start takes them")
    c = sub.add_parser("coupon", help="the fit coupon, as an OBJ with the holes and the pin named")
    c.add_argument("out", nargs="?", default="fit_coupon.obj")
    c.add_argument("--pin", type=float, default=8.0, help="the pin's diameter in mm (default 8)")
    a = ap.parse_args(argv)

    spec = load(a.job)
    result = None
    if a.cmd == "grid":
        result = grid(a.photo, a.out, tuple(float(v) for v in a.crop.split(",")) if a.crop else None, a.step)
    elif a.cmd == "scale":
        result = set_scale(spec, a.view, a.photo, a.ref, points(a.points, 2), a.look, a.up)
    elif a.cmd == "rectify":
        corners = points(a.corners, 4)
        try:
            w, h = (float(x) for x in a.size.lower().split("x"))
        except ValueError:
            raise KitError("The size is width x height in mm, such as 297x210.") from None
        out = Path(a.job) / f"{a.view}.rectified.png"
        face, shortest = rectify(a.photo, corners, (w, h), out)
        (x0, y0), (x1, _) = face[0], face[1]
        e = set_scale(spec, a.view, out, str(w), [[x0, y0], [x1, y0]], a.look, a.up)
        e["scale"]["ref_px"] = round(shortest, 2)  # the picking error lives in the photo, where the face was smaller
        e["rectified"] = {"from_photo": str(Path(a.photo).resolve()), "corners": corners, "size_mm": [w, h]}
        e["assumes"] = ("What is measured lies in the rectified face; anything standing off it, like a boss or a stud, "
                        "shifts with the viewing angle.")
        result = {**e, "next": f"Read every later point for {a.view} off {out} (grid it first)."}
    elif a.cmd == "dim":
        scale = scaled(spec, a.view)["scale"]
        pts = points(a.points, 2)
        px = math.dist(*pts)
        mm = px * scale["mm_per_px"]
        result = spec["dims"][a.name] = {"mm": round(mm, 2), "source": "measured",
                                         "tolerance_mm": round(tolerance(scale, mm, math.sqrt(2) * PICK_ERROR_PX), 2),
                                         "view": a.view, "points": pts, "px": round(px, 2)}
    elif a.cmd == "give":
        if a.source == "assumed" and not a.why:
            raise KitError("Say why: an assumed dimension needs --why.")
        result = spec["dims"][a.name] = {"mm": a.mm, "source": a.source, **({"why": a.why} if a.why else {})}
    elif a.cmd == "listed":
        result = spec["dims"][a.name] = {"mm": a.mm, "source": "listing", "quote": a.quote,
                                         "tolerance_mm": LISTING_TOLERANCE_MM if a.tolerance is None else a.tolerance}
    elif a.cmd == "listing":
        listing = {"url": a.url, "title": a.title, "price": a.price,
                   "currency": a.currency.upper() if a.currency else None}
        result = spec["listing"] = {k: v for k, v in listing.items() if v is not None}
    elif a.cmd == "outline":
        e = scaled(spec, a.view)
        if a.mask:
            e["outline"] = trace_mask(a.mask, open_upright(e["photo"]).size)
        elif a.points:
            pts = points(a.points)
            if len(pts) < 3:
                raise KitError("An outline needs at least three points.")
            e["outline"] = pts
        else:
            raise KitError("Give the outline as points, or --mask.")
        o, tol = outline_mm(e)
        w, h = np.ptp(np.array(o), 0)
        result = {"view": a.view, "points": len(o), "size_mm": [round(w, 1), round(h, 1)], "tolerance_mm": round(tol, 2)}
    elif a.cmd == "meet":
        p = points(a.points, 4)
        result = {"point": meet(*p)}
    elif a.cmd == "unknown":
        if a.text not in spec["unknowns"]:
            spec["unknowns"].append(a.text)
        result = spec["unknowns"]
    elif a.cmd == "show":
        result = spec
    elif a.cmd == "loop":
        result = for_loop(spec)
    elif a.cmd == "coupon":
        parts = coupon(a.pin)
        write_obj(a.out, parts)
        result = {"file": str(Path(a.out).resolve()), "parts": ["holes", "pin"],
                  "holes_mm_per_side": list(COUPON_CLEARANCES),
                  "next": "Print it flat as it lies. The hole by the tab is 0.00 mm per side, then each is looser. Push "
                          "the pin into each: note the first that presses in hard (press), holds without play (snug), "
                          "slides (slide) and turns loosely (free), then printer_profile with those clearances."}
    if a.cmd in ("scale", "rectify", "dim", "give", "listed", "listing", "outline", "unknown"):
        save(a.job, spec)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except KitError as e:
        print(f"print_kit: {e}", file=sys.stderr)
        sys.exit(2)
