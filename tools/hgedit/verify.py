# SPDX-License-Identifier: AGPL-3.0-only
"""The output gate: does the finished file prove the edit list?

Every check reads the output file, never the renderer's own account of what it did. The edit list is resolved again here
(the same function the renderer used), so the frame count and the times to compare against come from the edit list alone.

  frames     the output has exactly the frames the edit list resolves to, one every 1/fps
  shape      size and frame rate are what the edit list asked for
  sync       each audio track is as long as the picture, to within a frame or two
  tracks     the audio tracks promised are there
  loudness   integrated loudness and true peak are on the target (EBU R128 through ffmpeg's ebur128, as PyAV carries it)
  black      no black stretch longer than allowed
  frozen     no frozen stretch longer than allowed
  overlays   every title and caption lies inside the frame
  ocr        with tesseract: OCR of the output at 4 frames a second, in and around every hidden stretch, finds none of the
             declared secrets and none of the built-in kinds (API keys, e-mail addresses, IPs, host names)

Status per check is pass, fail, warn or skip. The gate passes unless a check fails. A skipped OCR check is reported as
unproven: without tesseract nothing proves hidden text is unreadable.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import difflib
from concurrent.futures import ThreadPoolExecutor

import av
import numpy as np
from PIL import Image

from . import edl as edl_mod, media, plan as plan_mod
from .media import RATE

try:
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import voice_clean
except ImportError:  # pragma: no cover
    voice_clean = None


def check(id_, status, detail, **extra):
    return dict(id=id_, status=status, detail=detail, **extra)


def _runs(flags, fps):
    """Longest run of True in flags, as (seconds, start_second)."""
    best, best_at, cur, at = 0, 0.0, 0, 0
    for i, f in enumerate(flags):
        if f:
            if cur == 0:
                at = i
            cur += 1
            if cur > best:
                best, best_at = cur, at
        else:
            cur = 0
    return best / fps, best_at / fps


# ── One pass over the picture ───────────────────────────────────────────────────────────────────────────────────


def scan_picture(path):
    """(frames, pts_ok, black[], still[]) from every frame of the output, on a 64x36 grey copy."""
    n = 0
    prev = None
    black, still = [], []
    pts = []
    with av.open(path) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        for f in c.decode(v):
            n += 1
            if f.pts is not None:
                pts.append(float(f.pts * f.time_base))
            g = f.to_ndarray(width=64, height=36, format="gray").astype(np.float32)
            black.append(bool(g.mean() < 15 and g.std() < 6))
            still.append(prev is not None and bool(np.abs(g - prev).mean() < 0.15))
            prev = g
    return n, pts, black, still


def audio_tracks(path):
    """[(seconds, stereo float32 at 48 kHz)] for every audio stream."""
    out = []
    with av.open(path) as c:
        count = len(c.streams.audio)
    for i in range(count):
        x = media.read_audio(path, None, i, 2)
        out.append((x.shape[1] / RATE, x))
    return out


# ── Looking for secrets ─────────────────────────────────────────────────────────────────────────────────────────

# OCR confuses these; both sides are folded the same way before comparing.
FOLD = str.maketrans({"0": "o", "1": "l", "i": "l", "|": "l", "5": "s", "$": "s", "8": "b", "2": "z", "_": "-"})
KINDS = {
    "api_key": [
        r"\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}",
        r"\bAKIA[0-9A-Z]{16}\b",
        r"\bgh[pousr]_[A-Za-z0-9]{30,}",
        r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
        r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}",
        r"(?i)\b(?:api|secret|access)[_-]?(?:key|token)\s*[=:]\s*\S{8,}",
        r"\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}\b",
    ],
    "email": [r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"],
    "ip": [r"\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b"],
    "hostname": [r"(?i)\b(?:[a-z0-9][a-z0-9-]*\.)+(?:internal|local|lan|corp|intranet|home|cloud|com|net|org|io|dev|co)\b"],
}
ALL_KINDS = list(KINDS)


def mask(s):
    s = s.strip()
    return s[:4] + "…" + f"({len(s)} characters)" if len(s) > 8 else "…"


def ocr_text(png, psm=11):
    # One thread each: several run side by side, and tesseract's own threads only fight over the cores.
    env = dict(os.environ, OMP_THREAD_LIMIT="1")
    r = subprocess.run(["tesseract", png, "stdout", "--psm", str(psm), "-l", "eng"], capture_output=True, text=True, timeout=60, env=env)
    return r.stdout if r.returncode == 0 else ""


def fuzzy_has(text, secret):
    """Whether `secret` is readable in OCR `text`: exact, or close enough once look-alike characters are folded."""
    flat = re.sub(r"\s+", "", text)
    if secret in text or secret in flat:
        return True
    if len(secret) < 8:
        return False
    s = secret.lower().translate(FOLD)
    best = 0.0
    for chunk in [flat] + [re.sub(r"\s+", "", ln) for ln in text.splitlines() if len(ln) >= 6]:
        t = chunk.lower().translate(FOLD)
        n = len(s)
        for a in range(0, max(1, len(t) - n + 3), 1):
            r = difflib.SequenceMatcher(None, s, t[a : a + n + 2], autojunk=False).quick_ratio()
            if r >= 0.8 and difflib.SequenceMatcher(None, s, t[a : a + n + 2], autojunk=False).ratio() >= 0.78:
                return True
            best = max(best, r)
    return False


def find_leaks(full_text, crop_text, secrets, kinds):
    """[(label, masked text)] for what OCR read: declared secrets anywhere on the frame, kinds in the hidden region's crop."""
    hits = []
    both = full_text + "\n" + crop_text
    for sec in secrets:
        if isinstance(sec, str):
            if fuzzy_has(both, sec):
                hits.append(("declared secret", mask(sec)))
        elif "text" in sec:
            if fuzzy_has(both, sec["text"]):
                hits.append(("declared secret", mask(sec["text"])))
        elif "regex" in sec:
            m = re.search(sec["regex"], both) or re.search(sec["regex"], re.sub(r"\s+", "", both))
            if m:
                hits.append(("declared pattern", mask(m.group(0))))
    if crop_text.strip():
        flat = re.sub(r"[ \t]+", "", crop_text)
        for kind in kinds:
            for rx in KINDS[kind]:
                m = re.search(rx, crop_text) or re.search(rx, flat)
                if m:
                    hits.append((kind, mask(m.group(0))))
                    break
    return hits


