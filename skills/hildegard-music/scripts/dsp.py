# SPDX-License-Identifier: AGPL-3.0-only
"""Shared DSP for sfx.py and music.py. Python 3.10+, standard library plus numpy. Not run on its own.

Everything here is vectorized: filters are zero-phase (frequency domain, frame by frame), reverbs and plucked strings
run one delay-length block at a time, and loudness is ITU-R BS.1770 (K-weighting, 400 ms blocks, two gates).
"""
import difflib
import math
import os
import shutil
import subprocess
import tempfile
import wave

import numpy as np

SR = 44100

# ---------------------------------------------------------------- units and notes

NOTE_PC = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}


def db_to_lin(db):
    return 10.0 ** (np.asarray(db, dtype=float) / 20.0) if not isinstance(db, (int, float)) else 10.0 ** (db / 20.0)


def lin_to_db(x):
    return 20.0 * math.log10(max(float(x), 1e-12))


def note_to_midi(name):
    """'A4' -> 69, 'C#3' -> 49, 'Bb2' -> 46. Returns None when it is not a note name."""
    s = str(name).strip()
    if len(s) < 2 or s[0].lower() not in NOTE_PC:
        return None
    pc = NOTE_PC[s[0].lower()]
    i = 1
    while i < len(s) and s[i] in "#b":
        pc += 1 if s[i] == "#" else -1
        i += 1
    try:
        octave = int(s[i:])
    except ValueError:
        return None
    return 12 * (octave + 1) + pc


def midi_to_hz(m):
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=float) - 69.0) / 12.0)


