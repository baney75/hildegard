# SPDX-License-Identifier: AGPL-3.0-only
"""Proposes an edit list: from a word-timed transcript (filler words, false starts, words deleted in a text file), from
loudness and motion alone, and shortened to a target length. The result is an ordinary edit list the person or model can
read, change and check; nothing here renders."""

import copy

from . import media, plan as plan_mod, signals, transcript as tr


def propose(source, transcript=None, edited_text=None, *, fillers=True, filler_words=None, strict_fillers=False, bad_takes=True,
            pauses=True, margin=0.05, target_seconds=None, target=None, captions=True, auto=False, transcript_path="transcript.json",
            base_dir=".", title=None):
    """(edl, report). `source` is the media file; `transcript` the parsed transcribe result, or None."""
    info = media.probe(source)
    dur = info["seconds"]
    report = {"notes": [], "filler_cuts": 0, "bad_take_cuts": 0, "deleted_cuts": 0, "auto_cuts": 0, "pause_cuts": 0,
              "removed": [], "trimmed_sentences": 0}
    edl = {"version": 1, "sources": {"a": {"path": source}}}
    if title:
        edl["title"] = title
    if target:
        edl["target"] = target
    cuts = []
    words = None
    if transcript is not None:
        words = tr.words_of(transcript)
        reasons = {}
        if edited_text is not None:
            gone, notes = tr.deleted_from_text(words, edited_text)
            report["notes"] += notes
            for i in gone:
                reasons[i] = "deleted in the text"
        if bad_takes:
            for i, why in tr.find_bad_takes(words).items():
                reasons.setdefault(i, f"earlier take, {why}")
        if fillers:
            for i, f in tr.find_fillers(words, filler_words, True, strict_fillers).items():
                reasons.setdefault(i, f"filler “{f}”")
        c, notes = tr.cuts_for(words, reasons, "", margin, dur)
        report["notes"] += notes
        cuts = c
        for a, b, why in c:
            key = "deleted_cuts" if why.startswith("deleted") else "bad_take_cuts" if why.startswith("earlier") else "filler_cuts"
            report[key] += 1
        report["removed"] = [{"at": round(w["start"], 2), "text": w["word"], "why": reasons[w["i"]]} for w in words if w["i"] in reasons][:60]
        if captions:
            edl["captions"] = {"transcript": transcript_path}
    if auto or transcript is None:
        mode = "both" if info["video"] else "audio"
        ac = signals.auto_cuts(source, 0, mode)
        report["auto_cuts"] = len(ac)
        cuts += [(a, b, why) for a, b, why in ac]
        if transcript is None and not ac:
            report["notes"].append("No stretch was both quiet and still for long enough to cut.")
    cuts.sort()
    merged = []
    for a, b, why in cuts:
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]), merged[-1][2])
        else:
            merged.append((a, b, why))
    edl["cuts"] = [{"start": a, "end": b, "why": why} for a, b, why in merged]
    if pauses:
        edl["pauses"] = pauses if isinstance(pauses, dict) else {"max": 0.7, "keep": 0.3, "margin": 0.12}
    whole = plan_mod.resolve({"version": 1, "sources": {"a": {"path": source}}}, base_dir, analyze=False, track=False)["out_seconds"]
    report["source_seconds"] = whole
    got = plan_mod.resolve(copy.deepcopy(edl), base_dir, track=False)
    if target_seconds and got["out_seconds"] > target_seconds:
        if pauses:
            tight = {"max": 0.45, "keep": 0.2, "margin": 0.1}
            edl["pauses"] = tight
            got = plan_mod.resolve(copy.deepcopy(edl), base_dir, track=False)
            report["notes"].append(f"Over the target, so pauses are cut harder (longer than {tight['max']} s become {tight['keep']} s).")
        if got["out_seconds"] > target_seconds and words is not None:
            have = {i for i, _ in enumerate(words) if any(c["start"] <= words[i]["start"] and words[i]["end"] <= c["end"] for c in edl["cuts"])}
            base_len = got["out_seconds"]

            def length_after(extra):
                c, _ = tr.cuts_for(words, {i: "x" for i in extra - have}, "", margin, dur)
                return base_len - sum(b - a for a, b, _ in c)

            extra = tr.trim_to(words, have, target_seconds, length_after)
            if extra:
                all_reasons = {i: "x" for i in have}
                all_reasons.update(extra)
                c, _ = tr.cuts_for(words, {i: extra.get(i, "kept cut") for i in extra}, "", margin, dur)
                for a, b, why in c:
                    edl["cuts"].append({"start": a, "end": b, "why": why})
                edl["cuts"].sort(key=lambda x: x["start"])
                report["trimmed_sentences"] = len({w["i"] for w in words if w["i"] in extra})
                report["notes"].append("Trimmed whole sentences with the least said per second to reach the length. Read the cuts and keep or restore any that matter.")
                got = plan_mod.resolve(copy.deepcopy(edl), base_dir, track=False)
    report["pause_cuts"] = len(got["pauses_cut"])
    report["after_seconds"] = got["out_seconds"]
    if target_seconds:
        report["target_seconds"] = target_seconds
        if got["out_seconds"] > target_seconds + 0.5:
            report["notes"].append(f"Still {got['out_seconds'] - target_seconds:.0f} s over {target_seconds:g} s. Delete more lines in the text file, or add “keep” ranges for just the parts you want.")
    return edl, report