def secret_kinds(plan):
    v = plan["verify"]
    kinds = list(v.get("ocr_kinds", ALL_KINDS))
    for sec in plan["secrets"]:
        if isinstance(sec, dict) and "kind" in sec and sec["kind"] not in kinds:
            kinds.append(sec["kind"])
    return kinds


def ocr_check(out_path, plan):
    v = plan["verify"]
    wants = bool(plan["blur"] or plan["secrets"])
    if not wants:
        return check("ocr", "skip", "Nothing was hidden and no secrets were declared, so there is nothing to look for.")
    if not shutil.which("tesseract"):
        status = "fail" if v.get("require_ocr") else "skip"
        return check("ocr", status, "tesseract isn’t installed, so nothing proves the hidden text is unreadable in the output (unproven). "
                     "Install it (apt install tesseract-ocr, brew install tesseract, or the UB Mannheim build on Windows) and verify again.", unproven=True)
    fps = float(v.get("ocr_fps", 4))
    total = plan["out_seconds"]
    windows = []
    for b in plan["blur"]:
        for a, z in b["out"]:
            windows.append((max(0.0, a - 1.0), min(total, z + 1.0)))
    scan_all = v.get("ocr_scan") == "all" or not plan["blur"]
    if scan_all:
        windows = [(0.0, total)]
    windows.sort()
    merged = []
    for a, b in windows:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else:
            merged.append((a, b))
    cap = 900
    step = 1.0 / fps
    if sum(b - a for a, b in merged) / step > cap:
        step = sum(b - a for a, b in merged) / cap
    frames = []
    for a, b in merged:
        for t, rgb in media.video_frames(out_path, step=step, start=a, end=b):
            frames.append((t, rgb))
    if not frames:
        return check("ocr", "warn", "No frames fell in the hidden stretches to read.")
    secrets = plan["secrets"]
    kinds = secret_kinds(plan) if plan["blur"] else [k for k in ALL_KINDS if any(isinstance(s, dict) and s.get("kind") == k for s in secrets)]
    d = tempfile.mkdtemp(prefix="hg-ocr-")

    def read(item):
        i, (t, rgb) = item
        h, w = rgb.shape[:2]
        im = Image.fromarray(rgb)
        scale = 2 if w < 1400 else 1
        big = im.resize((w * scale, h * scale), Image.LANCZOS) if scale > 1 else im
        p = os.path.join(d, f"f{i}.png")
        big.save(p)
        full = ocr_text(p, 11)
        crop_txt = ""
        regions = [bx for b in plan["blur"] for a, z in b["out"] if a - 0.05 <= t <= z + 0.05 for bx in [_region_at(plan, b, t, a)] if bx]
        for j, (x0, y0, x1, y1) in enumerate(regions):
            padx, pady = int((x1 - x0) * 0.1) + 8, int((y1 - y0) * 0.5) + 8
            box = (max(0, x0 - padx), max(0, y0 - pady), min(w, x1 + padx), min(h, y1 + pady))
            cr = im.crop(box)
            cr = cr.resize((cr.width * 3, cr.height * 3), Image.LANCZOS)
            cp = os.path.join(d, f"c{i}-{j}.png")
            cr.save(cp)
            crop_txt += "\n" + ocr_text(cp, 6)
        return t, find_leaks(full, crop_txt, secrets, kinds)

    try:
        with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 1)) as ex:
            results = list(ex.map(read, enumerate(frames)))
    finally:
        shutil.rmtree(d, ignore_errors=True)
    leaks = [(t, label, text) for t, hits in results for label, text in hits]
    span = f"{len(frames)} frames at about {1 / step:.1f} a second, {', '.join(f'{a:.1f} to {b:.1f} s' for a, b in merged[:4])}{'…' if len(merged) > 4 else ''}"
    if leaks:
        first = {}
        for t, label, text in leaks:
            first.setdefault((label, text), []).append(t)
        shown = "; ".join(f"{label} {text} readable at {', '.join(f'{x:.1f}' for x in ts[:3])} s" for (label, text), ts in list(first.items())[:4])
        return check("ocr", "fail", f"OCR of the finished video found what should be hidden. {shown}. Add or widen a blur (style solid for a secret) over it, render and verify again.",
                     frames=len(frames), leaks=[{"t": round(t, 2), "kind": label} for t, label, _ in leaks[:20]])
    return check("ocr", "pass", f"OCR read {span} and found none of the {len(secrets)} declared secrets or the built-in kinds ({', '.join(kinds) or 'none'}).", frames=len(frames))