def freq_value(v):
    """A number is Hz, a string is a note name. Returns Hz or None."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        m = note_to_midi(v)
        if m is not None:
            return float(midi_to_hz(m))
    return None


# ---------------------------------------------------------------- schema validation (for --check)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def validate(obj, spec, path, errs):
    """spec is ('num', lo, hi) | ('int', lo, hi) | ('enum', [..]) | ('str',) | ('bool',) | ('any',) |
    ('freq', lo, hi) a number of Hz or a note name | ('pts', lo, hi) a list of [seconds, value] |
    ('list', itemspec, minlen, maxlen) | ('obj', {field: spec}, [required]) | ('numpts', lo, hi) a number or points.
    Appends '<path>: <problem>' strings to errs."""
    kind = spec[0]
    if kind == "any":
        return
    if kind in ("num", "int"):
        lo, hi = spec[1], spec[2]
        if not _is_num(obj) or (kind == "int" and int(obj) != obj):
            errs.append(f"{path}: {obj!r} is not {'a whole number' if kind == 'int' else 'a number'}")
        elif obj < lo or obj > hi:
            errs.append(f"{path}: {obj} is out of range {lo} to {hi}")
    elif kind == "freq":
        v = freq_value(obj)
        if v is None:
            errs.append(f"{path}: {obj!r} is not a frequency in Hz or a note name like \"A3\"")
        elif v < spec[1] or v > spec[2]:
            errs.append(f"{path}: {obj} is out of range {spec[1]} to {spec[2]} Hz")
    elif kind == "enum":
        if obj not in spec[1]:
            near = difflib.get_close_matches(str(obj), [str(x) for x in spec[1]], 1)
            errs.append(f"{path}: {obj!r} is not one of {', '.join(map(str, spec[1]))}" + (f" (did you mean {near[0]}?)" if near else ""))
    elif kind == "str":
        if not isinstance(obj, str):
            errs.append(f"{path}: {obj!r} is not text")
    elif kind == "bool":
        if not isinstance(obj, bool):
            errs.append(f"{path}: {obj!r} is not true or false")
    elif kind == "pts":
        if not isinstance(obj, list) or len(obj) < 2:
            errs.append(f"{path}: needs a list of at least two [seconds, value] pairs")
            return
        last = -1.0
        for i, p in enumerate(obj):
            if not (isinstance(p, list) and len(p) == 2 and _is_num(p[0]) and _is_num(p[1])):
                errs.append(f"{path}[{i}]: {p!r} is not a [seconds, value] pair")
                continue
            if p[0] < last:
                errs.append(f"{path}[{i}]: times must not go backwards")
            last = p[0]
            if p[1] < spec[1] or p[1] > spec[2]:
                errs.append(f"{path}[{i}]: {p[1]} is out of range {spec[1]} to {spec[2]}")
    elif kind == "numpts":
        if isinstance(obj, list):
            validate(obj, ("pts", spec[1], spec[2]), path, errs)
        else:
            validate(obj, ("num", spec[1], spec[2]), path, errs)
    elif kind == "list":
        if not isinstance(obj, list):
            errs.append(f"{path}: {obj!r} is not a list")
            return
        if len(obj) < spec[2] or len(obj) > spec[3]:
            errs.append(f"{path}: has {len(obj)} items, needs {spec[2]} to {spec[3]}")
        for i, item in enumerate(obj[: spec[3]]):
            validate(item, spec[1], f"{path}[{i}]", errs)
    elif kind == "obj":
        if not isinstance(obj, dict):
            errs.append(f"{path}: {obj!r} is not an object")
            return
        fields = spec[1]
        for k in obj:
            if k not in fields:
                near = difflib.get_close_matches(k, list(fields), 1)
                errs.append(f"{path}.{k}: unknown field" + (f" (did you mean {near[0]}?)" if near else f" (allowed: {', '.join(fields)})"))
        for r in spec[2]:
            if r not in obj:
                errs.append(f"{path}: missing required field {r!r}")
        for k, v in obj.items():
            if k in fields:
                validate(v, fields[k], f"{path}.{k}", errs)


# ---------------------------------------------------------------- envelopes and curves


def adsr(n, a, d, s, r):
    """Amplitude envelope of n samples: attack a s (linear), decay d s to level s, hold, release r s to zero at the end."""
    env = np.ones(n)
    na = min(int(a * SR), n)
    nr = min(int(r * SR), max(n - na, 0))
    nd = min(int(d * SR), max(n - na - nr, 0))
    if na > 0:
        env[:na] = np.linspace(0.0, 1.0, na, endpoint=False)
    if nd > 0:
        x = np.linspace(0.0, 1.0, nd, endpoint=False)
        env[na : na + nd] = s + (1.0 - s) * (1.0 - x) ** 2
    hold_end = n - nr
    if hold_end > na + nd:
        env[na + nd : hold_end] = s
    elif na + nd > n - nr:
        env[na + nd :] = s
    if nr > 0:
        x = np.linspace(0.0, 1.0, nr, endpoint=False)
        env[n - nr :] = env[n - nr] * (1.0 - x) ** 2
    if n > 0:
        env[-1] = 0.0
    return env


def points_curve(n, pts, geometric=False, start=0.0):
    """Per-sample values of [[seconds, value], ...] over n samples; flat before the first and after the last point."""
    t = (np.arange(n) / SR) - start
    xs = np.array([p[0] for p in pts], dtype=float)
    ys = np.array([p[1] for p in pts], dtype=float)
    if geometric:
        return np.exp(np.interp(t, xs, np.log(np.maximum(ys, 1e-4))))
    return np.interp(t, xs, ys)


def fade_edges(x, fin=0.002, fout=0.004):
    """Short fades so a clipped-out sound never clicks. Works on 1-D or [n, ch]."""
    n = len(x)
    if n == 0:
        return x
    x = x.copy()
    ni = min(int(fin * SR), n)
    no = min(int(fout * SR), n)
    if ni > 1:
        w = np.linspace(0.0, 1.0, ni)
        x[:ni] *= w if x.ndim == 1 else w[:, None]
    if no > 1:
        w = np.linspace(1.0, 0.0, no)
        x[n - no :] *= w if x.ndim == 1 else w[:, None]
    return x


# ---------------------------------------------------------------- oscillators and noise


def _blep(t, dt):
    out = np.zeros_like(t)
    m = t < dt
    x = t[m] / dt[m]
    out[m] = x + x - x * x - 1.0
    m = t > 1.0 - dt
    x = (t[m] - 1.0) / dt[m]
    out[m] = x * x + x + x + 1.0
    return out


def oscillator(kind, f, pw=0.5, phase0=0.0):
    """kind: sine, triangle, saw, square. f is Hz per sample. Saw and square are band-limited (PolyBLEP)."""
    f = np.minimum(np.asarray(f, dtype=float), SR * 0.45)
    ph = (np.cumsum(f) / SR + phase0)
    t = ph % 1.0
    dt = np.maximum(f / SR, 1e-9)
    if kind == "sine":
        return np.sin(2 * np.pi * ph)
    if kind == "triangle":
        return 4.0 * np.abs(t - 0.5) - 1.0
    if kind == "saw":
        return (2.0 * t - 1.0) - _blep(t, dt)
    if kind == "square":
        y = np.where(t < pw, 1.0, -1.0)
        return y + _blep(t, dt) - _blep((t - pw) % 1.0, dt)
    raise ValueError(kind)


def fm_pair(f, ratio, index):
    """Carrier at f, modulator at f*ratio. index is a number or a per-sample array."""
    f = np.minimum(np.asarray(f, dtype=float), SR * 0.45)
    pc = np.cumsum(f) / SR
    pm = np.cumsum(f * ratio) / SR
    return np.sin(2 * np.pi * pc + index * np.sin(2 * np.pi * pm))


def noise(kind, n, rng):
    """white, pink or brown noise with a standard deviation near 0.25."""
    w = rng.standard_normal(n)
    if kind == "white":
        return w * 0.25
    pad = 1 << int(math.ceil(math.log2(max(n, 16))))
    spec = np.fft.rfft(w, pad)
    f = np.fft.rfftfreq(pad, 1.0 / SR)
    f[0] = f[1]
    spec *= 1.0 / (np.sqrt(f) if kind == "pink" else f)
    spec[0] = 0.0
    y = np.fft.irfft(spec, pad)[:n]
    sd = float(np.std(y)) or 1.0
    return y / sd * 0.25


def resample_by(x, ratio):
    """Play x back `ratio` times faster (pitch up). Linear interpolation, fine for small ratios and for noise."""
    n = len(x)
    if n < 2:
        return x
    m = max(int(n / ratio), 1)
    return np.interp(np.arange(m) * ratio, np.arange(n), x)


def read_audio(path):
    """Mono float array at SR from a WAV (any common PCM depth) or, with ffmpeg, any other audio file."""
    try:
        with wave.open(path, "rb") as w:
            ch, sw, sr, nf = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
            raw = w.readframes(nf)
        if sw == 1:
            a = (np.frombuffer(raw, np.uint8).astype(np.float64) - 128.0) / 128.0
        elif sw == 2:
            a = np.frombuffer(raw, "<i2").astype(np.float64) / 32768.0
        elif sw == 3:
            b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
            v = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
            v = np.where(v >= 1 << 23, v - (1 << 24), v)
            a = v.astype(np.float64) / 8388608.0
        elif sw == 4:
            a = np.frombuffer(raw, "<i4").astype(np.float64) / 2147483648.0
        else:
            raise wave.Error("sample width")
        a = a.reshape(-1, ch).mean(axis=1)
    except (wave.Error, EOFError):
        if not shutil.which("ffmpeg"):
            raise ValueError(f"{path}: not a plain PCM WAV, and ffmpeg is not installed to decode it")
        r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True)
        if r.returncode:
            raise ValueError(f"{path}: ffmpeg could not read it")
        return np.frombuffer(r.stdout, np.float32).astype(np.float64)
    if sr != SR:
        a = np.interp(np.arange(int(len(a) * SR / sr)) * (sr / SR), np.arange(len(a)), a)
    return a


def fast_len(n):
    """The next length at or above n whose only prime factors are 2, 3 and 5 (a fast FFT size, smaller than a power of two)."""
    best = 1 << max(int(n - 1).bit_length(), 1)
    p5 = 1
    while p5 < best:
        p35 = p5
        while p35 < best:
            m = p35
            while m < n:
                m *= 2
            best = min(best, m)
            p35 *= 3
        p5 *= 5
    return best


# ---------------------------------------------------------------- filters (zero-phase, frame by frame)


def _resp(kind, fc, q, freqs, poles):
    r = freqs[None, :] / np.maximum(fc[:, None], 1.0)
    r2 = r * r
    den = np.sqrt((1.0 - r2) ** 2 + (r / q) ** 2) + 1e-12
    if kind == "lowpass":
        h = 1.0 / den
    elif kind == "highpass":
        h = r2 / den
    else:
        h = (r / q) / den
    return h * h if poles == 4 else h


def filt(x, kind, cutoff, q=0.707, poles=2):
    """Low-, high- or band-pass with a cutoff that can move: cutoff is Hz or an array of Hz per sample.
    2 poles is 12 dB per octave, 4 poles is 24. Resonance q above 1 peaks at the cutoff. Zero phase."""
    n = len(x)
    if n == 0:
        return x
    nfft, hop = 2048, 512
    cut = np.broadcast_to(np.asarray(cutoff, dtype=float), (n,))
    xp = np.zeros(nfft + n + 2 * nfft)
    xp[nfft : nfft + n] = x
    nframes = (len(xp) - nfft) // hop + 1
    win = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(nfft) / nfft))
    freqs = np.fft.rfftfreq(nfft, 1.0 / SR)
    ob = np.zeros((nframes + 3, hop))
    centers = np.clip(np.arange(nframes) * hop + nfft // 2 - nfft, 0, n - 1)
    step = 400
    for s in range(0, nframes, step):
        e = min(s + step, nframes)
        idx = (np.arange(s, e) * hop)[:, None] + np.arange(nfft)[None, :]
        fr = xp[idx] * win
        h = _resp(kind, cut[centers[s:e]], q, freqs, poles)
        y = np.fft.irfft(np.fft.rfft(fr, axis=1) * h, nfft, axis=1) * win
        y = y.reshape(e - s, 4, hop)
        for k in range(4):
            ob[s + k : e + k] += y[:, k, :]
    out = ob.reshape(-1)[: len(xp)] / 2.0
    return out[nfft : nfft + n]


def eq_curve(bands, freqs):
    """Magnitude of a list of {type, freq, gain_db, q} bands. type: peak, lowshelf, highshelf, lowcut, highcut."""
    mag = np.ones_like(freqs)
    s = 1j * np.maximum(freqs, 1e-3)
    for b in bands:
        fc = float(b["freq"])
        g = float(b.get("gain_db", 0.0))
        q = float(b.get("q", 0.707))
        r = s / fc
        A = 10.0 ** (g / 40.0)
        t = b["type"]
        if t == "peak":
            h = (r * r + r * (A / q) + 1.0) / (r * r + r / (A * q) + 1.0)
        elif t == "lowshelf":
            h = A * (r * r + (math.sqrt(A) / q) * r + A) / (A * r * r + (math.sqrt(A) / q) * r + 1.0)
        elif t == "highshelf":
            h = A * (A * r * r + (math.sqrt(A) / q) * r + 1.0) / (r * r + (math.sqrt(A) / q) * r + A)
        elif t == "lowcut":
            h = r * r / (r * r + r / 0.707 + 1.0)
        else:
            h = 1.0 / (r * r + r / 0.707 + 1.0)
        mag = mag * np.abs(h)
    return mag


_EQ_CACHE = {}


def apply_eq(x, bands):
    """Linear-phase EQ over the whole signal. x is 1-D or [n, ch]."""
    if not bands:
        return x
    n = len(x)
    size = fast_len(n + 4096)
    key = (size, repr(bands))
    mag = _EQ_CACHE.get(key)
    if mag is None:
        if len(_EQ_CACHE) > 12:
            _EQ_CACHE.clear()
        mag = _EQ_CACHE.setdefault(key, eq_curve(bands, np.fft.rfftfreq(size, 1.0 / SR)))
    if x.ndim == 1:
        return np.fft.irfft(np.fft.rfft(x, size) * mag, size)[:n]
    return np.stack([np.fft.irfft(np.fft.rfft(x[:, c], size) * mag, size)[:n] for c in range(x.shape[1])], axis=1)


# ---------------------------------------------------------------- distortion, chorus, dynamics


def distort(x, kind, drive_db, mix=1.0, bits=8, down=1):
    d = 10.0 ** (drive_db / 20.0)
    if kind == "tanh":
        y = np.tanh(x * d) / np.tanh(d)
    elif kind == "clip":
        y = np.clip(x * d, -1.0, 1.0)
        y = y / max(np.max(np.abs(y)), 1e-9)
    elif kind == "fold":
        y = np.sin(x * d * np.pi / 2.0)
    else:  # crush
        step = 2.0 / (2 ** bits)
        y = np.round(x * d / step) * step
        if down > 1:
            y = np.repeat(y[::down], down)[: len(x)]
    return x * (1.0 - mix) + y * mix


def chorus(x, rate=0.35, depth_ms=2.2, base_ms=14.0, mix=0.5, phase=0.0):
    """Mono in, stereo out: two voices with slowly moving delays, left and right 90 degrees apart."""
    n = len(x)
    t = np.arange(n) / SR
    outs = []
    for p in (phase, phase + 0.25):
        d = (base_ms + depth_ms * np.sin(2 * np.pi * (rate * t + p))) * SR / 1000.0
        idx = np.arange(n) - d
        v = np.interp(idx, np.arange(n), x, left=0.0)
        outs.append(x * (1.0 - mix * 0.5) + v * mix)
    return np.stack(outs, axis=1)


def _smooth_gr(gr, a_blocks, r_blocks):
    out = np.empty_like(gr)
    s = 0.0
    ca = math.exp(-1.0 / max(a_blocks, 1e-3))
    cr = math.exp(-1.0 / max(r_blocks, 1e-3))
    for i, g in enumerate(gr):
        c = ca if g > s else cr
        s = c * s + (1.0 - c) * g
        out[i] = s
    return out


def compress(x, thr_db=-18.0, ratio=2.0, attack_ms=20.0, release_ms=180.0, makeup_db=0.0, knee_db=6.0):
    """Feed-forward peak compressor with a soft knee, on [n, ch]. Detects on the loudest channel."""
    block = 32
    n = len(x)
    nb = (n + block - 1) // block
    pad = np.zeros((nb * block, x.shape[1]))
    pad[:n] = x
    lvl = np.abs(pad).max(axis=1).reshape(nb, block).max(axis=1)
    ldb = 20.0 * np.log10(lvl + 1e-9)
    over = ldb - thr_db
    k = max(knee_db, 1e-6)
    gr = np.where(over <= -k / 2, 0.0, np.where(over >= k / 2, over * (1 - 1 / ratio), (over + k / 2) ** 2 / (2 * k) * (1 - 1 / ratio)))
    gr = _smooth_gr(gr, attack_ms * SR / 1000.0 / block, release_ms * SR / 1000.0 / block)
    g = 10.0 ** ((makeup_db - gr) / 20.0)
    gs = np.interp(np.arange(n), (np.arange(nb) + 0.5) * block, g)
    return x * gs[:, None]


def multiband(x, edges, bands):
    """Glue compression per band on [n, ch]. edges are the crossover Hz (low, high); bands is three dicts of compress()
    arguments. The bands are split in the frequency domain and sum back to the input exactly when the ratios are 1."""
    low = apply_eq(x, [{"type": "highcut", "freq": edges[0]}])
    high = apply_eq(x, [{"type": "lowcut", "freq": edges[1]}])
    mid = x - low - high
    out = np.zeros_like(x)
    for part, kw in zip((low, mid, high), bands):
        out += compress(part, **kw) if kw.get("ratio", 1.0) > 1.0 else part
    return out


def saturate(x, drive_db, mix):
    """Soft tape-style saturation blended with the dry signal (parallel), keeping the peak level close to the input's."""
    if mix <= 0:
        return x
    d = 10.0 ** (drive_db / 20.0)
    pk = float(np.max(np.abs(x))) or 1.0
    y = np.tanh(x / pk * d) / np.tanh(d) * pk
    return x * (1.0 - mix) + y * mix


