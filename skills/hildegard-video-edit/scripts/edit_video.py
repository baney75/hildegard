# SPDX-License-Identifier: AGPL-3.0-only
"""Edit video from an edit list any model can write, then prove the result on the output.

    python edit_video.py check EDL                       is the edit list well formed, and what will it make
    python edit_video.py schema                          print the JSON Schema for edl.json
    python edit_video.py transcript-text TRANSCRIPT -o words.txt     the words to cut from
    python edit_video.py plan SOURCE -o edl.json [--transcript T.json] [--text edited.txt] [--target-seconds N]
                                                         propose an edit list (fillers, false starts, deleted words, pauses)
    python edit_video.py bake EDL -o baked.json          turn pause shortening into plain cuts
    python edit_video.py render EDL OUT.mp4              render (parallel, restartable, hardware encoder when present)
    python edit_video.py verify OUT.mp4 EDL              the gate: exit 0 only if the output proves the edit list
    python edit_video.py sheet OUT.mp4 [--edl EDL] -o sheet.jpg      a contact sheet of the cut, with the joins
    python edit_video.py extract-audio SOURCE OUT.wav    16 kHz mono, for a transcriber
    python edit_video.py probe FILE
    python edit_video.py selftest                        prove the gate against a planted fake key

Add --json to any of them for machine-readable output: one JSON object per line, the last one {"ok": …}. Exit codes:
0 fine, 1 the check or gate failed (or a problem the message explains), 2 couldn't run (a missing dependency).
Needs Python 3.9+, PyAV, numpy and Pillow (pip install av numpy pillow); tesseract (optional) lets the gate read the output.
"""

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    from hgedit import edl as edl_mod, media, plan as plan_mod
except ImportError as e:  # a missing package
    print(f"Video editing needs PyAV, numpy and Pillow: pip install av numpy pillow ({e})", file=sys.stderr)
    sys.exit(2)

JSON = False


def out(**kw):
    if JSON:
        print(json.dumps(kw, default=str), flush=True)


def say(text):
    if not JSON:
        print(text, flush=True)


def fail(message, code=1, **kw):
    if JSON:
        print(json.dumps({"ok": False, "error": message, **kw}, default=str), flush=True)
    else:
        print(message, file=sys.stderr)
    sys.exit(code)


def load_json(path, what):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        fail(f"There is no {what} at {path}.")
    except ValueError as e:
        fail(f"{os.path.basename(path)} isn’t valid JSON: {e}")


def cmd_check(a):
    edl = edl_mod.load(a.edl)
    base = os.path.dirname(os.path.abspath(a.edl))
    shape = edl_mod.validate(edl)
    if shape:
        errs = [{"path": p, "message": m} for p, m in shape]
        out(ok=False, errors=errs, warnings=[])
        if not JSON:
            print(f"{os.path.basename(a.edl)} has {len(errs)} problem{'s' if len(errs) != 1 else ''}:")
            for e in errs:
                print(f"  {e['path'] or 'edit list'}: {e['message']}")
        sys.exit(1)
    try:
        plan = plan_mod.resolve(edl, base, analyze=not a.quick, track=not a.quick)
    except edl_mod.EdlError as e:
        errs = [{"path": p, "message": m} for p, m in e.errors] or [{"path": "", "message": str(e)}]
        out(ok=False, errors=errs, warnings=[])
        if not JSON:
            print(f"{os.path.basename(a.edl)} has {len(errs)} problem{'s' if len(errs) != 1 else ''}:")
            for x in errs:
                print(f"  {x['path'] or 'edit list'}: {x['message']}")
        sys.exit(1)
    o = plan["output"]
    summary = {"seconds": plan["out_seconds"], "frames": plan["out_frames"], "fps": float(plan.fps), "segments": len(plan["segments"]),
               "width": o["width"], "height": o["height"], "cues": len(plan["cues"]), "titles": len(plan["titles"]),
               "blur": len(plan["blur"]), "chapters": len(plan["chapters"]), "pauses_cut": len(plan["pauses_cut"]),
               "pauses_kept": len(plan["pauses_kept"]), "target": plan["target"]["name"], "music": "music" in plan}
    out(ok=True, errors=[], warnings=plan["warnings"], summary=summary)
    if not JSON:
        print(f"{os.path.basename(a.edl)} is a good edit list.")
        print(f"  It makes {plan['out_seconds']:.2f} s ({plan['out_frames']} frames at {float(plan.fps):g} fps), {o['width']}x{o['height']}, {len(plan['segments'])} pieces joined by {len(plan['joins'])} cuts.")
        extras = [f"{summary[k]} {k}" for k in ("cues", "titles", "blur", "chapters") if summary[k]]
        if extras:
            print("  With " + ", ".join(extras) + ".")
        if plan["pauses_cut"] or plan["pauses_kept"]:
            print(f"  Pauses: {len(plan['pauses_cut'])} shortened, {len(plan['pauses_kept'])} left because of typing or clicking.")
        for w in plan["warnings"]:
            print(f"  note: {w['path']}: {w['message']}")