def _region_at(plan, b, t_out, win_start):
    """The hidden region in output pixels at output second t_out, for blur entry b."""
    fps = float(plan.fps)
    # Find the source time shown at t_out.
    f = int(t_out * fps)
    for s in plan["segments"]:
        if s["out_frame"] <= f < s["out_frame"] + s["frames"] and s["source"] == b["source"]:
            t_src = (s["src_frame"] + f - s["out_frame"]) / fps
            from .render import _key_box  # noqa: PLC0415

            return plan_mod.to_output(plan, b["source"], t_src, _key_box(b, t_src))
    return None


# ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────


def verify(out_path, edl_path, base_dir=None):
    """Check the file at `out_path` against the edit list at `edl_path`. Returns {ok, checks, unproven, ...}."""
    edl = edl_mod.load(edl_path)
    base = base_dir or os.path.dirname(os.path.abspath(edl_path))
    plan = plan_mod.resolve(edl, base, track=False)
    # Where the renderer put the crop is the one thing resolve() can't know without searching the footage again; read it from
    # the record the renderer left beside the file, only when that record is for this same shape.
    side = out_path + ".plan.json"
    if plan["reframe"]["mode"] and os.path.isfile(side):
        try:
            with open(side, encoding="utf-8") as f:
                was = json.load(f)
            if was.get("output") == plan["output"] and was.get("out_frames") == plan["out_frames"]:
                plan["reframe"]["tracks"] = was["reframe"]["tracks"]
        except (OSError, ValueError, KeyError):
            pass
    v = plan["verify"]
    checks = []
    fps = float(plan.fps)
    if not os.path.isfile(out_path):
        return {"ok": False, "checks": [check("frames", "fail", f"There is no output file at {out_path}.")], "unproven": []}
    try:
        info = media.probe(out_path)
    except media.MediaError as e:
        return {"ok": False, "checks": [check("frames", "fail", str(e))], "unproven": []}

    n, pts, black, still = scan_picture(out_path)
    want = plan["out_frames"]
    gaps = None
    if len(pts) > 1:
        d = np.diff(np.array(pts))
        gaps = float(np.abs(d - 1 / fps).max())
    ok_frames = n == want and (gaps is None or gaps < 0.5 / fps)
    checks.append(check("frames", "pass" if ok_frames else "fail",
                        f"{n} frames, the edit list resolves to {want}" + ("" if ok_frames else (f"; spacing off by {gaps * 1000:.0f} ms" if n == want else "")),
                        got=n, want=want))
    o = plan["output"]
    size_ok = (info["width"], info["height"]) == (o["width"], o["height"]) and abs((info["fps"] or 0) - fps) < 0.02
    checks.append(check("shape", "pass" if size_ok else "fail",
                        f"{info['width']}x{info['height']} at {info['fps']:.3f} fps; wanted {o['width']}x{o['height']} at {fps:.3f}"))

    vsec = n / fps
    tracks = audio_tracks(out_path)
    silent = plan["audio"]["mute"]
    want_tracks = 1 if (plan["audio"]["mute"] or not plan["audio"]["keep_original"]) else 2
    checks.append(check("tracks", "pass" if len(tracks) == want_tracks else "fail",
                        f"{len(tracks)} audio track{'s' if len(tracks) != 1 else ''}; the edit list asks for {want_tracks}"))
    tol = max(0.06, 2 / fps)
    off = [(i, s) for i, (s, _) in enumerate(tracks) if abs(s - vsec) > tol]
    if tracks:
        checks.append(check("sync", "fail" if off else "pass",
                            "; ".join(f"track {i} is {s:.3f} s, the picture {vsec:.3f} s" for i, s in off) if off
                            else f"audio {', '.join(f'{s:.3f}' for s, _ in tracks)} s against picture {vsec:.3f} s (within {tol * 1000:.0f} ms)"))
    else:
        checks.append(check("sync", "skip", "There is no sound."))

    t = plan["target"]
    if tracks and not silent and plan["audio"]["master"] and voice_clean is not None:
        try:
            be = voice_clean.choose_backend()
            lufs, tp = voice_clean.measure(be, tracks[0][1])
            tl = v.get("lufs_tolerance", 1.0)
            good = abs(lufs - t["lufs"]) <= tl and tp <= t["peak"] + 0.1
            checks.append(check("loudness", "pass" if good else "fail",
                                f"{lufs:.1f} LUFS and {tp:.1f} dBTP; target {t['lufs']:g} ±{tl:g} LUFS, peak at most {t['peak']:g} dBTP",
                                lufs=lufs, true_peak=tp))
        except voice_clean.CleanError as e:
            checks.append(check("loudness", "warn", f"Couldn’t measure the loudness: {e}"))
    else:
        checks.append(check("loudness", "skip", "No mastered sound to measure."))

    allowed = [tuple(x) for x in v.get("allow_black", [])]
    flags = [b and not any(a <= i / fps <= z for a, z in allowed) for i, b in enumerate(black)]
    mb, at = _runs(flags, fps)
    lim = v.get("max_black", 0.5)
    checks.append(check("black", "fail" if mb > lim else "pass",
                        f"Black for {mb:.2f} s starting at {at:.1f} s (allowed {lim:g} s)" if mb > lim else f"The longest black stretch is {mb:.2f} s (allowed {lim:g} s)"))
    ms, at = _runs(still, fps)
    lim = v.get("max_frozen", 6.0)
    checks.append(check("frozen", "fail" if ms > lim else "pass",
                        f"Nothing changes for {ms:.1f} s starting at {at:.1f} s (allowed {lim:g} s)" if ms > lim else f"The longest still stretch is {ms:.1f} s (allowed {lim:g} s)"))

    outside = []
    near = []
    for kind, a, z, box in plan_mod.overlay_boxes(plan):
        from . import textfx  # noqa: PLC0415

        if not textfx.inside(box, o["width"], o["height"]):
            outside.append(f"{kind} at {a:.1f} s")
        elif not textfx.inside(box, o["width"], o["height"], 0.02):
            near.append(f"{kind} at {a:.1f} s")
    nover = len(plan["cues"]) + len(plan["titles"])
    if outside:
        checks.append(check("overlays", "fail", f"These run outside the frame: {', '.join(outside[:5])}."))
    elif near:
        checks.append(check("overlays", "warn", f"These sit within 2% of the frame edge: {', '.join(near[:5])}."))
    else:
        checks.append(check("overlays", "pass" if nover else "skip", f"All {nover} titles and captions are inside the frame." if nover else "No titles or captions."))

    if t.get("max_seconds") and vsec > t["max_seconds"] + 0.05:
        checks.append(check("length", "warn", f"{vsec:.1f} s is longer than {t['name']} likes ({t['max_seconds']:g} s)."))

    checks.append(ocr_check(out_path, plan))
    unproven = [c["id"] for c in checks if c.get("unproven")]
    return {"ok": not any(c["status"] == "fail" for c in checks), "checks": checks, "unproven": unproven,
            "seconds": round(vsec, 3), "frames": n}