# ---------------------------------------------------------------- reverb (Freeverb layout, block-vectorized)

_COMBS = (1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617)
_ALLPASS = (556, 441, 341, 225)


def _comb(x, D, g, d):
    n = len(x)
    off = D + 1
    y = np.zeros(n + off)
    y[off:] = x
    for s in range(0, n, D):
        e = min(s + D, n)
        y[off + s : off + e] += g * ((1 - d) * y[off + s - D : off + e - D] + d * y[off + s - D - 1 : off + e - D - 1])
    return y[off:]


def _allpass(x, D, g=0.5):
    n = len(x)
    xp = np.concatenate([np.zeros(D), x])
    y = np.zeros(n + D)
    for s in range(0, n, D):
        e = min(s + D, n)
        y[D + s : D + e] = -g * xp[D + s : D + e] + xp[s:e] + g * y[s:e]
    return y[D:]


def reverb(x, room=0.6, damp=0.5, predelay_ms=15.0, highcut=7000.0, tail=None):
    """Freeverb-style reverb on a stereo [n, 2] bus. Returns only the wet signal, same length as x (or longer by tail s).
    room 0..1 sets the decay (about 0.3 s to 4 s), damp 0..1 darkens the tail."""
    n = len(x)
    extra = int((tail if tail is not None else 0.0) * SR)
    pre = int(predelay_ms * SR / 1000.0)
    total = n + extra
    g = 0.70 + 0.28 * float(np.clip(room, 0.0, 1.0))
    d = 0.5 * float(np.clip(damp, 0.0, 1.0))
    wet = np.zeros((total, 2))
    for c in range(2):
        src = np.zeros(total)
        src[pre : min(pre + n, total)] = x[: max(min(n, total - pre), 0), c]
        acc = np.zeros(total)
        spread = 23 * c
        for D in _COMBS:
            acc += _comb(src, D + spread, g, d)
        acc *= math.sqrt(1.0 - g * g) / math.sqrt(len(_COMBS))
        for D in _ALLPASS:
            acc = _allpass(acc, D + spread)
        wet[:, c] = acc
    if highcut < 20000:
        wet = np.stack([filt(wet[:, c], "lowpass", highcut, 0.707) for c in range(2)], axis=1)
    return wet