def cmd_schema(a):
    with open(edl_mod.SCHEMA_PATH, encoding="utf-8") as f:
        print(f.read())


def cmd_transcript_text(a):
    from hgedit import transcript as tr  # noqa: PLC0415

    try:
        words = tr.words_of(load_json(a.transcript, "transcript"))
    except tr.TranscriptError as e:
        fail(str(e))
    text = tr.to_text(words)
    if a.o:
        with open(a.o, "w", encoding="utf-8") as f:
            f.write(text)
        out(ok=True, path=a.o, words=len(words))
        say(f"Wrote {len(words)} words to {a.o}. Delete words or lines you want cut, then run plan with --text {a.o}.")
    else:
        print(text)


def cmd_plan(a):
    from hgedit import planner, transcript as tr  # noqa: PLC0415

    transcript = load_json(a.transcript, "transcript") if a.transcript else None
    edited = None
    if a.text:
        with open(a.text, encoding="utf-8") as f:
            edited = f.read()
    base = os.path.dirname(os.path.abspath(a.o))
    os.makedirs(base, exist_ok=True)
    tpath = os.path.join(base, "transcript.json")
    source = os.path.abspath(a.source)
    pauses = False if a.no_pauses else ({"max": a.pause_max, "keep": a.pause_keep, "margin": 0.12})
    try:
        edl, report = planner.propose(
            source, transcript, edited, fillers=not a.no_fillers, filler_words=a.filler or None, strict_fillers=a.strict_fillers,
            bad_takes=not a.no_bad_takes, pauses=pauses, margin=a.margin, target_seconds=a.target_seconds, target=a.target,
            captions=not a.no_captions, auto=a.auto, transcript_path="transcript.json", base_dir=base, title=a.title)
    except (tr.TranscriptError, edl_mod.EdlError, media.MediaError) as e:
        fail(str(e))
    if transcript is not None and edl.get("captions"):
        with open(tpath, "w", encoding="utf-8") as f:
            json.dump(transcript, f)
    with open(a.o, "w", encoding="utf-8") as f:
        json.dump(edl, f, indent=2, ensure_ascii=False)
    out(ok=True, edl=a.o, report=report)
    if not JSON:
        r = report
        print(f"Wrote {a.o}: {r['source_seconds']:.1f} s of footage → {r['after_seconds']:.1f} s.")
        print(f"  cuts: {r['filler_cuts']} filler, {r['bad_take_cuts']} earlier takes, {r['deleted_cuts']} deleted in the text, {r['auto_cuts']} quiet and still; {r['pause_cuts']} pauses shortened.")
        for x in r["removed"][:12]:
            print(f"    {x['at']:7.2f}s  {x['text']}  ({x['why']})")
        for n in r["notes"]:
            print(f"  note: {n}")
        print(f"Next: python edit_video.py check {a.o}")


