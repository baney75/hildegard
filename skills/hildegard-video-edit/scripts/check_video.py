#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Check a finished video in plain lines: length, size, frame rate, codecs, loudness, black frames, scene changes.

  python3 check_video.py FILE [--min 22] [--max 28] [--size 1280x720] [--fps 30] [--lufs -16] [--cuts 5]

Every option is optional; with one, the line says OK or FIX and why. Black stretches over half a second are always FIX.
Exit 0 when nothing says FIX. Needs only Python 3, ffmpeg and ffprobe on PATH.
"""
import argparse, json, re, shutil, subprocess, sys

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def err(*a):
    return subprocess.run([FFMPEG, "-hide_banner", "-nostats", *a], capture_output=True, text=True).stderr


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--min", type=float)
    ap.add_argument("--max", type=float)
    ap.add_argument("--size")
    ap.add_argument("--fps", type=float)
    ap.add_argument("--lufs", type=float)
    ap.add_argument("--cuts", type=int)
    a = ap.parse_args()
    if not (FFMPEG and FFPROBE):
        sys.exit("ffmpeg and ffprobe must be on PATH")
    p = json.loads(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate",
                                   "-show_entries", "format=duration", "-of", "json", a.file], capture_output=True, text=True).stdout or "{}")
    v = next((s for s in p.get("streams", []) if s["codec_type"] == "video"), None)
    au = next((s for s in p.get("streams", []) if s["codec_type"] == "audio"), None)
    if not v:
        sys.exit(f"{a.file}: no video stream")
    dur = float(p["format"]["duration"])
    n, d = (v["avg_frame_rate"].split("/") + ["1"])[:2]
    fps = float(n) / float(d or 1)
    bad = []

    def line(text, ok=None, why=""):
        tag = "" if ok is None else ("  OK" if ok else "  FIX: " + why)
        if ok is False:
            bad.append(text)
        print(text + tag)
    line(f"length: {dur:.2f} s", None if a.min is None and a.max is None else (a.min or 0) <= dur <= (a.max or 1e9),
         f"want {a.min} to {a.max} s: trim or widen the in/out points")
    line(f"size: {v['width']}x{v['height']}", None if not a.size else f"{v['width']}x{v['height']}" == a.size, f"want {a.size}")
    line(f"frame rate: {fps:.2f} fps", None if not a.fps else abs(fps - a.fps) < 0.2, f"want {a.fps}")
    line(f"codecs: video {v['codec_name']}, audio {au['codec_name'] if au else 'none'}", v["codec_name"] == "h264" and bool(au) and au["codec_name"] == "aac",
         "want H.264 video and AAC audio")
    if au:
        t = err("-i", a.file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-")
        t = t[t.rfind("Summary:"):]
        mi, mp = re.search(r"I:\s+(-?[\d.]+) LUFS", t), re.search(r"Peak:\s+(-?[\d.]+) dBFS", t)
        if mi and mp:
            lufs, tp = float(mi.group(1)), float(mp.group(1))
            line(f"loudness: {lufs:.1f} LUFS, true peak {tp:.1f} dBTP", None if a.lufs is None else abs(lufs - a.lufs) <= 1.0,
                 f"want {a.lufs} LUFS within 1: run loudnorm again")
        else:
            line("loudness: the audio is silent", False if a.lufs is not None else None, "no sound: lay the music bed under it")
    b = err("-i", a.file, "-an", "-vf", "blackdetect=d=0.5:pix_th=0.1:pic_th=0.98", "-f", "null", "-")
    blk = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", b)
    line("black frames: " + (", ".join(f"{s}-{e} s" for s, e in blk) if blk else "none over half a second"), not blk,
         "a black stretch over 0.5 s: a clip ends early or a card is black; fix the in/out points or the card colour")
    sc = err("-i", a.file, "-an", "-vf", "select='gt(scene,0.03)',showinfo", "-f", "null", "-")
    times = [float(x) for x in re.findall(r"pts_time:([\d.]+)", sc)]
    cuts = sum(1 for i, t in enumerate(times) if i == 0 or t - times[i - 1] > 0.6)  # one crossfade shows as a run of frames: count it once
    line(f"cuts or transitions: {cuts}", None if a.cuts is None else cuts >= a.cuts, f"want at least {a.cuts}")
    print("RESULT: " + ("FIX the lines above, then run this again" if bad else "all checks pass"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