def reverb_tail_seconds(room):
    g = 0.70 + 0.28 * float(np.clip(room, 0.0, 1.0))
    return min(8.0, 1116.0 / SR * 6.9 / max(-math.log(g), 1e-3))  # time for the loop to fall 60 dB


# ---------------------------------------------------------------- loudness (ITU-R BS.1770-4) and true peak


def _k_filters():
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = math.tan(math.pi * f0 / SR)
    Vh = 10.0 ** (G / 20.0)
    Vb = Vh ** 0.4996667741545416
    a0 = 1.0 + K / Q + K * K
    s1 = ([(Vh + Vb * K / Q + K * K) / a0, 2.0 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0], [1.0, 2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0])
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = math.tan(math.pi * f0 / SR)
    a0 = 1.0 + K / Q + K * K
    s2 = ([1.0, -2.0, 1.0], [1.0, 2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0])
    return s1, s2


_K_CACHE = {}


def k_weight(x):
    """x is [n, ch]; K-weighting by multiplying the spectrum with the two biquads' exact response."""
    n = len(x)
    size = fast_len(n + 8192)
    h = _K_CACHE.get(size)
    if h is None:
        w = 2 * np.pi * np.fft.rfftfreq(size)
        z = np.exp(-1j * w)
        h = np.ones(len(w), dtype=complex)
        for b, a in _k_filters():
            h *= (b[0] + b[1] * z + b[2] * z * z) / (a[0] + a[1] * z + a[2] * z * z)
        _K_CACHE.clear()
        _K_CACHE[size] = h
    return np.stack([np.fft.irfft(np.fft.rfft(x[:, c], size) * h, size)[:n] for c in range(x.shape[1])], axis=1)


