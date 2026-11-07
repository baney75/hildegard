#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Put music under a voice-over: the music drops 16 dB while the voice speaks and comes back in the pauses.

  python3 duck_mix.py VOICE MUSIC OUT [--voice-start 4] [--fade-in 3] [--fade-out 4] [--tail 4] [--total SECONDS]
                      [--duck 16] [--under -8] [--lufs -16] [--peak -1.5] [--allow-overrun]

--voice-start  seconds of music before the voice comes in (default 4)
--fade-in      music fade-in, seconds from the start (default 3)
--tail         seconds of music after the last spoken word (default 4); the length is voice-start + speech + tail
--total        exact length in seconds; overrides --tail. If the voice speaks past it, the script stops and says how many seconds over
--allow-overrun  grow the total to voice-start + speech + tail instead of stopping
--fade-out     music fade-out at the very end, seconds (default 4)
--duck         how far the music drops while the voice speaks, dB (default 16; at least 12 is the rule)
--under        music loudness between words, dB against the voice's own loudness (default -8)
--lufs/--peak  delivery loudness and true-peak ceiling (default -16 LUFS, -1.5 dBTP)

The voice is read with silencedetect: a pause of 0.6 s or more lets the music come back; shorter gaps between words
keep it down. The music loops if it is shorter than the piece. Output is stereo, written by loudnorm in two passes.
Needs only Python 3, ffmpeg and ffprobe on PATH.
"""
import argparse, json, math, os, re, shutil, subprocess, sys, tempfile

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def ff(*a):
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-y", *a], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if r.returncode:
        sys.exit("ffmpeg failed:\n" + r.stderr[-1500:])


def err(*a):
    return subprocess.run([FFMPEG, "-hide_banner", "-nostats", *a], capture_output=True, text=True, encoding="utf-8", errors="replace").stderr


def duration(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, encoding="utf-8", errors="replace")
    return float(r.stdout.strip())


def sample_rate(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    return int(r.stdout.strip())


def lufs(path):
    t = err("-i", path, "-af", "ebur128", "-f", "null", "-")
    t = t[t.rfind("Summary:"):]
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", t).group(1))


def delivered(path):
    t = err("-i", path, "-af", "ebur128=peak=true", "-f", "null", "-")
    t = t[t.rfind("Summary:"):]
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", t).group(1)), float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", t).group(1))


def speech_segments(voice, vd):
    """[(start, end)] where the voice speaks: the stretches between pauses of 0.6 s or more."""
    mean = float(re.search(r"mean_volume: (-?[\d.]+) dB", err("-i", voice, "-af", "volumedetect", "-f", "null", "-")).group(1))
    noise = min(-30.0, max(-55.0, mean - 16))
    t = err("-i", voice, "-af", f"silencedetect=noise={noise}dB:d=0.6", "-f", "null", "-")
    starts = [float(x) for x in re.findall(r"silence_start: (-?[\d.]+)", t)]
    ends = [float(x) for x in re.findall(r"silence_end: (-?[\d.]+)", t)]
    segs, a = [], 0.0
    for i, s in enumerate(starts):
        if s > a + 0.05:
            segs.append((a, s))
        a = ends[i] if i < len(ends) else vd
    if a < vd - 0.05:
        segs.append((a, vd))
    return segs or [(0.0, vd)]


def loudnorm_two_pass(src, dst, target, peak, sr):
    base = f"loudnorm=I={target}:TP={peak}:LRA=11"
    t = err("-i", src, "-af", base + ":print_format=json", "-f", "null", "-")
    m = json.loads(t[t.rfind("{"):t.rfind("}") + 1])
    ff("-i", src, "-af", f"{base}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
       f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true", "-ar", str(sr), *codec_for(dst), dst)


def codec_for(path):
    ext = os.path.splitext(path)[1].lower()
    return ["-c:a", "pcm_s16le"] if ext == ".wav" else ["-c:a", "libmp3lame", "-b:a", "192k"] if ext == ".mp3" else []


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("voice"); ap.add_argument("music"); ap.add_argument("output")
    ap.add_argument("--voice-start", type=float, default=4.0)
    ap.add_argument("--fade-in", type=float, default=3.0)
    ap.add_argument("--fade-out", type=float, default=4.0)
    ap.add_argument("--tail", type=float, default=4.0)
    ap.add_argument("--total", type=float, default=None)
    ap.add_argument("--duck", type=float, default=16.0)
    ap.add_argument("--under", type=float, default=-8.0)
    ap.add_argument("--lufs", type=float, default=-16.0)
    ap.add_argument("--peak", type=float, default=-1.5)
    ap.add_argument("--allow-overrun", action="store_true")
    a = ap.parse_args()
    if not (FFMPEG and FFPROBE):
        sys.exit("ffmpeg and ffprobe must be on PATH")
    vd = duration(a.voice)
    segs = speech_segments(a.voice, vd)
    spoken_to = a.voice_start + segs[-1][1]
    total = a.total if a.total else spoken_to + a.tail
    over = spoken_to + 0.1 - a.total if a.total else 0
    if over > 0:
        if not a.allow_overrun:
            sys.exit(f"the voice speaks until {spoken_to:.2f} s but --total is {a.total:g} s: {over:.2f} s over. "
                     f"Use a --total of at least {math.ceil((spoken_to + 0.1) * 10) / 10:.1f} or --allow-overrun. Nothing was written.")
        total = spoken_to + a.tail
    g = 10 ** (-a.duck / 20)
    # music gain curve: 1 = full, down to g while the voice speaks; ramps of 0.3 s before and 0.5 s after each stretch of speech
    terms = "+".join(f"clip((t-{s + a.voice_start - 0.3:.3f})/0.3,0,1)*clip(({e + a.voice_start + 0.5:.3f}-t)/0.5,0,1)" for s, e in segs)
    expr = f"1-(1-{g:.5f})*min(1,{terms})"
    music_gain = lufs(a.voice) + a.under - lufs(a.music)
    sr = sample_rate(a.voice)
    tmp = tempfile.mkdtemp(prefix="duck-mix-")
    try:
        mix = os.path.join(tmp, "mix.wav")
        fc = (f"[0:a]aformat=channel_layouts=stereo,afade=t=in:d=0.01,adelay={int(a.voice_start * 1000)}:all=1[v];"
              f"[1:a]aformat=channel_layouts=stereo,atrim=duration={total:.3f},asetpts=PTS-STARTPTS,volume={music_gain:.2f}dB,"
              f"volume='{expr}':eval=frame:precision=float,afade=t=in:d={a.fade_in},afade=t=out:st={total - a.fade_out:.3f}:d={a.fade_out}[m];"
              "[v][m]amix=inputs=2:duration=longest:normalize=0")
        ff("-i", a.voice, "-stream_loop", "-1", "-i", a.music, "-filter_complex", fc, "-t", f"{total:.3f}", "-c:a", "pcm_f32le", mix)
        peak = a.peak
        for _ in range(3):
            loudnorm_two_pass(mix, a.output, a.lufs, peak, sr)
            l, tp = delivered(a.output)
            if abs(l - a.lufs) <= 0.5 and tp <= a.peak + 0.1:
                break
            peak -= 0.5
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"voice speaks {segs[0][0] + a.voice_start:.2f} s to {segs[-1][1] + a.voice_start:.2f} s; music down {a.duck:g} dB under it")
    print(f"delivered: {l} LUFS integrated, true peak {tp} dBTP, {total:.2f} s -> {a.output}")
    sys.exit(0 if abs(l - a.lufs) <= 0.5 and tp <= a.peak + 0.1 else 1)


if __name__ == "__main__":
    main()
