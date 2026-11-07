#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Measure an audio (or video) file in plain lines: loudness, true peak, length, and mains hum.

  python3 measure.py FILE [--lufs -16] [--peak -1.0]

Prints: duration, channels and sample rate; integrated loudness (LUFS), loudness range, true peak (dBTP) and whether they
meet the target you pass (--lufs and --peak; default -16 and -1.0); how many samples sit at full scale; and the hum
prominence at 50, 60, 100 and 120 Hz in the quietest pauses of the file, in dB above the surrounding frequencies.
Under 6 dB is clean; over 6 dB you can hear a hum, so notch it and measure again. Exit 0 when loudness and peak are on target.
Needs only Python 3, ffmpeg and ffprobe on PATH.
"""
import argparse, array, json, math, re, shutil, subprocess, sys

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def goertzel(x, f, sr):
    """Power of x at frequency f (a Hann-windowed Goertzel filter)."""
    n = len(x)
    w = 2 * math.pi * f / sr
    c = 2 * math.cos(w)
    s1 = s2 = 0.0
    for i in range(n):
        s0 = x[i] * (0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1))) + c * s1 - s2
        s2, s1 = s1, s0
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n)


def hum_prominence(path, freqs=(50, 60, 100, 120), sr=4000, win=0.5, quiet=0.2, max_windows=12):
    r = subprocess.run([FFMPEG, "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "f32le", "-"], capture_output=True)
    a = array.array("f")
    a.frombytes(r.stdout[: len(r.stdout) // 4 * 4])
    n = int(sr * win)
    wins = [a[i:i + n] for i in range(0, len(a) - n + 1, n)]
    rms = [math.sqrt(sum(v * v for v in w) / n) for w in wins]
    ranked = sorted((r_, i) for i, r_ in enumerate(rms) if r_ > 1e-5)
    if len(ranked) < 3:
        return None
    pick = [i for _, i in ranked[: max(3, min(max_windows, int(len(ranked) * quiet)))]]
    out = {}
    for f in freqs:
        per = []
        for i in pick:
            w = wins[i]
            peak = max(goertzel(w, f + d, sr) for d in (-1, 0, 1))
            near = sorted(goertzel(w, f + sgn * off, sr) for off in range(12, 46, 3) for sgn in (-1, 1) if f + sgn * off > 20)
            per.append(10 * math.log10((peak + 1e-20) / (near[len(near) // 2] + 1e-20)))
        # hum sits in every quiet moment; a speech harmonic only in some. Take the lower quartile so speech cannot fake it.
        per.sort()
        out[f] = per[len(per) // 4]
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("--lufs", type=float, default=-16.0)
    ap.add_argument("--peak", type=float, default=-1.0)
    a = ap.parse_args()
    if not (FFMPEG and FFPROBE):
        sys.exit("ffmpeg and ffprobe must be on PATH")
    p = json.loads(subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels,sample_rate",
                                   "-show_entries", "format=duration", "-of", "json", a.file], capture_output=True, text=True).stdout or "{}")
    if not p.get("streams"):
        sys.exit(f"{a.file}: no audio stream")
    s = p["streams"][0]
    print(f"duration: {float(p['format']['duration']):.2f} s   channels: {s['channels']}   sample rate: {s['sample_rate']} Hz")
    t = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", a.file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    t = t[t.rfind("Summary:"):]
    lufs = float(re.search(r"I:\s+(-?[\d.]+) LUFS", t).group(1))
    lra = re.search(r"LRA:\s+(-?[\d.]+) LU", t)
    tp = float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", t).group(1))
    ok_l, ok_p = abs(lufs - a.lufs) <= 1.0, tp <= a.peak + 0.1
    print(f"loudness: {lufs:.1f} LUFS integrated (target {a.lufs:g}, {'ON TARGET' if ok_l else 'OFF TARGET: run loudnorm again'})")
    if lra:
        print(f"loudness range: {lra.group(1)} LU")
    print(f"true peak: {tp:.1f} dBTP (limit {a.peak:g}, {'OK' if ok_p else 'TOO HOT: lower the true-peak ceiling and run loudnorm again'})")
    v = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", a.file, "-vn", "-af", "volumedetect", "-f", "null", "-"],
                       capture_output=True, text=True).stderr
    mx = re.search(r"max_volume: (-?[\d.]+) dB", v)
    print(f"sample peak: {mx.group(1)} dBFS ({'CLIPPING: a sample is at full scale' if mx and float(mx.group(1)) >= -0.05 else 'no clipping'})" if mx else "sample peak: unknown")
    h = hum_prominence(a.file)
    if h is None:
        print("hum: too short or too silent to tell")
    else:
        for f, d in h.items():
            print(f"hum at {f} Hz: {d:+.1f} dB above its surroundings in the pauses ({'HUM: notch it' if d > 6 else 'clean'})")
    sys.exit(0 if ok_l and ok_p else 1)


if __name__ == "__main__":
    main()