def lufs(x):
    """Integrated loudness in LUFS (gated), or -inf for silence. Clips shorter than 400 ms are measured whole."""
    n = len(x)
    if n == 0 or float(np.max(np.abs(x))) < 1e-9:
        return -math.inf
    y = k_weight(x)
    sq = (y * y)
    blk, hop = int(0.4 * SR), int(0.1 * SR)
    if n < blk:
        z = sq.mean(axis=0).sum()
        return -0.691 + 10.0 * math.log10(max(z, 1e-20))
    cs = np.concatenate([np.zeros((1, sq.shape[1])), np.cumsum(sq, axis=0)])
    starts = np.arange(0, n - blk + 1, hop)
    z = ((cs[starts + blk] - cs[starts]) / blk).sum(axis=1)
    l = -0.691 + 10.0 * np.log10(np.maximum(z, 1e-20))
    keep = l > -70.0
    if not keep.any():
        return -math.inf
    rel = -0.691 + 10.0 * math.log10(z[keep].mean()) - 10.0
    keep = l > max(rel, -70.0)
    if not keep.any():
        return -math.inf
    return -0.691 + 10.0 * math.log10(z[keep].mean())


def _tp_kernel():
    taps, up = 48, 4
    k = np.arange(taps) - (taps - 1) / 2.0
    h = np.sinc(k / up) * np.kaiser(taps, 8.0)
    h *= up / h.sum()
    return [h[p::up] for p in range(up)]


