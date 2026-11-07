# SPDX-License-Identifier: AGPL-3.0-only
"""Test-side audio: makes noisy speech-like clips and films, and measures files on its own, so a test never grades
tools/voice_clean.py with the code it is grading. Loudness is ITU-R BS.1770-4 written out in numpy (K-weighting,
400 ms blocks, both gates); true peak is a 4x oversampled peak.

    python audio_check.py speech OUT SECONDS [SEED]       noisy speech-like WAV (hum, hiss, bursts), 48 kHz mono
    python audio_check.py video OUT SECONDS [SEED]        the same as a clip's sound, under a moving picture (.mp4 or .webm)
    python audio_check.py film OUT SECONDS [LEVEL] [HZ]  a picture with a steady tone for sound, 440 Hz unless told (.mp4)
    python audio_check.py measure FILE                    {"lufs", "true_peak", "seconds"}
    python audio_check.py band FILE HZ T0 T1              level of one frequency between T0 and T1 seconds, in dBFS
    python audio_check.py info FILE                       {"types", "seconds", "audio_seconds", "channels"}
"""

import json
import sys
from fractions import Fraction

import av
import numpy as np

RATE = 48000


def speechlike(seconds, seed=0, level=0.25):
    rng = np.random.default_rng(seed)
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    f0 = 130 + 20 * np.sin(2 * np.pi * 0.7 * t)
    phase = np.cumsum(2 * np.pi * f0 / RATE)
    voice = sum(np.sin(k * phase) / k for k in range(1, 25))
    env = np.zeros(n)
    pos = 0.2
    while pos < seconds - 0.4:
        d = rng.uniform(0.15, 0.4)
        i0, i1 = int(pos * RATE), int((pos + d) * RATE)
        env[i0:i1] = np.hanning(i1 - i0)
        pos += d + rng.uniform(0.05, 0.35)
    hiss = rng.standard_normal(n) * 0.01
    hum = 0.02 * np.sin(2 * np.pi * 60 * t) + 0.01 * np.sin(2 * np.pi * 120 * t)
    return (voice * env * level + hiss + hum).astype(np.float32)


def write_wav(path, x):
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2")
    with av.open(path, "w", format="wav") as c:
        s = c.add_stream("pcm_s16le", rate=RATE, layout="mono")
        for i in range(0, len(pcm), 4096):
            fr = av.AudioFrame.from_ndarray(pcm[None, i : i + 4096], format="s16", layout="mono")
            fr.sample_rate, fr.pts, fr.time_base = RATE, i, Fraction(1, RATE)
            for p in s.encode(fr):
                c.mux(p)
        for p in s.encode():
            c.mux(p)


def write_av(path, seconds, audio, fps=24):
    """A moving picture with `audio` ((channels, n) float32) for sound, as mp4 (AAC) or webm (VP8, Opus)."""
    webm = path.endswith(".webm")
    with av.open(path, "w") as c:
        v = c.add_stream("libvpx" if webm else "libx264", rate=fps)
        v.width, v.height, v.pix_fmt = 320, 180, "yuv420p"
        a = c.add_stream("libopus" if webm else "aac", rate=RATE, layout="stereo" if audio.shape[0] == 2 else "mono")
        for i in range(round(seconds * fps)):
            f = av.VideoFrame.from_ndarray(np.full((180, 320, 3), (i * 5) % 255, np.uint8), format="rgb24")
            f.pts = i
            f.time_base = Fraction(1, fps)
            for p in v.encode(f):
                c.mux(p)
        for p in v.encode():
            c.mux(p)
        size = a.codec_context.frame_size or 1024
        layout = "stereo" if audio.shape[0] == 2 else "mono"
        fifo = av.AudioFifo()
        fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(audio), format="fltp", layout=layout)
        fr.sample_rate = RATE
        fifo.write(fr)
        pts = 0
        while fifo.samples > 0:
            out = fifo.read(min(size, fifo.samples))
            out.pts, out.time_base = pts, Fraction(1, RATE)
            pts += out.samples
            for p in a.encode(out):
                c.mux(p)
        for p in a.encode():
            c.mux(p)