def cmd_bake(a):
    edl = edl_mod.load(a.edl)
    plan = plan_mod.resolve(edl, os.path.dirname(os.path.abspath(a.edl)), track=False)
    cuts = edl.get("cuts", []) + [{"source": s, "start": x, "end": y, "why": "pause"} for s, x, y in plan["pauses_cut"]]
    if len(edl["sources"]) == 1:
        for c in cuts:
            c.pop("source", None)
    edl["cuts"] = sorted(cuts, key=lambda c: (c.get("source", ""), c["start"]))
    edl.pop("pauses", None)
    with open(a.o, "w", encoding="utf-8") as f:
        json.dump(edl, f, indent=2, ensure_ascii=False)
    out(ok=True, edl=a.o, pauses_baked=len(plan["pauses_cut"]))
    say(f"Wrote {a.o} with {len(plan['pauses_cut'])} pauses as plain cuts.")


def cmd_render(a):
    from hgedit import render  # noqa: PLC0415

    def stage(s):
        out(stage=s)
        say(s + " ...")

    def progress(d, t):
        out(done=d, total=t)

    try:
        r = render.render(a.edl, a.out, workers=a.workers, encoder=a.encoder, crf=a.crf, keep_work=a.keep_work, stage=stage, progress=progress)
    except (edl_mod.EdlError, render.RenderError, media.MediaError) as e:
        fail(str(e))
    out(**r)
    if not JSON:
        print(f"Rendered {r['out']}: {r['seconds']:.2f} s, {r['frames']} frames, {r['width']}x{r['height']}, {r['encoder']}"
              + (f", {r['lufs']:.1f} LUFS / {r['true_peak']:.1f} dBTP" if r["lufs"] is not None else "")
              + f", {r['audio_tracks']} audio track{'s' if r['audio_tracks'] != 1 else ''}.")
        print(f"Next: python edit_video.py verify {r['out']} {a.edl}")


def cmd_verify(a):
    from hgedit import verify  # noqa: PLC0415

    try:
        rep = verify.verify(a.out, a.edl)
    except (edl_mod.EdlError, media.MediaError) as e:
        fail(str(e))
    out(**rep)
    if not JSON:
        for c in rep["checks"]:
            mark = {"pass": "OK  ", "fail": "FAIL", "warn": "note", "skip": "skip"}[c["status"]]
            print(f"{mark} {c['id']:9s} {c['detail']}")
        if rep["unproven"]:
            print(f"UNPROVEN: {', '.join(rep['unproven'])} (nothing was checked there).")
        print("The output matches the edit list." if rep["ok"] else "The output does NOT match the edit list. Fix what failed, render again, verify again.")
    sys.exit(0 if rep["ok"] else 1)


def cmd_sheet(a):
    from hgedit import sheet  # noqa: PLC0415

    plan = None
    if a.edl:
        plan = plan_mod.resolve(edl_mod.load(a.edl), os.path.dirname(os.path.abspath(a.edl)), track=False)
    r = sheet.make(a.out, a.o or os.path.splitext(a.out)[0] + ".sheet.jpg", plan, count=a.count)
    out(ok=True, **r)
    say(f"Wrote {r['path']}: {len(r['times'])} frames spread through the video and {len(r['joins'])} cuts as before-and-after pairs. Look at it.")


def cmd_extract_audio(a):
    import numpy as np  # noqa: PLC0415
    import av  # noqa: PLC0415
    from fractions import Fraction  # noqa: PLC0415

    info = media.probe(a.source)
    if not info["audio"]:
        fail("That file has no sound to transcribe.")
    x = media.read_audio(a.source, None, a.track, 1, rate=16000)[0]
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with av.open(a.out, "w", format="wav") as c:
        s = c.add_stream("pcm_s16le", rate=16000, layout="mono")
        for i in range(0, len(pcm), 4096):
            fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm[i : i + 4096].reshape(1, -1)), format="s16", layout="mono")
            fr.sample_rate, fr.pts, fr.time_base = 16000, i, Fraction(1, 16000)
            for p in s.encode(fr):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    out(ok=True, path=a.out, seconds=round(len(pcm) / 16000, 2))
    say(f"Wrote {a.out} ({len(pcm) / 16000:.1f} s).")