_TP = _tp_kernel()


def true_peak_db(x):
    """Peak of the 4x oversampled signal in dBTP (BS.1770-4 style polyphase estimate)."""
    best = float(np.max(np.abs(x))) if len(x) else 0.0
    for c in range(x.shape[1]):
        for h in _TP:
            best = max(best, float(np.max(np.abs(np.convolve(x[:, c], h, mode="same")))) if len(x) else 0.0)
    return lin_to_db(best)


def _sliding_min(g, w):
    m = g.copy()
    k = 1
    while k < w:
        s = min(k, w - k)
        m[: len(m) - s] = np.minimum(m[: len(m) - s], m[s:])
        k += s
    return m


def limit(x, ceiling_db, look_ms=6.0):
    """Look-ahead peak limiter on [n, ch] so no sample goes above ceiling_db. Returns (y, max_reduction_db)."""
    c = 10.0 ** (ceiling_db / 20.0)
    pk = np.abs(x).max(axis=1)
    if len(pk) == 0:
        return x, 0.0
    if pk.max() > c * 0.5:  # detect on the 4x oversampled signal, so the true peak (not just the sample peak) stays under
        for ch in range(x.shape[1]):
            for h in _TP:
                pk = np.maximum(pk, np.abs(np.convolve(x[:, ch], h, mode="same")))
    if pk.max() <= c:
        return x, 0.0
    L = max(int(look_ms * SR / 1000.0), 2)
    g = np.where(pk > c, c / np.maximum(pk, 1e-12), 1.0)
    # pad both ends so a peak in the first milliseconds still gets its dip; the minimum is taken over 2L-1 samples around
    # each peak, then an L-long average that ends at the peak ramps the gain down before it and never exceeds g
    fwd = _sliding_min(np.concatenate([np.ones(2 * L - 2), g, np.ones(2 * L - 2)]), 2 * L - 1)
    cs = np.concatenate([[0.0], np.cumsum(fwd)])
    gain = (cs[L : L + len(x)] - cs[: len(x)]) / L
    y = x * gain[:, None]
    return y, -lin_to_db(float(gain.min()))


