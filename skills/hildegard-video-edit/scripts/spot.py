#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Assemble a radio spot: voice lines in order over a music bed, ducked, with a closing sting, to an exact length.

  python3 spot.py OUT --music music.wav --sting sting.wav --lines line1.wav line2.wav line3.wav
                  [--total 15] [--first 0.5] [--gap 0.5] [--duck 16] [--under -8] [--lufs -16] [--peak -1.5] [--allow-overrun]

--total   exact length of the spot in seconds (default 15)
--first   seconds before the first line (default 0.5); the music starts on the first frame
--gap     seconds of quiet between one line's last word and the next line's first (default 0.5). A recording that
          carries its own silence at the ends can force a longer gap; lines never overlap.
--duck    dB the music drops under each line (default 16); it comes back up between lines
--under   music loudness between lines, dB against the voice (default -8)
--allow-overrun
          when the lines and the sting cannot fit in --total, let the total grow to fit them (it says the new length)

Each line is cut to its speech plus 50 ms; the sting ends 0.1 s before the end; the music fades out over the last 0.9 s.
If the lines and the sting do not fit in --total, the gaps shrink to 0.3 s first, then the first line moves up. If they
still do not fit it writes nothing and exits 1 with how many seconds over: a voice line is never cut. Shorten the lines,
lengthen --total, or pass --allow-overrun. Output is stereo, loudnorm in two passes. Needs only Python 3, ffmpeg and ffprobe on PATH.
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


def lufs(path):
    t = err("-i", path, "-af", "ebur128", "-f", "null", "-")
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", t[t.rfind("Summary:"):]).group(1))


def delivered(path):
    t = err("-i", path, "-af", "ebur128=peak=true", "-f", "null", "-")
    t = t[t.rfind("Summary:"):]
    return float(re.search(r"I:\s+(-?[\d.]+) LUFS", t).group(1)), float(re.search(r"Peak:\s+(-?[\d.]+) dBFS", t).group(1))


