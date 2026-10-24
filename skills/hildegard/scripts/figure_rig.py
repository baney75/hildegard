#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Proportioned, posable human mannequin for figures built in code.

  python3 figure_rig.py out.png [--pose pose.json] [--heads 7.5] [--build male|female] [--age adult|teen|child|toddler]
                        [--view front|side|three_quarter] [--json joints.json] [--size 900]

Measurements are in HEAD UNITS (chin to crown = 1) from the classical canon (Dürer, Richer, Loomis):
landmarks fall on whole heads (chin 1, nipples 2, navel ~3, crotch ~4 at an 8-head canon). Ages change the
head count, which is what makes a figure read as a child or an adult (pitfall 23).

The pose is local Euler angles in degrees per joint, e.g.
  {"spine": [0, 0, 8], "chest": [0, 10, -6], "neck": [15, 0, 0], "head": [20, 0, 0],
   "l_shoulder": [0, 0, -70], "l_elbow": [-60, 0, 0], "r_hip": [-25, 0, 0], "r_knee": [40, 0, 0]}
l_ = the figure's own left (viewer's right in a front view). Axes: x pitches forward/back, y turns left/right, z tilts sideways. Contrapposto = pelvis z one way, chest z the other.

Writes a shaded volume mannequin (capsules, rib-cage and pelvis masses, head egg) drawn back to front, the
centre-of-gravity plumb line, and a JSON of 2D joint positions in output pixels to hang painting or rigs on.
"""
import argparse, json, math
import numpy as np
from PIL import Image, ImageDraw

AGES = {"adult": 7.5, "teen": 7.0, "child": 6.0, "toddler": 4.5}

def rot(ax, ay, az):
    ax, ay, az = map(math.radians, (ax, ay, az))
    X = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    Y = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    Z = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    return Z @ Y @ X

def skeleton(heads, build):
    # canon at 7.5 heads (feet at 0, crown 7.5, chin 6.5, shoulders ~6.1, nipples ~5.4, navel ~4.5, crotch ~3.75);
    # every body length scales with k so a 6-head child is a child, not a shrunken adult; the head stays 1.
    k = (heads - 1.0) / 6.5
    fem = build == "female"
    sh = (0.98 if not fem else 0.84) * k   # half shoulder width
    hip = (0.70 if not fem else 0.80) * k  # half hip width (female widest at the trochanters)
    r = lambda v: v * k
    J = {
        "pelvis": (None, [0, 3.9 * k, 0], 0, 0),
        "spine": ("pelvis", [0, 0.75 * k, 0], r(0.50), r(0.46)),
        "chest": ("spine", [0, 0.95 * k, 0], r(0.46), r(0.50)),
        "neck": ("chest", [0, 0.85 * k, 0.02], r(0.21), r(0.19)),
        "head": ("neck", [0, 0.25 + 0.5 * k, 0.04], 0, 0),
        "l_clav": ("chest", [0, 0.70 * k, 0.05], r(0.12), r(0.12)), "r_clav": ("chest", [0, 0.70 * k, 0.05], r(0.12), r(0.12)),
        "l_shoulder": ("l_clav", [sh, -0.05 * k, -0.05], r(0.22), r(0.18)), "r_shoulder": ("r_clav", [-sh, -0.05 * k, -0.05], r(0.22), r(0.18)),
        "l_elbow": ("l_shoulder", [0, -1.45 * k, 0], r(0.17), r(0.12)), "r_elbow": ("r_shoulder", [0, -1.45 * k, 0], r(0.17), r(0.12)),
        "l_wrist": ("l_elbow", [0, -1.15 * k, 0], r(0.11), r(0.09)), "r_wrist": ("r_elbow", [0, -1.15 * k, 0], r(0.11), r(0.09)),
        "l_hand": ("l_wrist", [0, -0.75 * k, 0], 0, 0), "r_hand": ("r_wrist", [0, -0.75 * k, 0], 0, 0),
        "l_hip": ("pelvis", [hip * 0.62, -0.05 * k, 0], r(0.32), r(0.30)), "r_hip": ("pelvis", [-hip * 0.62, -0.05 * k, 0], r(0.32), r(0.30)),
        "l_knee": ("l_hip", [0, -1.95 * k, 0], r(0.30), r(0.20)), "r_knee": ("r_hip", [0, -1.95 * k, 0], r(0.30), r(0.20)),
        "l_ankle": ("l_knee", [0, -1.85 * k, 0], r(0.21), r(0.11)), "r_ankle": ("r_knee", [0, -1.85 * k, 0], r(0.21), r(0.11)),
        "l_toe": ("l_ankle", [0, -0.08 * k, 0.85 * k], r(0.11), r(0.07)), "r_toe": ("r_ankle", [0, -0.08 * k, 0.85 * k], r(0.11), r(0.07)),
    }
    J["_k"] = k
    return J

def solve(J, pose):
    world, R = {}, {}
    for name, (parent, off, *_ ) in ((n, v) for n, v in J.items() if n != "_k"):
        local = rot(*pose.get(name, [0, 0, 0]))
        if parent is None:
            R[name] = local; world[name] = np.array(off, float)
        else:
            R[name] = R[parent] @ local
            world[name] = world[parent] + R[parent] @ np.array(off, float)
    return world

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("--pose"); ap.add_argument("--heads", type=float)
    ap.add_argument("--build", default="male"); ap.add_argument("--age", default="adult")
    ap.add_argument("--view", default="three_quarter"); ap.add_argument("--json"); ap.add_argument("--size", type=int, default=900)
    a = ap.parse_args()
    heads = a.heads or AGES[a.age]
    pose = json.load(open(a.pose)) if a.pose else {}
    J = skeleton(heads, a.build); P = solve({n: v for n, v in J.items() if n != '_k'}, pose)
    yaw = {"front": 0, "side": 90, "three_quarter": 35}[a.view]
    V = rot(0, yaw, 0)
    pts = {k: V @ v for k, v in P.items()}
    S = a.size; scale = S * 0.86 / (heads + 0.3); ox = S / 2; oy = S * 0.93
    to2 = lambda v: (ox + v[0] * scale, oy - v[1] * scale)
    img = Image.new("RGB", (S, S), (236, 232, 224)); d = ImageDraw.Draw(img)
    for k in range(int(heads) + 1):                                  # head-unit ruler
        y = oy - k * scale; d.line([(8, y), (40, y)], fill=(150, 140, 130), width=2); d.text((44, y - 7), str(k), fill=(120, 110, 100))
    segs = []
    k = J.pop("_k")
    for name, (parent, off, r0, r1) in J.items():
        if parent and r0 > 0:
            segs.append(((pts[parent][2] + pts[name][2]) / 2, pts[parent], pts[name], r0, r1, name))
    # masses: rib cage, pelvis, head (Loomis ball + jaw)
    masses = [(pts["chest"], (0.62 if a.build == "male" else 0.55) * k, 0.78 * k, "ribcage"), (pts["pelvis"], (0.70 if a.build == "male" else 0.80) * k, 0.52 * k, "pelvis")]
    hc = pts["head"]
    items = [(z, "seg", s) for z, *s in segs] + [(m[0][2], "mass", m) for m in masses] + [(hc[2], "head", hc)]
    for z, kind, it in sorted(items, key=lambda t: t[0]):
        shade = int(150 + 70 * max(-1, min(1, z / 2)))
        col = (shade, int(shade * 0.82), int(shade * 0.70))
        if kind == "seg":
            p0, p1, r0, r1, nm = it
            (x0, y0), (x1, y1) = to2(p0), to2(p1); n = 12
            for i in range(n + 1):
                t = i / n; r = (r0 + (r1 - r0) * t) * scale
                cx, cy = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
        elif kind == "mass":
            c, rx, ry, nm = it; x, y = to2(c); y -= (0.10 * scale * k if nm == "ribcage" else 0)
            d.ellipse([x - rx * scale, y - ry * scale, x + rx * scale, y + ry * scale], fill=col, outline=(90, 70, 60))
        else:
            x, y = to2(it)          # Loomis: cranial ball, then the jaw down to the chin (head = 1 unit tall)
            d.ellipse([x - 0.38 * scale, y - 0.50 * scale, x + 0.38 * scale, y + 0.30 * scale], fill=col, outline=(90, 70, 60))
            d.polygon([(x - 0.33 * scale, y), (x + 0.33 * scale, y), (x + 0.15 * scale, y + 0.50 * scale), (x - 0.15 * scale, y + 0.50 * scale)], fill=col)
    # centre of gravity ~ just in front of the sacrum; plumb from pit of neck should land on the support foot
    neckpit = to2(pts["neck"]); d.line([neckpit, (neckpit[0], oy)], fill=(200, 60, 40), width=2)
    for nm in ("l_ankle", "r_ankle"):
        x, y = to2(pts[nm]); d.ellipse([x - 5, y - 5, x + 5, y + 5], outline=(200, 60, 40), width=2)
    img.save(a.out)
    out = {k: [round(v, 1) for v in to2(p)] for k, p in pts.items()}
    out["_meta"] = {"heads": heads, "build": a.build, "age": a.age, "view": a.view, "pixels_per_head": round(scale, 2)}
    if a.json:
        json.dump(out, open(a.json, "w"), indent=1)
    print(f"wrote {a.out} ({heads} heads, {a.build}, {a.view}); red line = plumb from pit of neck, circles = ankles")

if __name__ == "__main__":
    main()