def master_loudness(x, target_lufs, tp_db, max_reduction_db=9.0, iters=8):
    """Gain, then limit, until the integrated loudness reaches the target with true peak under tp_db.
    Returns (y, info) where info has lufs, true_peak, gain_db, reduction_db, reached."""
    cur = lufs(x)
    if not math.isfinite(cur):
        return x, {"lufs": -math.inf, "true_peak": -math.inf, "gain_db": 0.0, "reduction_db": 0.0, "reached": False}
    gain = target_lufs - cur
    y, red = x, 0.0
    ceiling = tp_db - 0.15
    got = cur
    for _ in range(iters):
        y, red = limit(x * 10.0 ** (gain / 20.0), ceiling)
        got = lufs(y)
        err = target_lufs - got
        if abs(err) < 0.05 or red > max_reduction_db and err > 0:
            break
        gain += err
    tp = true_peak_db(y)
    if tp > tp_db:
        y, _ = limit(y, ceiling - (tp - tp_db) - 0.05)
        tp = true_peak_db(y)
        got = lufs(y)
    return y, {"lufs": got, "true_peak": tp, "gain_db": gain, "reduction_db": red, "reached": abs(got - target_lufs) <= 0.5}


# ---------------------------------------------------------------- stereo helpers and files


def pan_gains(p):
    th = (float(p) + 1.0) * math.pi / 4.0
    return math.cos(th), math.sin(th)


