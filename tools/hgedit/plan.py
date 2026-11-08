# SPDX-License-Identifier: AGPL-3.0-only
"""An edit list, resolved to frames. The renderer draws from this and the gate checks the output against it, so the two
can never disagree about what the edit list meant.

What it does, in order: keep ranges (or every source whole) minus the cuts; long dead pauses shortened by speech energy;
every piece snapped to the output frame grid (so the output's frame count is known before a frame is drawn); abutting
pieces of one source joined; blur, box, title, caption and chapter times moved onto the output's clock; the output's
shape worked out from the target and the reframe.
"""

import json
import os
from fractions import Fraction

from . import edl as edl_mod
from . import media, presets, signals, textfx, transcript as tr
from .edl import EdlError

MIN_FRAMES = 2
PAD_PX = 6  # a hidden region is drawn this much bigger than asked, on every side


def snap_fps(x):
    """A frame rate as an exact fraction; the usual 1.001 rates come out as 24000/1001 and friends."""
    for num, den in ((24000, 1001), (30000, 1001), (60000, 1001), (120000, 1001)):
        if abs(x - num / den) < 0.01:
            return Fraction(num, den)
    return Fraction(round(x * 1000), 1000).limit_denominator(1001)


def _even(n):
    return max(2, int(n) // 2 * 2)


# ── Ranges ──────────────────────────────────────────────────────────────────────────────────────────────────────


def subtract(ranges, cuts):
    """ranges and cuts are [(a, b)] on one clock; the ranges with the cuts taken out."""
    out = []
    for a, b in ranges:
        parts = [(a, b)]
        for ca, cb in sorted(cuts):
            nxt = []
            for pa, pb in parts:
                if cb <= pa or ca >= pb:
                    nxt.append((pa, pb))
                    continue
                if ca > pa:
                    nxt.append((pa, ca))
                if cb < pb:
                    nxt.append((cb, pb))
            parts = nxt
        out.extend(parts)
    return out


class Plan(dict):
    """The resolved edit as a dict (JSON-serializable), with a few helpers."""

    @property
    def fps(self):
        return Fraction(self["fps_num"], self["fps_den"])

    def out_times(self, source, t0, t1):
        """Output-second intervals where source seconds [t0, t1) are on screen (more than one if footage repeats)."""
        out = []
        fps = float(self.fps)
        for s in self["segments"]:
            if s["source"] != source:
                continue
            a = s["src_frame"] / fps
            b = (s["src_frame"] + s["frames"]) / fps
            lo, hi = max(a, t0), min(b, t1)
            if hi > lo:
                o = s["out_frame"] / fps
                out.append((round(o + lo - a, 4), round(o + hi - a, 4)))
        return out


# ── The resolver ────────────────────────────────────────────────────────────────────────────────────────────────


def resolve(edl, base_dir=".", analyze=True, track=True):
    """Resolve a validated-or-not edit list to a Plan. Raises EdlError, listing every problem found.

    `analyze=False` skips the sound analysis that pause shortening needs, and `track=False` the subject search for a
    reframe (quick checks that don't need them)."""
    errs = [(p, m) for p, m in edl_mod.validate(edl)]
    if errs:
        raise EdlError(_summarize(errs), errs)
    errors, warnings = [], []

    # Sources
    srcs = {}
    for sid, s in edl["sources"].items():
        path = s["path"] if os.path.isabs(s["path"]) else os.path.normpath(os.path.join(base_dir, s["path"]))
        try:
            info = media.probe(path)
        except media.MediaError as e:
            errors.append((f"sources.{sid}.path", str(e)))
            continue
        if not info["video"]:
            errors.append((f"sources.{sid}.path", f"{os.path.basename(path)} has no picture. This editor cuts video."))
            continue
        track_n = s.get("audio_track", 0)
        if info["audio"] and track_n >= info["audio_tracks"]:
            errors.append((f"sources.{sid}.audio_track", f"is {track_n}, but the file has {info['audio_tracks']} audio tracks (0 to {info['audio_tracks'] - 1})"))
        srcs[sid] = dict(info, path=path, audio_track=track_n, id=sid)
    if errors:
        raise EdlError(_summarize(errors), errors)
    first = next(iter(srcs.values()))
    fps = snap_fps(edl["fps"]) if edl.get("fps") else snap_fps(first["fps"])
    ffps = float(fps)

    def sid_of(item, where):
        return edl_mod.source_of(edl, item, where, errors)

    # Ranges
    ranges = []  # (source, a, b, label)
    if edl.get("keep"):
        for i, k in enumerate(edl["keep"]):
            sid = sid_of(k, f"keep[{i}]")
            if sid is None:
                continue
            if k["end"] <= k["start"]:
                errors.append((f"keep[{i}].end", f"({k['end']:g}) must be after start ({k['start']:g})"))
                continue
            if k["end"] > srcs[sid]["seconds"] + 0.1:
                errors.append((f"keep[{i}].end", f"({k['end']:g}) is past the end of {sid}, which is {srcs[sid]['seconds']:.2f} s long"))
                continue
            ranges.append((sid, k["start"], min(k["end"], srcs[sid]["seconds"]), k.get("label")))
        seen = {}
        for sid, a, b, _ in ranges:
            for pa, pb in seen.get(sid, []):
                if a < pb - 0.02 and b > pa + 0.02:
                    warnings.append(("keep", f"{sid} {a:g} to {b:g} s repeats footage already used ({pa:g} to {pb:g} s)"))
            seen.setdefault(sid, []).append((a, b))
    else:
        ranges = [(sid, 0.0, s["seconds"], None) for sid, s in srcs.items()]

    cuts_by = {}
    for i, c in enumerate(edl.get("cuts", [])):
        sid = sid_of(c, f"cuts[{i}]")
        if sid is None:
            continue
        if c["end"] <= c["start"]:
            errors.append((f"cuts[{i}].end", f"({c['end']:g}) must be after start ({c['start']:g})"))
            continue
        if c["start"] >= srcs[sid]["seconds"]:
            errors.append((f"cuts[{i}].start", f"({c['start']:g}) is past the end of {sid}, which is {srcs[sid]['seconds']:.2f} s long"))
            continue
        cuts_by.setdefault(sid, []).append((c["start"], c["end"]))
    if errors:
        raise EdlError(_summarize(errors), errors)

    pieces = []  # (source, a, b, label)
    for sid, a, b, label in ranges:
        for pa, pb in subtract([(a, b)], cuts_by.get(sid, [])):
            pieces.append((sid, pa, pb, label))

    # Pauses
    pauses = edl.get("pauses")
    analysis = {}
    cut_pauses = []
    kept_pauses = []
    if pauses is not False and pauses is not None and analyze:
        cfg = dict(max_pause=pauses.get("max", 0.7), keep=pauses.get("keep", 0.3), margin=pauses.get("margin", 0.12),
                   activity_mode=pauses.get("activity", "keep"))
        only = pauses.get("source")
        out = []
        for sid, a, b, label in pieces:
            info = srcs[sid]
            if not info["audio"] or (only and sid != only):
                out.append((sid, a, b, label))
                continue
            if sid not in analysis:
                analysis[sid] = signals.analyze(info["path"], info["audio_track"])
            cuts, kept = signals.dead_pauses(analysis[sid], a, b, **cfg)
            kept_pauses += [(sid, x, y, why) for x, y, why in kept]
            for pa, pb in subtract([(a, b)], cuts):
                out.append((sid, pa, pb, label))
            cut_pauses += [(sid, x, y) for x, y in cuts]
        pieces = out

    # Frame grid
    segments = []
    for sid, a, b, label in pieces:
        f0, f1 = round(a * ffps), round(b * ffps)
        if f1 - f0 < MIN_FRAMES:
            continue
        if segments and segments[-1]["source"] == sid and segments[-1]["src_frame"] + segments[-1]["frames"] == f0:
            segments[-1]["frames"] += f1 - f0
            continue
        segments.append({"source": sid, "src_frame": f0, "frames": f1 - f0, "label": label})
    if not segments:
        errors.append(("keep", "Nothing is left: every stretch is cut. Keep at least one piece of footage."))
        raise EdlError(_summarize(errors), errors)
    n = 0
    for i, s in enumerate(segments):
        s["i"] = i
        s["out_frame"] = n
        n += s["frames"]
    total = n
    seconds = total / ffps

    plan = Plan(
        version=1, title=edl.get("title"), fps_num=fps.numerator, fps_den=fps.denominator, out_frames=total,
        out_seconds=round(seconds, 4), audio_samples=round(total / ffps * media.RATE),
        sources={k: {kk: v[kk] for kk in ("path", "seconds", "fps", "width", "height", "audio", "audio_tracks", "audio_track")} for k, v in srcs.items()},
        segments=segments, joins=[s["out_frame"] for s in segments[1:]], warnings=[], pauses_cut=[(s, round(a, 3), round(b, 3)) for s, a, b in cut_pauses],
        pauses_kept=[(s, round(a, 3), round(b, 3), why) for s, a, b, why in kept_pauses],
    )

    # Shape
    target = presets.resolve_target(edl)
    rf = edl.get("reframe") or {}
    first_seg = srcs[segments[0]["source"]]
    sw, sh = first_seg["width"], first_seg["height"]
    src_aspect = sw / sh
    aspect_text = rf.get("aspect") or target.get("aspect")
    aspect = edl_mod.parse_aspect(aspect_text) if aspect_text else src_aspect
    fit = rf.get("fit", "crop")
    needs_crop = abs(aspect - src_aspect) / src_aspect > 0.01
    if needs_crop and fit == "crop":
        cw, ch = (sh * aspect, sh) if aspect < src_aspect else (sw, sw / aspect)
    else:
        cw, ch = sw, sh
    out_h = target.get("height") or (ch if needs_crop else sh)
    if fit == "pad" and needs_crop:
        out_h = min(out_h, sh if aspect >= src_aspect else sw / aspect)
    else:
        out_h = min(out_h, ch)
    out_h = _even(out_h)
    out_w = _even(round(out_h * aspect))
    plan["output"] = {"width": out_w, "height": out_h, "aspect": round(aspect, 5), "fit": fit if needs_crop else "none",
                      "crop_frac": round(cw / sw, 5) if needs_crop and fit == "crop" else 1.0}
    plan["target"] = {k: target.get(k) for k in ("name", "lufs", "peak", "max_seconds", "keep_original", "bitrate_kbps")}
    if target.get("max_seconds") and seconds > target["max_seconds"] + 0.05:
        warnings.append(("target", f"{target['name']} videos are best under {target['max_seconds']:g} s; this one is {seconds:.1f} s"))

    # Where the subject is
    plan["reframe"] = {"mode": None, "found": None, "tracks": {}}
    if needs_crop and fit == "crop":
        mode = rf.get("mode", "auto")
        plan["reframe"]["mode"] = mode
        used = {s["source"] for s in segments}
        for sid in used:
            if not track or mode in ("center", "fixed"):
                x = rf.get("x", 0.5) if mode == "fixed" else 0.5
                plan["reframe"]["tracks"][sid] = [[0.0, x], [srcs[sid]["seconds"], x]]
                plan["reframe"]["found"] = mode
                continue
            lo = min(s["src_frame"] for s in segments if s["source"] == sid) / ffps
            hi = max((s["src_frame"] + s["frames"]) for s in segments if s["source"] == sid) / ffps
            pts, how = signals.subject_track(srcs[sid]["path"], lo, hi, mode, rf.get("x", 0.5))
            plan["reframe"]["found"] = how
            plan["reframe"]["tracks"][sid] = [[round(t, 3), round(x, 4)] for t, x in signals.smooth_track(pts, plan["output"]["crop_frac"], rf.get("smooth", 0.8))]

    # Blur and boxes, in source pixels, with the output times they show at
    def pixel_box(item, where):
        s = srcs.get(item["sid"])
        w, h = s["width"], s["height"]
        if "box_px" in item:
            x, y, bw, bh = item["box_px"]
        else:
            x, y, bw, bh = (item["box"][0] * w, item["box"][1] * h, item["box"][2] * w, item["box"][3] * h)
        pad = PAD_PX if where == "blur" else 0
        x0, y0 = max(0, int(x) - pad), max(0, int(y) - pad)
        x1, y1 = min(w, int(round(x + bw)) + pad), min(h, int(round(y + bh)) + pad)
        return [x0, y0, x1, y1]

    plan["blur"], plan["boxes"] = [], []
    for kind in ("blur", "boxes"):
        for i, b in enumerate(edl.get(kind, [])):
            where = f"{kind}[{i}]"
            sid = sid_of(b, where)
            if sid is None:
                continue
            if b["end"] <= b["start"]:
                errors.append((f"{where}.end", f"({b['end']:g}) must be after start ({b['start']:g})"))
                continue
            item = dict(b, sid=sid)
            if kind == "blur" and not any(k in b for k in ("box", "box_px", "keys")):
                errors.append((where, "needs a box (or box_px, or keys for a region that moves)"))
                continue
            if kind == "blur" and sum(k in b for k in ("box", "box_px", "keys")) > 1:
                errors.append((where, "give one of box, box_px or keys"))
                continue
            entry = {"source": sid, "start": b["start"], "end": b["end"], "label": b.get("label")}
            if kind == "blur":
                entry["style"] = b.get("style", "blur")
                if "keys" in b:
                    entry["keys"] = [[k["t"], pixel_box(dict(item, box=k["box"]), "blur")] for k in sorted(b["keys"], key=lambda k: k["t"])]
                else:
                    entry["box"] = pixel_box(item, "blur")
            else:
                entry.update(box=pixel_box(item, "boxes"), color=b.get("color", "#ffcc00"), width=b.get("width", 4), fill=b.get("fill", 0.0))
            entry["out"] = plan.out_times(sid, b["start"], b["end"])
            if not entry["out"]:
                warnings.append((where, f"{b['start']:g} to {b['end']:g} s of {sid} is cut, so this never shows"))
            plan[kind].append(entry)

    # Titles and chapters, already in output time
    plan["titles"] = []
    for i, t in enumerate(edl.get("titles", [])):
        if t["end"] <= t["start"]:
            errors.append((f"titles[{i}].end", f"({t['end']:g}) must be after start ({t['start']:g})"))
            continue
        if t["start"] >= seconds:
            errors.append((f"titles[{i}].start", f"({t['start']:g}) is after the video ends at {seconds:.2f} s"))
            continue
        plan["titles"].append({"text": t["text"], "subtitle": t.get("subtitle"), "start": t["start"], "end": min(t["end"], seconds), "kind": t.get("kind", "lower_third")})
    plan["chapters"] = []
    for i, c in enumerate(sorted(edl.get("chapters", []), key=lambda c: c["at"])):
        if c["at"] >= seconds:
            errors.append((f"chapters[{i}].at", f"({c['at']:g}) is after the video ends at {seconds:.2f} s"))
            continue
        plan["chapters"].append({"at": round(c["at"], 2), "title": c["title"]})
    if plan["chapters"]:
        if plan["chapters"][0]["at"] > 0.5:
            warnings.append(("chapters", "YouTube wants the first chapter at 0:00"))
        if len(plan["chapters"]) < 3:
            warnings.append(("chapters", "YouTube shows chapters only with at least three"))
        for a, b in zip(plan["chapters"], plan["chapters"][1:]):
            if b["at"] - a["at"] < 10:
                warnings.append(("chapters", f"“{a['title']}” is under 10 s long; YouTube ignores chapters that short"))
                break

    # Captions, from the transcript, onto the output clock
    plan["cues"] = []
    cap = edl.get("captions")
    if cap and not cap.get("off") and cap.get("transcript") is not None:
        sid = cap.get("source") or edl_mod.default_source(edl) or next(iter(srcs))
        if sid not in srcs:
            errors.append(("captions.source", f"“{sid}” isn’t one of the sources"))
        else:
            try:
                t = cap["transcript"]
                if isinstance(t, str):
                    p = t if os.path.isabs(t) else os.path.join(base_dir, t)
                    with open(p, encoding="utf-8") as f:
                        t = json.load(f)
                words = tr.words_of(t)
            except (OSError, ValueError, tr.TranscriptError) as e:
                errors.append(("captions.transcript", str(e) if isinstance(e, tr.TranscriptError) else "can’t be read as a transcript with word times"))
                words = []
            out_words = retime_words(words, [s for s in segments if s["source"] == sid], ffps)
            vertical = plan["output"]["height"] > plan["output"]["width"]
            plan["cues"] = tr.make_cues(out_words, cap.get("max_chars", 24 if vertical else 38), cap.get("max_lines", 2),
                                        cap.get("min_seconds", 1.0), cap.get("max_seconds", 6.0))
            plan["caption_style"] = {"position": cap.get("position", "bottom"), "size": cap.get("size")}

    # Sound
    music = edl.get("music")
    if music:
        mp = music["path"] if os.path.isabs(music["path"]) else os.path.normpath(os.path.join(base_dir, music["path"]))
        if not os.path.isfile(mp):
            errors.append(("music.path", f"There is no file at {mp}."))
        else:
            plan["music"] = dict(music, path=mp)
    aud = edl.get("audio", {})
    plan["audio"] = {"clean": aud.get("clean", "auto"), "master": aud.get("master", True), "fade_ms": aud.get("fade_ms", 10),
                     "keep_original": aud.get("keep_original", target["keep_original"]), "mute": aud.get("mute", False)}
    if not any(s["audio"] for s in srcs.values()) and not music:
        plan["audio"]["mute"] = True

    # What the gate looks for
    plan["secrets"] = edl.get("secrets", [])
    plan["verify"] = edl.get("verify", {})
    for i, sec in enumerate(plan["secrets"]):
        if isinstance(sec, dict):
            if sum(k in sec for k in ("text", "regex", "kind")) != 1:
                errors.append((f"secrets[{i}]", "give exactly one of text, regex or kind"))
            if "regex" in sec:
                import re  # noqa: PLC0415

                try:
                    re.compile(sec["regex"])
                    if _nested(sec["regex"]):
                        errors.append((f"secrets[{i}].regex", "repeats a group that itself repeats or has a choice, like (a+)+ or (a|aa)+, "
                                       "which can take hours to run. Write it without the repeat around the group"))
                    elif _repeat_cost(sec["regex"]) > REPEAT_BUDGET:
                        errors.append((f"secrets[{i}].regex", "has too many open-ended repeats in a row, like a*a*a*b, "
                                       "which can take hours to run on a long line. Use fewer, or give them a limit like {1,40}"))
                except re.error as e:
                    errors.append((f"secrets[{i}].regex", f"isn’t a valid pattern: {e}"))
    if errors:
        raise EdlError(_summarize(errors), errors)
    plan["warnings"] = [{"path": p, "message": m} for p, m in warnings]
    return plan


def retime_words(words, segments, fps):
    """Words in source time → words in output time, only those inside a kept piece, in output order."""
    out = []
    for s in segments:
        a, b = s["src_frame"] / fps, (s["src_frame"] + s["frames"]) / fps
        o = s["out_frame"] / fps
        for w in words:
            mid = (w["start"] + w["end"]) / 2
            if a <= mid < b:
                out.append({"word": w["word"], "start": o + max(w["start"], a) - a, "end": o + min(w["end"], b) - a})
    out.sort(key=lambda w: w["start"])
    return out


def _summarize(errs):
    first = [f"{p}: {m}" if p else m for p, m in errs[:6]]
    more = f" (and {len(errs) - 6} more)" if len(errs) > 6 else ""
    return "The edit list has problems. " + " ".join(first) + more


def crop_geometry(plan, sid, t):
    """How source `sid` is shaped into the output at source second t: ('none'|'crop'|'pad', x0, y0, cw, ch) in source
    pixels, where (cw, ch) is the part of the source that fills the output (the whole source for 'pad')."""
    import numpy as np  # noqa: PLC0415

    o = plan["output"]
    src = plan["sources"][sid]
    sw, sh = src["width"], src["height"]
    if o["fit"] == "none" or o["fit"] == "pad":
        return o["fit"], 0, 0, sw, sh
    if sw / sh > o["aspect"]:
        cw, ch = int(round(sh * o["aspect"])), sh
    else:
        cw, ch = sw, int(round(sw / o["aspect"]))
    track = plan["reframe"]["tracks"].get(sid)
    cx = 0.5
    if track:
        cx = float(np.interp(t, [a for a, _ in track], [b for _, b in track]))
    x0 = int(min(sw - cw, max(0, round(cx * sw - cw / 2))))
    return "crop", x0, (sh - ch) // 2, cw, ch


def to_output(plan, sid, t, box):
    """A source-pixel box [x0, y0, x1, y1] → output pixels at source second t (clipped to the frame), or None if it falls
    outside what the output shows."""
    o = plan["output"]
    W, H = o["width"], o["height"]
    kind, x0, y0, cw, ch = crop_geometry(plan, sid, t)
    if kind == "pad":
        scale = min(W / cw, H / ch)
        ox, oy = (W - cw * scale) / 2, (H - ch * scale) / 2
        sx = sy = scale
    else:
        sx, sy, ox, oy = W / cw, H / ch, 0.0, 0.0
    bx0, by0, bx1, by1 = box
    r = [ox + (bx0 - x0) * sx, oy + (by0 - y0) * sy, ox + (bx1 - x0) * sx, oy + (by1 - y0) * sy]
    r = [max(0, int(r[0])), max(0, int(r[1])), min(W, int(round(r[2]))), min(H, int(round(r[3])))]
    return r if r[2] > r[0] and r[3] > r[1] else None


def overlay_boxes(plan):
    """Every drawn title and caption as (kind, start, end, (x0, y0, x1, y1)): what the gate checks against the frame."""
    W, H = plan["output"]["width"], plan["output"]["height"]
    out = []
    for t in plan["titles"]:
        o = textfx.layout_title(t["text"], t.get("subtitle"), t["kind"], W, H)
        out.append(("title", t["start"], t["end"], o.box))
    st = plan.get("caption_style", {})
    for c in plan["cues"]:
        o = textfx.layout_caption(c["lines"], W, H, st.get("size"), st.get("position", "bottom"))
        out.append(("caption", c["start"], c["end"], o.box))
    return out


def _nested(rx):
    """Whether a pattern repeats something that itself repeats or branches, the shape that backtracks for hours."""
    from re import _constants as C, _parser as P  # noqa: PLC0415

    def walk(node, under):
        for op, arg in node:
            rep = op in (C.MAX_REPEAT, C.MIN_REPEAT) and arg[1] > 1
            if under and (rep or op is C.BRANCH):
                return True
            subs = [y for x in (arg if isinstance(arg, (tuple, list)) else ()) for y in (x if isinstance(x, list) else [x])]
            if any(isinstance(y, P.SubPattern) and walk(y, under or rep) for y in subs):
                return True
        return False

    return walk(P.parse(rx), False)


REPEAT_BUDGET = 2000 * 2000  # verify.TEXT_CAP squared: two open-ended repeats are fine, three can backtrack for hours


def _repeat_cost(rx):
    """How many ways a pattern's repeats can split one 2000-character piece of text. Repeats that can take the same
    characters with only such characters between them, like a*a*a*b or \\w*x\\w*x\\w*, multiply (n cubed), which _nested
    does not see; a separator they cannot match, like the colon in \\s*[:=]\\s*, starts the count again."""
    import re  # noqa: PLC0415
    from re import _compiler, _constants as C, _parser as P  # noqa: PLC0415

    def chars(op, arg):
        try:
            sp = P.SubPattern(P.State(), [(op, arg)])
            rx_ = _compiler.compile(sp, 0)
            return {c for c in range(256) if rx_.fullmatch(chr(c))}
        except Exception:  # noqa: BLE001 - anything odd matches anything
            return set(range(256))

    def flat(node):
        for op, arg in node:
            if op is C.SUBPATTERN:
                yield from flat(arg[3])
            else:
                yield op, arg

    def walk(node):
        best = cost = 1
        prev = None  # (chars) of the last repeat in this chain
        between = set()
        for op, arg in flat(node):
            if op in (C.MAX_REPEAT, C.MIN_REPEAT):
                inner = list(flat(arg[2]))
                span = max(1, min(arg[1], 2000) - arg[0]) * walk(arg[2])
                cs = set().union(*(chars(o, a) for o, a in inner)) if inner else set()
                if prev is not None and prev & cs and between <= (prev | cs):
                    cost *= span
                else:
                    cost = span
                prev, between = cs, set()
                best = max(best, cost, 1)
                cost = min(cost, 10**12)
            elif prev is not None:
                between |= chars(op, arg)
        return min(best, 10**12)

    return walk(P.parse(rx))