def loudnorm_two_pass(src, dst, target, peak):
    base = f"loudnorm=I={target}:TP={peak}:LRA=11"
    t = err("-i", src, "-af", base + ":print_format=json", "-f", "null", "-")
    m = json.loads(t[t.rfind("{"):t.rfind("}") + 1])
    codec = ["-c:a", "pcm_s16le"] if dst.lower().endswith(".wav") else []
    ff("-i", src, "-af", f"{base}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
       f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true", "-ar", "44100", *codec, dst)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("output")
    ap.add_argument("--music", required=True)
    ap.add_argument("--sting", required=True)
    ap.add_argument("--lines", nargs="+", required=True)
    ap.add_argument("--total", type=float, default=15.0)
    ap.add_argument("--first", type=float, default=0.5)
    ap.add_argument("--gap", type=float, default=0.5)
    ap.add_argument("--duck", type=float, default=16.0)
    ap.add_argument("--under", type=float, default=-8.0)
    ap.add_argument("--lufs", type=float, default=-16.0)
    ap.add_argument("--peak", type=float, default=-1.5)
    ap.add_argument("--allow-overrun", action="store_true")
    a = ap.parse_args()
    if not (FFMPEG and FFPROBE):
        sys.exit("ffmpeg and ffprobe must be on PATH")
    tmp = tempfile.mkdtemp(prefix="spot-")
    try:
        # 1) cut each line to its speech plus 50 ms either side; remember the silence it had before and after
        sil = "silenceremove=start_periods=1:start_threshold=-50dB"
        rows = []
        for n, f in enumerate(a.lines, start=1):
            full = duration(f)
            ff("-i", f, "-af", sil, os.path.join(tmp, "a.wav"))
            after_start = duration(os.path.join(tmp, "a.wav"))
            ff("-i", os.path.join(tmp, "a.wav"), "-af", f"areverse,{sil}:start_silence=0.05,areverse", os.path.join(tmp, "b.wav"))
            speech = duration(os.path.join(tmp, "b.wav"))
            lp = os.path.join(tmp, f"l{n}.wav")
            ff("-i", f, "-af", f"{sil}:start_silence=0.05,areverse,{sil}:start_silence=0.05,areverse,afade=t=in:d=0.01,aformat=channel_layouts=stereo",
               "-ar", "44100", lp)
            rows.append({"path": lp, "dur": duration(lp), "lead": full - after_start, "trail": after_start - speech})
        sting_len = duration(a.sting)
        # 2) timeline: gap between speech = --gap, never less than the recordings' own quiet ends need; the sting ends 0.1 s early
        n = len(rows)
        gaps = [max(a.gap, rows[i]["trail"] + rows[i + 1]["lead"] + 0.02) for i in range(n - 1)]
        latest = a.total - 0.1 - sting_len
        first = a.first

        def place(first, gaps):
            t, starts = first - 0.05, []
            for i, r in enumerate(rows):
                starts.append(t)
                t += r["dur"] + (gaps[i] - 0.1 if i < n - 1 else 0)
            return starts, t - 0.05
        starts, end = place(first, gaps)
        if end + 0.05 > latest and n > 1:
            over = end + 0.05 - latest
            floors = [max(0.3, rows[i]["trail"] + rows[i + 1]["lead"] + 0.02) for i in range(n - 1)]
            gaps = [max(floors[i], gaps[i] - over / (n - 1)) for i in range(n - 1)]
            first = 0.3
            starts, end = place(first, gaps)
        if end > latest:
            need = end + 0.05 + 0.1 + sting_len
            if not a.allow_overrun:
                sys.exit(f"the lines and the sting need {need:.2f} s but --total is {a.total:g} s: {need - a.total:.2f} s over, even with the gaps at 0.3 s. "
                         f"Use shorter lines, a --total of at least {math.ceil(need * 10) / 10:.1f}, or --allow-overrun to let the total grow. Nothing was written.")
            print(f"note: the lines and the sting need {need:.2f} s, so the total grows from {a.total:g} s to {need:.2f} s", file=sys.stderr)
            a.total = need
            latest = a.total - 0.1 - sting_len
        # 3) the voice stem, and the levels of the bed and the sting against it
        ins, fc, mixin = [], [], ""
        for i, r in enumerate(rows):
            ins += ["-i", r["path"]]
            fc.append(f"[{i}:a]adelay={int(starts[i] * 1000)}:all=1[d{i}]")
            mixin += f"[d{i}]"
        voice = os.path.join(tmp, "voice.wav")
        ff(*ins, "-filter_complex", ";".join(fc) + f";{mixin}amix=inputs={n}:duration=longest:normalize=0,apad=whole_dur={a.total}",
           "-t", f"{a.total}", "-ar", "44100", "-c:a", "pcm_f32le", voice)
        v = lufs(voice)
        music_gain = v + a.under - lufs(a.music)
        sting_gain = v - 3 - lufs(a.sting)
        # 4) the duck curve: down 0.15 s before each line, back up 0.25 s after
        g = 10 ** (-a.duck / 20)
        terms = "+".join(f"clip((t-{s - 0.15:.3f})/0.15,0,1)*clip(({s + r['dur'] + 0.25:.3f}-t)/0.25,0,1)" for s, r in zip(starts, rows))
        expr = f"1-(1-{g:.5f})*min(1,{terms})"
        mix = os.path.join(tmp, "mix.wav")
        fc = (f"[1:a]aformat=channel_layouts=stereo,atrim=duration={a.total},asetpts=PTS-STARTPTS,volume={music_gain:.2f}dB,"
              f"volume='{expr}':eval=frame:precision=float,afade=t=in:d=0.02,afade=t=out:st={a.total - 0.9:.3f}:d=0.9[m];"
              f"[2:a]aformat=channel_layouts=stereo,volume={sting_gain:.2f}dB,afade=t=in:d=0.005,"
              f"afade=t=out:st={max(0.1, sting_len - 0.4):.3f}:d=0.4,adelay={int(latest * 1000)}:all=1[s];"
              "[0:a][m][s]amix=inputs=3:duration=longest:normalize=0")
        ff("-i", voice, "-stream_loop", "-1", "-i", a.music, "-i", a.sting, "-filter_complex", fc, "-t", f"{a.total}", "-c:a", "pcm_f32le", mix)
        peak = a.peak
        for _ in range(3):
            loudnorm_two_pass(mix, a.output, a.lufs, peak)
            l, tp = delivered(a.output)
            if abs(l - a.lufs) <= 0.5 and tp <= a.peak + 0.1:
                break
            peak -= 0.5
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("lines start at " + ", ".join(f"{s + 0.05:.2f}" for s in starts) + f" s; sting at {latest:.2f} s; total {duration(a.output):.2f} s")
    print(f"delivered: {l} LUFS integrated, true peak {tp} dBTP -> {a.output}")
    sys.exit(0 if abs(l - a.lufs) <= 0.5 and tp <= a.peak + 0.1 else 1)


if __name__ == "__main__":
    main()