def width(x, w):
    """Mid/side width: 0 is mono, 1 unchanged, 2 twice as wide. Bass below 120 Hz is kept in the middle."""
    if w == 1.0:
        return x
    m = (x[:, 0] + x[:, 1]) * 0.5
    s = (x[:, 0] - x[:, 1]) * 0.5
    low = filt(s, "lowpass", 120.0, 0.707)
    s2 = low + (s - low) * w
    return np.stack([m + s2, m - s2], axis=1)


def fade(x, fin, fout):
    n = len(x)
    x = x.copy()
    ni, no = min(int(fin * SR), n), min(int(fout * SR), n)
    if ni > 1:
        x[:ni] *= (np.linspace(0.0, 1.0, ni) ** 2)[:, None]
    if no > 1:
        x[n - no :] *= (np.linspace(1.0, 0.0, no) ** 2)[:, None]
    return x


def analyze(x, known=None):
    """Facts about a rendered [n, 2] float signal (before it is clipped to a file). known may carry an already measured
    lufs and true_peak for this exact signal."""
    known = known or {}
    n = len(x)
    peak = float(np.max(np.abs(x))) if n else 0.0
    mono = x.mean(axis=1) if n else x
    active = np.where(np.abs(mono) > 10 ** (-60 / 20))[0]
    return {
        "duration_s": n / SR,
        "peak_dbfs": lin_to_db(peak),
        "true_peak_dbtp": known["true_peak"] if "true_peak" in known else true_peak_db(x) if n else -math.inf,
        "lufs": known["lufs"] if "lufs" in known else lufs(x),
        "over_samples": int(np.sum(np.abs(x) > 1.0)),
        "dc_offset": float(np.max(np.abs(x.mean(axis=0)))) if n else 0.0,
        "lead_silence_s": float(active[0] / SR) if len(active) else n / SR,
        "tail_silence_s": float((n - 1 - active[-1]) / SR) if len(active) else n / SR,
        "silent": peak < 10 ** (-60 / 20),
        "correlation": float(np.corrcoef(x[:, 0], x[:, 1])[0, 1]) if n > 1 and np.std(x[:, 0]) > 1e-9 and np.std(x[:, 1]) > 1e-9 else 1.0,
    }


def json_safe(v):
    """The same structure with infinities and NaN (silence has -inf LUFS) turned into null, so the JSON is valid."""
    if isinstance(v, dict):
        return {k: json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [json_safe(x) for x in v]
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def write_audio(path, x, bits=16):
    """Write [n, 2] floats. .wav by the wave module; .mp3 and .ogg through ffmpeg. Values beyond +-1 are clipped."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".wav", ".mp3", ".ogg"):
        raise ValueError("the output file must end in .wav, .mp3 or .ogg")
    target = path
    tmp = None
    if ext != ".wav":
        if not shutil.which("ffmpeg"):
            raise ValueError("ffmpeg is not installed, so only .wav can be written here")
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        target = tmp
    y = np.clip(x, -1.0, 1.0)
    if bits == 24:
        v = np.round(y * 8388607.0).astype("<i4")
        data = v.reshape(-1).view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
        sw = 3
    else:
        data = np.round(y * 32767.0).astype("<i2").tobytes()
        sw = 2
    with wave.open(target, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(sw)
        w.setframerate(SR)
        w.writeframes(data)
    if tmp:
        args = ["ffmpeg", "-y", "-v", "error", "-i", tmp]
        args += ["-c:a", "libmp3lame", "-b:a", "256k"] if ext == ".mp3" else ["-c:a", "libvorbis", "-q:a", "6"]
        r = subprocess.run(args + [path], capture_output=True, text=True)
        os.unlink(tmp)
        if r.returncode:
            raise ValueError("ffmpeg could not write " + path + ": " + r.stderr.strip()[-200:])


def read_wav_stereo(path):
    """Read a WAV this module wrote (or any PCM WAV) back as [n, 2] floats, for tests and checks."""
    with wave.open(path, "rb") as w:
        ch, sw, nf = w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(nf)
    if sw == 2:
        a = np.frombuffer(raw, "<i2").astype(np.float64) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
        v = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
        a = np.where(v >= 1 << 23, v - (1 << 24), v).astype(np.float64) / 8388608.0
    else:
        raise ValueError("only 16 and 24 bit")
    return a.reshape(-1, ch)