def cmd_probe(a):
    r = media.probe(a.file)
    out(ok=True, **r)
    say(json.dumps(r, indent=1))


def cmd_selftest(a):
    from hgedit import selftest  # noqa: PLC0415

    ok, lines = selftest.run(say=(lambda s: say(s)))
    out(ok=ok, lines=lines)
    sys.exit(0 if ok else 1)


def main(argv):
    global JSON
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--json", action="store_true", help="machine-readable output")
    sub = p.add_subparsers(dest="cmd", required=True)

    def add(name, fn, *args):
        s = sub.add_parser(name)
        s.add_argument("--json", action="store_true", default=argparse.SUPPRESS)
        for a_, kw in args:
            s.add_argument(*a_, **kw)
        s.set_defaults(fn=fn)
        return s

    add("check", cmd_check, (("edl",), {}), (("--quick",), {"action": "store_true", "help": "skip the sound and subject analysis"}))
    add("schema", cmd_schema)
    add("transcript-text", cmd_transcript_text, (("transcript",), {}), (("-o",), {}))
    add("plan", cmd_plan, (("source",), {}), (("-o",), {"required": True}), (("--transcript",), {}), (("--text",), {}),
        (("--target-seconds",), {"type": float}), (("--target",), {"help": "youtube, shorts, reels, tiktok, x or podcast"}),
        (("--filler",), {"action": "append", "help": "a filler word or phrase (repeat); replaces the default list"}),
        (("--strict-fillers",), {"action": "store_true", "help": "cut like/you know/I mean everywhere, not just as hesitations"}),
        (("--no-fillers",), {"action": "store_true"}), (("--no-bad-takes",), {"action": "store_true"}), (("--no-pauses",), {"action": "store_true"}),
        (("--no-captions",), {"action": "store_true"}), (("--auto",), {"action": "store_true", "help": "also cut where it is quiet and still"}),
        (("--pause-max",), {"type": float, "default": 0.7}), (("--pause-keep",), {"type": float, "default": 0.3}),
        (("--margin",), {"type": float, "default": 0.05}), (("--title",), {}))
    add("bake", cmd_bake, (("edl",), {}), (("-o",), {"required": True}))
    add("render", cmd_render, (("edl",), {}), (("out",), {}), (("--workers",), {"type": int}), (("--encoder",), {}),
        (("--crf",), {"type": int, "default": 18}), (("--keep-work",), {"action": "store_true"}))
    add("verify", cmd_verify, (("out",), {}), (("edl",), {}))
    add("sheet", cmd_sheet, (("out",), {}), (("--edl",), {}), (("-o",), {}), (("--count",), {"type": int, "default": 12}))
    add("extract-audio", cmd_extract_audio, (("source",), {}), (("out",), {}), (("--track",), {"type": int, "default": 0}))
    add("probe", cmd_probe, (("file",), {}))
    add("selftest", cmd_selftest)
    a = p.parse_args(argv)
    JSON = a.json
    try:
        a.fn(a)
    except edl_mod.EdlError as e:
        if JSON:
            print(json.dumps({"ok": False, "error": str(e), "errors": [{"path": x, "message": y} for x, y in e.errors]}), flush=True)
        else:
            print(str(e), file=sys.stderr)
        sys.exit(1)
    except media.MediaError as e:
        fail(str(e))


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    try:
        main(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as e:  # the server shows this to the person, so keep it to one plain line
        msg = str(e) or type(e).__name__
        if JSON or "--json" in sys.argv:
            print(json.dumps({"ok": False, "error": msg}), flush=True)
        else:
            print(f"Something went wrong: {msg}", file=sys.stderr)
        sys.exit(1)
