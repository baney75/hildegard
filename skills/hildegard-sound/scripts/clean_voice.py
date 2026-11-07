#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Clean a spoken-word recording and deliver it at a loudness target.

  python3 clean_voice.py IN OUT [--lufs -16] [--peak -1.5]

IN is any audio file ffmpeg reads (mono or stereo). OUT's extension picks the format (.wav is 16-bit). The length and
the sample rate stay the same. Needs only Python 3, ffmpeg and ffprobe on PATH; no network, no other packages.

What it does, in order:
  1. rumble: a steep FIR high-pass (nothing below 85 Hz, everything above 115 Hz)
  2. hum: narrow notches at 50 Hz and 60 Hz and their first harmonics (mains is one or the other; both cost nothing)
  3. hiss: a low-pass at 10 kHz and two passes of ffmpeg's noise reducer; clicks and clipped peaks (adeclick, adeclip)
  4. near and far: dynaudnorm evens out the passages where the speaker drifted from the mic; gentle compression
  5. pauses: a gate whose threshold is measured from the file (between its floor and its speech level),
     then a little room tone so pauses are never digital silence
  6. loudness: loudnorm in two passes (measure, then apply the measured values with linear=true)
It prints the delivered loudness and true peak. Exit 0 when they are within 0.5 LU and the peak is under the limit.
"""
import argparse, json, os, re, shutil, subprocess, sys, tempfile

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")


def run(args, capture=False):
    r = subprocess.run(args, stdout=subprocess.PIPE if capture else subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit("ffmpeg failed:\n" + r.stderr[-1500:])
    return r


def ff(*a, capture=False):
    return run([FFMPEG, "-hide_banner", "-nostats", "-y", *a], capture)


def probe(path):
    r = subprocess.run([FFPROBE, "-v", "error", "-select_streams", "a:0", "-show_entries",
                        "stream=sample_rate,channels:format=duration", "-of", "json", path], capture_output=True, text=True, encoding="utf-8", errors="replace")
    d = json.loads(r.stdout or "{}")
    if not d.get("streams"):
        sys.exit(f"{path}: no audio stream")
    s = d["streams"][0]
    return int(s["sample_rate"]), int(s["channels"]), float(d["format"]["duration"])


def loudness(path):
    """Integrated loudness (LUFS) and true peak (dBTP) of a file."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    t = r.stderr[r.stderr.rfind("Summary:"):]
    i = re.search(r"I:\s+(-?[\d.]+) LUFS", t)
    p = re.search(r"Peak:\s+(-?[\d.]+) dBFS", t)
    return (float(i.group(1)) if i else None), (float(p.group(1)) if p else None)


def loudnorm_two_pass(src, dst, target, peak, sr, codec):
    """Measure, then apply with the measured values and linear=true, so the result lands on the target."""
    base = f"loudnorm=I={target}:TP={peak}:LRA=11"
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", src, "-af", base + ":print_format=json", "-f", "null", "-"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    m = json.loads(r.stderr[r.stderr.rfind("{"):r.stderr.rfind("}") + 1])
    af = (f"{base}:measured_I={m['input_i']}:measured_TP={m['input_tp']}:measured_LRA={m['input_lra']}"
          f":measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
    ff("-i", src, "-af", af, "-ar", str(sr), *codec, dst)


def codec_for(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".wav":
        return ["-c:a", "pcm_s16le"]
    if ext == ".mp3":
        return ["-c:a", "libmp3lame", "-b:a", "192k"]
    return []


def pause_gate_threshold(path):
    """Linear gate threshold between the file's floor (10th percentile of 100 ms RMS) and its speech level (90th)."""
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af",
                        "asetnsamples=n=4410:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
                        "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace")
    lv = sorted(float(x) for x in re.findall(r"RMS_level=(-?[\d.]+)", r.stdout))
    if len(lv) < 10:
        return 0.01
    floor, speech = lv[len(lv) // 10], lv[len(lv) * 9 // 10]
    t = floor + (speech - floor) * 0.3
    t = max(t, floor + 4)
    t = min(t, speech - 15)
    t = max(t, floor)
    return min(1.0, max(0.001, 10 ** (t / 20)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--lufs", type=float, default=-16.0, help="target integrated loudness (default -16)")
    ap.add_argument("--peak", type=float, default=-1.5, help="true-peak ceiling in dBTP (default -1.5)")
    a = ap.parse_args()
    if not (FFMPEG and FFPROBE):
        sys.exit("ffmpeg and ffprobe must be on PATH")
    sr, ch, dur = probe(a.input)
    layout = "stereo" if ch >= 2 else "mono"
    codec = codec_for(a.output)
    tmp = tempfile.mkdtemp(prefix="clean-voice-")
    try:
        hum = "".join(f",bandreject=f={f}:width_type=q:w=25" for f in (50, 60, 100, 120, 150, 180, 200, 240, 250, 300))
        # The FIR delays the sound 0.1 s and each denoiser 0.025 s; trim that back so the length and timing stay the same.
        rumble = ("firequalizer=gain_entry='entry(0,-100);entry(85,-100);entry(115,0);entry(24000,0)':delay=0.1:accuracy=1,"
                  "atrim=start=0.1,asetpts=PTS-STARTPTS")
        chain = (f"{rumble}{hum},lowpass=f=10000,adeclick,adeclip,afftdn=nr=30:nf=-35:tn=1,afftdn=nr=30:nf=-45:tn=1,"
                 f"atrim=start=0.05,asetpts=PTS-STARTPTS,apad=whole_dur={dur:.3f},"
                 "dynaudnorm=f=200:g=15:p=0.9:m=14:s=5,"
                 "acompressor=threshold=-21dB:ratio=3:attack=8:release=160:makeup=2")
        s1 = os.path.join(tmp, "s1.wav")
        ff("-i", a.input, "-af", chain, "-t", f"{dur:.3f}", "-ar", str(sr), "-c:a", "pcm_f32le", s1)
        thr = pause_gate_threshold(s1)
        s2 = os.path.join(tmp, "s2.wav")
        ff("-i", s1, "-f", "lavfi", "-i", f"anoisesrc=color=pink:amplitude=0.004:sample_rate={sr}:duration={dur:.3f}",
           "-filter_complex",
           f"[0:a]agate=threshold={thr:.4f}:ratio=4:range=0.03:attack=5:release=250:detection=rms[a];"
           f"[1:a]aformat=channel_layouts={layout}[n];[a][n]amix=inputs=2:duration=first:normalize=0",
           "-ar", str(sr), "-c:a", "pcm_f32le", s2)
        peak = a.peak
        for attempt in range(3):
            loudnorm_two_pass(s2, a.output, a.lufs, peak, sr, codec)
            lufs, tp = loudness(a.output)
            if lufs is not None and tp is not None and abs(lufs - a.lufs) <= 0.5 and tp <= a.peak + 0.1:
                break
            peak -= 0.5  # missed: ask the second pass for a little more headroom and try again
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"delivered: {lufs} LUFS integrated, true peak {tp} dBTP, {dur:.2f} s, {sr} Hz, {ch} ch -> {a.output}")
    ok = lufs is not None and abs(lufs - a.lufs) <= 0.5 and tp is not None and tp <= a.peak + 0.1
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
