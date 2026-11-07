#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Check a finished video in plain lines: length, size, frame rate, codecs, loudness, true peak, black frames, shot changes.

  python3 check_video.py FILE [--min 22] [--max 28] [--size 1280x720] [--fps 30] [--lufs -16] [--peak -1.0] [--cuts 5]

Every option is optional; with one, the line says OK or FIX and why. Black stretches over half a second are always FIX,
and so is a true peak above --peak (default -1.0 dBTP, with 0.1 dB of measuring slack) when the video has sound.
Cuts and transitions are counted from the picture itself: a hard cut is a jump between two frames far larger than the
motion around it, a crossfade or dip is a change of colours across about half a second. Camera or subject motion inside
one shot is not counted, and shots shorter than 0.4 s count once. Exit 0 when nothing says FIX.
Needs only Python 3, ffmpeg and ffprobe on PATH.
"""
import argparse, json, re, shutil, subprocess, sys

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def err(*a):
    return subprocess.run([FFMPEG, "-hide_banner", "-nostats", *a], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr


SAMPLE_FPS, W, H = 10, 32, 18  # the picture is read as 10 thumbnails a second, 32 x 18, in RGB
MIN_SHOT = 0.4  # seconds: events closer than this count once
SPIKE_MIN, SPIKE_RATIO = 0.12, 3.0  # a hard cut: a jump from one thumbnail to the next this big, and this many times the motion around it
COLOUR_MIN = 0.30  # a crossfade or a dip: the colour histogram 0.3 s before and after differs by this much (0 same, 1 nothing shared)


def thumbnails(path):
    raw = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-an", "-vf", f"fps={SAMPLE_FPS},scale={W}:{H}:flags=area,format=rgb24",
                          "-f", "rawvideo", "-"], capture_output=True).stdout
    size = W * H * 3
    return [raw[i:i + size] for i in range(0, len(raw) - size + 1, size)]


def histogram(frame):
    h = [0] * 24  # 8 bins for each of red, green and blue
    for i, v in enumerate(frame):
        h[(i % 3) * 8 + (v >> 5)] += 1
    n = W * H
    return [c / n for c in h]


def count_cuts(path):
    """Hard cuts and crossfades in the picture, each counted once. Motion inside a shot is not a cut."""
    frames = thumbnails(path)
    n = len(frames)
    hist = [histogram(f) for f in frames]
    events = []  # seconds
    # hard cuts: the step from one thumbnail to the next, against the steps around it
    step = [0.0] + [sum(abs(a - b) for a, b in zip(frames[i - 1], frames[i])) / (len(frames[i]) * 255) for i in range(1, n)]
    for i in range(2, n):
        around = sorted(step[j] for j in range(max(1, i - 5), min(n, i + 6)) if j != i)
        mid = around[len(around) // 2] if around else 0
        if step[i] >= SPIKE_MIN and step[i] >= SPIKE_RATIO * max(mid, 0.02):
            events.append(i / SAMPLE_FPS)
    # crossfades and dips: the colours three samples before against three after, over a run of samples
    k = 3
    far = [sum(abs(a - b) for a, b in zip(hist[i - k], hist[i + k])) / 6 for i in range(k, n - k)]
    i = 0
    while i < len(far):
        if far[i] < COLOUR_MIN:
            i += 1
            continue
        j = i
        while j + 1 < len(far) and far[j + 1] >= COLOUR_MIN:
            j += 1
        events.append((i + j) / 2 / SAMPLE_FPS + k / SAMPLE_FPS)
        i = j + 1
    cuts, last = 0, None
    for t in sorted(events):
        if last is None or t - last >= MIN_SHOT:
            cuts, last = cuts + 1, t
    return cuts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--min", type=float)
    ap.add_argument("--max", type=float)
    ap.add_argument("--size")
    ap.add_argument("--fps", type=float)
    ap.add_argument("--lufs", type=float)
    ap.add_argument("--peak", type=float, default=-1.0)
    ap.add_argument("--cuts", type=int)
    a = ap.parse_args()
    if not (FFMPEG and FFPROBE):
        sys.exit("ffmpeg and ffprobe must be on PATH")
    p = json.loads(subprocess.run([FFPROBE, "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,avg_frame_rate",
                                   "-show_entries", "format=duration", "-of", "json", a.file], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout or "{}")
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
            line(f"loudness: {lufs:.1f} LUFS", None if a.lufs is None else abs(lufs - a.lufs) <= 1.0,
                 f"want {a.lufs} LUFS within 1: run loudnorm again")
            line(f"true peak: {tp:.1f} dBTP (limit {a.peak:g})", tp <= a.peak + 0.1,
                 f"above {a.peak:g} dBTP: run loudnorm again with TP={a.peak - 0.5:g}, or lower the level")
        else:
            line("loudness: the audio is silent", False if a.lufs is not None else None, "no sound: lay the music bed under it")
    b = err("-i", a.file, "-an", "-vf", "blackdetect=d=0.5:pix_th=0.1:pic_th=0.98", "-f", "null", "-")
    blk = re.findall(r"black_start:([\d.]+) black_end:([\d.]+)", b)
    line("black frames: " + (", ".join(f"{s}-{e} s" for s, e in blk) if blk else "none over half a second"), not blk,
         "a black stretch over 0.5 s: a clip ends early or a card is black; fix the in/out points or the card colour")
    cuts = count_cuts(a.file)
    line(f"cuts or transitions: {cuts}", None if a.cuts is None else cuts >= a.cuts, f"want at least {a.cuts}")
    print("RESULT: " + ("FIX the lines above, then run this again" if bad else "all checks pass"))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
