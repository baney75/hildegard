#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Measure a figure against the classical canons and print a pass/fail table.

  python3 canon_check.py landmarks.json [--tol 0.12]

landmarks.json holds pixel coordinates [x, y] of the landmarks you placed or can read off your own render.
Include whichever you have; each rule runs only when its points exist:
{
  "crown": [x, y], "hairline": [..], "brow": [..], "nose_base": [..], "chin": [..],
  "eye_l_outer": [..], "eye_l_inner": [..], "eye_r_inner": [..], "eye_r_outer": [..],
  "mouth_l": [..], "mouth_r": [..], "pupil_l": [..], "pupil_r": [..],
  "shoulder": [..], "elbow": [..], "wrist": [..], "fingertip": [..], "knuckle": [..],
  "waist": [..], "pit_of_neck": [..], "support_ankle": [..], "feet": [..],
  "wrist_width": w, "wrist_depth": d, "forearm_depth_px": z
}
For limbs foreshortened toward the viewer, give forearm_depth_px (the length hidden in depth) so the true
length is sqrt(screen^2 + depth^2). Leonardo used exactly this: the missing length becomes depth.

The rules, with sources:
  face thirds equal: hairline-brow = brow-nose base = nose base-chin   (Leonardo; Loomis)
  head height = chin to crown; standing height 7.5-8 heads           (Richer; Loomis)
  space between the eyes = one eye width                           (Leonardo)
  mouth corners under the pupils                                    (Loomis)
  forearm (elbow-wrist) ~ 1.5 hand lengths (wrist-fingertip x 1.5)  (Leonardo)
  elbow at the waist when the arm hangs                             (academic canon)
  wrist twice as wide as it is thick                                 (Bridgman)
  plumb line from the pit of the neck lands on the supporting ankle  (balance)
"""
import argparse, json, math

def d(a, b): return math.hypot(a[0] - b[0], a[1] - b[1])

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("landmarks"); ap.add_argument("--tol", type=float, default=0.12)
    a = ap.parse_args(); L = json.load(open(a.landmarks)); tol = a.tol
    rows = []
    def rule(name, measured, target, src, fmt="{:.2f}"):
        ok = abs(measured - target) <= tol * max(abs(target), 1e-6)
        rows.append((name, fmt.format(measured), fmt.format(target), "PASS" if ok else "FAIL", src))
    has = lambda *k: all(x in L for x in k)
    if has("hairline", "brow", "nose_base", "chin"):
        t1, t2, t3 = d(L["hairline"], L["brow"]), d(L["brow"], L["nose_base"]), d(L["nose_base"], L["chin"])
        m = (t1 + t2 + t3) / 3
        for nm, v in (("forehead third", t1), ("nose third", t2), ("lower third", t3)):
            rule(f"face: {nm} / mean third", v / m, 1.0, "Leonardo, Loomis")
        rows.append(("  (thirds in px)", f"{t1:.0f} / {t2:.0f} / {t3:.0f}", "equal", "", ""))
    if has("eye_l_outer", "eye_l_inner", "eye_r_inner", "eye_r_outer"):
        eye = (d(L["eye_l_outer"], L["eye_l_inner"]) + d(L["eye_r_inner"], L["eye_r_outer"])) / 2
        rule("gap between eyes / eye width", d(L["eye_l_inner"], L["eye_r_inner"]) / eye, 1.0, "Leonardo")
    if has("mouth_l", "mouth_r", "pupil_l", "pupil_r"):
        pw = abs(L["pupil_r"][0] - L["pupil_l"][0]); mw = abs(L["mouth_r"][0] - L["mouth_l"][0])
        rule("mouth width / pupil spacing", mw / pw, 1.0, "Loomis (corners under pupils)")
    if has("crown", "chin", "feet"):
        head = d(L["crown"], L["chin"]); rule("standing height in heads", d(L["crown"], L["feet"]) / head, 7.5, "Richer 7.5 (Loomis heroic 8)")
    if has("elbow", "wrist", "fingertip"):
        fa = math.hypot(d(L["elbow"], L["wrist"]), L.get("forearm_depth_px", 0)); hand = d(L["wrist"], L["fingertip"])
        rule("forearm / hand length", fa / hand, 1.5, "Leonardo")
    if has("elbow", "waist"):
        head = d(L["crown"], L["chin"]) if has("crown", "chin") else None
        dy = abs(L["elbow"][1] - L["waist"][1]); tgt = 0.0
        ok = dy <= (0.25 * head if head else 30)
        rows.append(("elbow height vs waist (px)", f"{dy:.0f}", "~0", "PASS" if ok else "FAIL", "academic canon (hanging arm)"))
    if "wrist_width" in L and "wrist_depth" in L:
        rule("wrist width / depth", L["wrist_width"] / L["wrist_depth"], 2.0, "Bridgman")
    if has("pit_of_neck", "support_ankle"):
        head = d(L["crown"], L["chin"]) if has("crown", "chin") else 100
        dx = abs(L["pit_of_neck"][0] - L["support_ankle"][0])
        rows.append(("plumb line offset (heads)", f"{dx / head:.2f}", "<0.25", "PASS" if dx / head < 0.25 else "FAIL", "balance"))
    if not rows:
        print("no rules ran: add landmarks (see the docstring)"); return
    w = [max(len(str(r[i])) for r in rows + [("rule", "measured", "target", "", "source")]) for i in range(5)]
    hdr = ("rule", "measured", "target", "", "source")
    for r in [hdr] + rows:
        print("  ".join(str(c).ljust(w[i]) for i, c in enumerate(r)))
    fails = sum(1 for r in rows if r[3] == "FAIL")
    print(f"\n{fails} rule(s) failed at ±{int(tol * 100)}%. Fix the structure, then re-measure; record the table in decisions.md.")

if __name__ == "__main__":
    main()