def decode(path):
    parts = []
    with av.open(path) as c:
        rs = None
        for fr in c.decode(c.streams.audio[0]):
            if rs is None:
                rs = av.AudioResampler(format="fltp", layout=fr.layout.name, rate=RATE)
            for f in rs.resample(fr):
                parts.append(f.to_ndarray())
    return np.concatenate(parts, axis=1).astype(np.float64)


def biquad(x, b, a):
    y = np.empty_like(x)
    x1 = x2 = y1 = y2 = 0.0
    b0, b1, b2 = b
    a1, a2 = a[1], a[2]
    for i, v in enumerate(x.tolist()):
        o = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        y[i] = o
        x2, x1, y2, y1 = x1, v, y1, o
    return y


K1 = ([1.53512485958697, -2.69169618940638, 1.19839281085285], [1.0, -1.69065929318241, 0.73248077421585])
K2 = ([1.0, -2.0, 1.0], [1.0, -1.99004745483398, 0.99007225036621])


def lufs(x):
    z = np.zeros(x.shape[1])
    for ch in x:
        k = biquad(biquad(ch, *K1), *K2)
        z_ch = k * k
        z = z + z_ch  # channel gains are 1 for left, right and mono
    block, hop = int(0.4 * RATE), int(0.1 * RATE)
    if len(z) < block:
        raise ValueError("clip shorter than one 400 ms block")
    means = np.array([z[i : i + block].mean() for i in range(0, len(z) - block + 1, hop)])
    loud = -0.691 + 10 * np.log10(means + 1e-20)
    keep = means[loud > -70]
    rel = -0.691 + 10 * np.log10(keep.mean()) - 10
    keep = means[loud > max(-70, rel)]
    return float(-0.691 + 10 * np.log10(keep.mean()))


def true_peak(x):
    peak = 0.0
    for ch in x:
        n = len(ch)
        up = np.fft.irfft(np.fft.rfft(ch), n * 4) * 4
        peak = max(peak, float(np.abs(up).max()))
    return float(20 * np.log10(peak + 1e-12))


def band(x, hz, t0, t1):
    seg = np.mean(x, axis=0)[int(t0 * RATE) : int(t1 * RATE)]
    n = len(seg)
    w = np.hanning(n)
    tt = np.arange(n) / RATE
    # The size of one sine at `hz` in the segment, by correlation (a Goertzel): a full-scale sine reads 0 dBFS.
    c = np.sum(seg * w * np.exp(-2j * np.pi * hz * tt)) * 2 / np.sum(w)
    return float(20 * np.log10(abs(c) + 1e-12))


def main(argv):
    cmd = argv[1]
    if cmd == "speech":
        write_wav(argv[2], speechlike(float(argv[3]), int(argv[4]) if len(argv) > 4 else 0))
    elif cmd == "video":
        s = speechlike(float(argv[3]), int(argv[4]) if len(argv) > 4 else 0)
        write_av(argv[2], float(argv[3]), s[None, :])
    elif cmd == "film":
        seconds, level = float(argv[3]), float(argv[4]) if len(argv) > 4 else 0.2
        hz = float(argv[5]) if len(argv) > 5 else 440.0
        t = np.arange(int(seconds * RATE)) / RATE
        tone = (level * np.sin(2 * np.pi * hz * t)).astype(np.float32)
        write_av(argv[2], seconds, np.stack([tone, tone]))
    elif cmd == "measure":
        x = decode(argv[2])
        print(json.dumps({"lufs": lufs(x), "true_peak": true_peak(x), "seconds": x.shape[1] / RATE}))
    elif cmd == "band":
        print(json.dumps({"db": band(decode(argv[2]), float(argv[3]), float(argv[4]), float(argv[5]))}))
    elif cmd == "info":
        with av.open(argv[2]) as c:
            types = [s.type for s in c.streams]
            dur = float(c.duration / av.time_base) if c.duration else None
            ch = c.streams.audio[0].channels if c.streams.audio else 0
        x = decode(argv[2]) if "audio" in types else np.zeros((1, 0))
        print(json.dumps({"types": types, "seconds": dur, "audio_seconds": x.shape[1] / RATE, "channels": ch}))
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv)
