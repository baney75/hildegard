#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Render long, seamless, non-repeating audio: binaural beats, isochronic tones and nature beds. Python 3.10+,
standard library plus numpy; ffmpeg only for .mp3 and .ogg.

  python3 soundscape.py recipe.json out.wav [--check]   render (a bare preset name like "ocean_beach" works too)
  python3 soundscape.py recipe.json --check             validate and measure a few sample windows; writes nothing
  python3 soundscape.py --preset ocean_beach out.wav --minutes 30
  python3 soundscape.py --list
  options: --minutes M or --seconds S (replace the length), --seed N, --chunk S, --bits 16|24, --json, --sheet out.png

Every layer is a function of absolute time with deterministic, block-seeded randomness, so a file is rendered in
chunks of --chunk seconds (default 30) with flat memory, the chunks join without a seam (a chunked render is bit for
bit the same as one pass), and nothing repeats: a one-hour file is not a loop. Loudness is measured as it is written
(ITU-R BS.1770, streaming) and corrected to the target; the true peak stays under the limit. Binaural beats need
headphones: each ear hears a different pure tone and the beat exists only in the listener's head. No health claim is
made for any of it. --check reports unknown fields, values out of range, clipping, loudness off target, silence, DC
offset and a length that is not the one asked for, and for binaural layers measures the beat frequency from the file.
"""
import argparse
import glob
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import dsp  # noqa: E402
from dsp import SR  # noqa: E402

HOP, NFFT = 2048, 4096
CTX = 4 * HOP  # context rendered on each side of a chunk: filters, kernels and the limiter see across the join
FREQ = np.fft.rfftfreq(NFFT, 1.0 / SR)
WIN = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(NFFT) / NFFT))
BLK = 1 << 15
DEC = 441  # envelope decimation: slow controls are computed every 10 ms and interpolated
TYPES = ["binaural", "isochronic", "noise", "waves", "rain", "wind", "creek", "crickets", "fire", "pad"]

# ---------------------------------------------------------------- schema

PTS = ("pts", -80, 12)
STAGE = ("obj", {
    "beat_hz": ("num", 0.5, 40), "rate_hz": ("num", 0.5, 40), "carrier_hz": ("num", 50, 1000),
    "seconds": ("num", 0.05, 86400), "minutes": ("num", 0.001, 1440),
}, [])
LAYER = ("obj", {
    "type": ("enum", TYPES), "gain_db": ("num", -60, 12), "automation": ("any",),
    "carrier_hz": ("num", 50, 1000), "beat_hz": ("num", 0.5, 40), "rate_hz": ("num", 0.5, 40), "stages": ("list", STAGE, 1, 64),
    "ramp_s": ("num", 1, 600), "split": ("enum", ["symmetric", "right"]), "duty": ("num", 0.1, 0.9), "softness": ("num", 0.05, 1),
    "depth": ("num", 0.2, 1),
    "color": ("enum", ["white", "pink", "brown"]), "lowpass": ("num", 100, 20000), "highpass": ("num", 10, 10000), "width": ("num", 0, 1),
    "period_s": ("num", 4, 24), "intensity": ("any",), "foam": ("num", 0, 1), "distance": ("num", 0, 1),
    "surface": ("enum", ["roof", "leaves", "ground", "window"]), "strength": ("num", 0, 1), "gustiness": ("num", 0, 1),
    "whistle": ("num", 0, 1), "flow": ("num", 0, 1), "brightness": ("num", 0, 1), "count": ("int", 1, 12),
    "pitch_hz": ("num", 2500, 6500), "tempo": ("num", 0.5, 2), "roar": ("num", 0, 1), "crackle": ("num", 0, 1),
    "notes": ("list", ("freq", 30, 2000), 1, 8), "motion": ("num", 0, 1),
}, ["type"])
ONLY = {
    "binaural": {"carrier_hz", "beat_hz", "stages", "ramp_s", "split"},
    "isochronic": {"carrier_hz", "rate_hz", "stages", "ramp_s", "duty", "softness", "depth"},
    "noise": {"color", "lowpass", "highpass", "width"},
    "waves": {"period_s", "intensity", "foam", "distance", "width"},
    "rain": {"intensity", "surface"},
    "wind": {"strength", "gustiness", "whistle"},
    "creek": {"flow", "brightness"},
    "crickets": {"count", "pitch_hz", "tempo", "distance"},
    "fire": {"roar", "crackle"},
    "pad": {"notes", "brightness", "motion"},
}
COMMON = {"type", "gain_db", "automation"}
RECIPE = ("obj", {
    "name": ("str",), "note": ("str",), "vary": ("list", ("str",), 0, 12), "seed": ("int", 0, 2**31 - 1),
    "minutes": ("num", 0.05, 1440), "seconds": ("num", 3, 86400),
    "layers": ("list", LAYER, 1, 16),
    "master": ("obj", {
        "loudness": ("obj", {"lufs": ("num", -40, -6), "true_peak": ("num", -6, 0)}, []),
        "fade": ("obj", {"in": ("num", 0, 600), "out": ("num", 0, 600)}, []), "chunk_s": ("num", 4, 120), "gain_db": ("num", -60, 24),
    }, []),
}, ["layers"])
DEFAULT_LUFS, DEFAULT_TP = -20.0, -1.0

# ---------------------------------------------------------------- deterministic randomness by absolute position


def u01(seed, idx):
    """Uniform [0, 1) from an integer seed and an array of integer positions (a counter hash: any position, any order)."""
    with np.errstate(over="ignore"):
        z = np.asarray(idx).astype(np.uint64) + np.uint64(seed & 0xFFFFFFFF) * np.uint64(0x9E3779B97F4A7C15)
        z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        z = z ^ (z >> np.uint64(31))
    return (z >> np.uint64(11)).astype(np.float64) / float(1 << 53)


def vnoise(t, seed, rate):
    """Smooth value noise in [0, 1] at `rate` knots per second, a function of absolute time t (seconds)."""
    x = np.asarray(t, dtype=float) * rate
    k = np.floor(x)
    f = x - k
    k = k.astype(np.int64) + (1 << 30)
    s = f * f * (3.0 - 2.0 * f)
    a = u01(seed, k)
    return a + (u01(seed, k + 1) - a) * s


def smoothstep(x):
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


class White:
    """White noise (standard deviation 1) as a function of absolute sample position, made of seeded blocks."""

    def __init__(self, seed, key):
        self.seed, self.key, self.cache = seed, key, {}

    def block(self, b):
        v = self.cache.get(b)
        if v is None:
            if len(self.cache) > 6:
                self.cache.clear()
            v = self.cache.setdefault(b, np.random.default_rng([self.seed, self.key, b + (1 << 30)]).standard_normal(BLK))
        return v

    def get(self, a, n):
        b0, b1 = a // BLK, (a + n - 1) // BLK
        parts = [self.block(b) for b in range(b0, b1 + 1)]
        x = np.concatenate(parts) if len(parts) > 1 else parts[0]
        o = a - b0 * BLK
        return x[o : o + n]


def shaped(white, a, n, mag_fn):
    """Noise for samples [a, a+n) with a spectrum set by mag_fn(frame_center_samples, freqs) -> [frames or 1, bins].
    The frame grid is anchored at absolute sample 0, so the result does not depend on where a chunk starts."""
    w0 = ((a - CTX) // HOP) * HOP
    w1 = -((-(a + n + CTX)) // HOP) * HOP
    x = white.get(w0, w1 - w0)
    nf = (w1 - w0 - NFFT) // HOP + 1
    ob = np.zeros((nf + 1, HOP))
    for s in range(0, nf, 256):
        e = min(s + 256, nf)
        idx = (np.arange(s, e) * HOP)[:, None] + np.arange(NFFT)[None, :]
        centers = w0 + np.arange(s, e) * HOP + NFFT // 2
        h = np.array(mag_fn(centers, FREQ), dtype=float)
        h[:, 0] = 0.0
        h = h / np.sqrt(np.mean(h * h, axis=1, keepdims=True) + 1e-12)
        y = np.fft.irfft(np.fft.rfft(x[idx] * WIN, axis=1) * h, NFFT, axis=1) * WIN
        y = y.reshape(e - s, 2, HOP)
        for k in range(2):
            ob[s + k : e + k] += y[:, k, :]
    out = ob.reshape(-1)[: w1 - w0]
    o = a - w0
    return out[o : o + n]


def _lp(f, fc, order=2):
    return 1.0 / np.sqrt(1.0 + (f / np.maximum(fc, 1.0)) ** (2 * order))


def _hp(f, fc, order=2):
    r = (f / np.maximum(fc, 1.0)) ** (2 * order)
    return np.sqrt(r / (1.0 + r))


def band_shape(lo=None, hi=None, order=2, tilt=0.0, fc_lo=None, fc_hi=None):
    """A mag_fn: optional high-pass at lo and low-pass at hi (Hz, scalars or functions of the frame centers in
    seconds), and a spectral tilt (power law: -0.5 pink, -1 brown)."""

    def fn(centers, f):
        t = centers / SR
        l = lo(t)[:, None] if callable(lo) else lo
        h = hi(t)[:, None] if callable(hi) else hi
        m = np.ones((1, len(f)))
        if tilt:
            m = m * (np.maximum(f, 25.0)[None, :] / 1000.0) ** tilt
        if l is not None:
            m = m * _hp(f[None, :], l, order)
        if h is not None:
            m = m * _lp(f[None, :], h, order)
        return m if m.shape[0] > 1 else np.broadcast_to(m, (len(centers), len(f)))

    return fn


# ---------------------------------------------------------------- schedules: holds and smooth ramps, with exact phase


class Sched:
    """A value that holds and then glides (smoothstep) between stages; integral() is exact, so a tone's phase is exact."""

    def __init__(self, values, durations, ramp):
        self.t0, self.t1, self.v0, self.v1, self.kind, self.I = [], [], [], [], [], []
        t, acc = 0.0, 0.0
        for i, (v, d) in enumerate(zip(values, durations)):
            nxt = values[i + 1] if i + 1 < len(values) else v
            r = min(ramp, d * 0.5) if i + 1 < len(values) else 0.0
            for (a, b, x, y, k) in ((t, t + d - r, v, v, 0), (t + d - r, t + d, v, nxt, 1)):
                if b > a:
                    self.t0.append(a), self.t1.append(b), self.v0.append(x), self.v1.append(y), self.kind.append(k)
                    self.I.append(acc)
                    acc += self._seg_int(x, y, k, b - a, b - a)
            t += d
        self.t_end, self.v_end, self.I_end = t, values[-1], acc
        self.t0, self.t1, self.v0, self.v1, self.kind, self.I = (np.array(z) for z in (self.t0, self.t1, self.v0, self.v1, self.kind, self.I))

    @staticmethod
    def _seg_int(v0, v1, kind, T, tau):
        if kind == 0:
            return v0 * tau
        x = tau / T
        return v0 * tau + (v1 - v0) * T * (x**3 - x**4 / 2.0)

    def value(self, t):
        t = np.asarray(t, dtype=float)
        i = np.clip(np.searchsorted(self.t0, t, side="right") - 1, 0, len(self.t0) - 1)
        T = self.t1[i] - self.t0[i]
        x = np.clip((t - self.t0[i]) / T, 0, 1)
        v = np.where(self.kind[i] == 0, self.v0[i], self.v0[i] + (self.v1[i] - self.v0[i]) * (3 * x**2 - 2 * x**3))
        return np.where(t >= self.t_end, self.v_end, v)

    def integral(self, t):
        t = np.asarray(t, dtype=float)
        i = np.clip(np.searchsorted(self.t0, t, side="right") - 1, 0, len(self.t0) - 1)
        T = self.t1[i] - self.t0[i]
        tau = t - self.t0[i]
        x = tau / T
        seg = np.where(self.kind[i] == 0, self.v0[i] * tau, self.v0[i] * tau + (self.v1[i] - self.v0[i]) * T * (x**3 - x**4 / 2.0))
        return np.where(t >= self.t_end, self.I_end + self.v_end * (t - self.t_end), self.I[i] + seg)


def stage_sched(L, key, default, total_s):
    """Sched for a stages layer: values from stage[key] (or the layer's constant), durations in seconds."""
    stages = L.get("stages")
    if not stages:
        return Sched([float(L.get(key, default))], [total_s + 1.0], 1.0)
    vals, durs = [], []
    for s in stages:
        vals.append(float(s.get(key, L.get(key, default))))
        durs.append(float(s["seconds"] if "seconds" in s else s.get("minutes", 1) * 60.0))
    return Sched(vals, durs, float(L.get("ramp_s", 30.0)))


# ---------------------------------------------------------------- event helpers


def poisson_events(seed, a, n, rate_max, rate_fn=None, nextra=4, margin=0.5):
    """Deterministic event times (seconds) and random extras in [0, 1) for the window [a, a+n) plus `margin` seconds
    each side, made one second at a time so any window gives the same events."""
    t0, t1 = a / SR - margin, (a + n) / SR + margin
    times, extras = [], []
    for c in range(int(math.floor(t0)), int(math.ceil(t1))):
        rng = np.random.default_rng([seed, c + (1 << 20)])
        k = rng.poisson(rate_max)
        pos = c + rng.random(k)
        ex = rng.random((k, nextra))
        keep = rng.random(k) < (rate_fn(pos) / rate_max if rate_fn else 1.0)
        times.append(pos[keep])
        extras.append(ex[keep])
    if not times:
        return np.zeros(0), np.zeros((0, nextra))
    t, e = np.concatenate(times), np.concatenate(extras)
    m = (t >= t0) & (t < t1)
    return t[m], e[m]


def add_kernel(buf, a, t, kernel, gl, gr):
    s = int(round(t * SR)) - a
    e = min(s + len(kernel), len(buf))
    b = max(s, 0)
    if e <= b:
        return
    k = kernel[b - s : e - s]
    buf[b:e, 0] += k * gl
    buf[b:e, 1] += k * gr


def pan_gl_gr(p):
    th = (p + 1.0) * math.pi / 4.0
    return math.cos(th), math.sin(th)


def curve(points, t_sec, default):
    """Piecewise-linear values from [[minutes, value], ...] at times in seconds; a number is constant."""
    if isinstance(points, (int, float)):
        return np.full(np.shape(t_sec), float(points))
    if not points:
        return np.full(np.shape(t_sec), float(default))
    xs = np.array([p[0] * 60.0 for p in points])
    ys = np.array([p[1] for p in points], dtype=float)
    return np.interp(t_sec, xs, ys)


def coarse(a, n):
    """Times (seconds) on a 100 Hz grid anchored at absolute 0 that covers [a, a+n], for slow controls to interpolate."""
    a0 = (a // DEC) * DEC
    return (a0 + np.arange(0, (a + n - a0) // DEC + 2) * DEC) / SR


def tpos(a, n):
    return (a + np.arange(n)) / SR


def _stereo(x, y):
    return np.stack([x, y], axis=1)


def _kern(rng_seed, n_kernels, make):
    rng = np.random.default_rng([rng_seed, 4242])
    return [make(rng) for _ in range(n_kernels)]


# ---------------------------------------------------------------- the layers; each render(a, n) -> [n, 2]


class Binaural:
    def __init__(self, L, seed, idx, total_s):
        self.beat = stage_sched(L, "beat_hz", 10.0, total_s)
        self.car = stage_sched(L, "carrier_hz", 200.0, total_s)
        self.right_only = L.get("split") == "right"

    def render(self, a, n):
        t = tpos(a, n)
        B, F = self.beat.integral(t), self.car.integral(t)
        if self.right_only:
            pl, pr = F, F + B
        else:
            pl, pr = F - B / 2.0, F + B / 2.0
        return _stereo(np.sin(2 * np.pi * (pl % 1.0)), np.sin(2 * np.pi * (pr % 1.0))) * 0.35


class Isochronic:
    def __init__(self, L, seed, idx, total_s):
        self.rate = stage_sched(L, "rate_hz", 10.0, total_s)
        self.car = stage_sched(L, "carrier_hz", 200.0, total_s)
        self.duty, self.soft, self.depth = L.get("duty", 0.5), L.get("softness", 0.35), L.get("depth", 1.0)

    def render(self, a, n):
        t = tpos(a, n)
        x = self.rate.integral(t) % 1.0
        d, e = self.duty, max(self.soft * self.duty / 2.0, 1e-3)
        g = smoothstep(x / e) * (1.0 - smoothstep((x - (d - e)) / e)) * (x < d)
        env = 1.0 - self.depth + self.depth * g
        s = np.sin(2 * np.pi * (self.car.integral(t) % 1.0)) * env * 0.35
        return _stereo(s, s)


class Noise:
    def __init__(self, L, seed, idx, total_s):
        self.color, self.w = L.get("color", "pink"), L.get("width", 1.0)
        self.seed = seed + idx * 7919
        self.wl, self.wr, self.wc = White(self.seed, 1), White(self.seed, 2), White(self.seed, 3)
        tilt = {"white": 0.0, "pink": -0.5, "brown": -1.0}[self.color]
        self.fn = band_shape(L.get("highpass", 30.0 if self.color == "brown" else None), L.get("lowpass"), 2, tilt)

    def render(self, a, n):
        c = shaped(self.wc, a, n, self.fn)
        l, r = shaped(self.wl, a, n, self.fn), shaped(self.wr, a, n, self.fn)
        k = math.sqrt(self.w)
        m = math.sqrt(1.0 - self.w)
        t = tpos(a, n)
        drift = 10.0 ** ((vnoise(t, self.seed + 5, 0.04) - 0.5) * 3.0 / 20.0)
        return _stereo(k * l + m * c, k * r + m * c) * drift[:, None] * 0.12


def _wave_table(seed, period, total_s):
    """Wave start times and sizes for the whole piece: sets of bigger and smaller swells, with irregular gaps."""
    m = int(total_s / (0.45 * period)) + 12
    k = np.arange(m)
    gaps = period * (0.55 + 0.9 * u01(seed, k))
    starts = np.cumsum(gaps) - 3 * period
    sets = 0.55 + 0.45 * np.sin(2 * np.pi * (k / (4.0 + 3.0 * u01(seed + 1, k // 5)) + u01(seed + 2, k // 5)))
    size = np.clip(0.35 + 0.65 * (sets * 0.6 + 0.4 * u01(seed + 3, k)), 0.15, 1.0)
    dur = period * (0.85 + 0.5 * u01(seed + 4, k))
    shift = 0.3 + 1.4 * u01(seed + 5, k)
    return starts, size, dur, shift


def _bump(tau, peak, k):
    x = np.clip(tau / peak, 0.0, None)
    return np.where(tau > 0, (x * np.exp(1.0 - x)) ** k, 0.0)


class Waves:
    def __init__(self, L, seed, idx, total_s):
        self.seed = seed + idx * 7919
        self.P, self.inten = L.get("period_s", 9.0), L.get("intensity", 0.6)
        self.foam, self.dist, self.w = L.get("foam", 0.6), L.get("distance", 0.25), L.get("width", 0.7)
        self.tab = _wave_table(self.seed, self.P, total_s)
        d = self.dist
        self.bands = {
            "rumble": band_shape(40.0, 260.0 * (1 - 0.4 * d), 2, -1.0),
            "wash": band_shape(220.0, 2600.0 * (1 - 0.65 * d), 2, -0.3),
            "foam": band_shape(2600.0, 9500.0 * (1 - 0.6 * d), 2, 0.0),
        }
        self.src = {(b, c): White(self.seed, 10 * i + c) for i, b in enumerate(self.bands) for c in (0, 1)}

    def _env(self, t, band, ear):
        starts, size, dur, shift = self.tab
        e = np.zeros_like(t)
        # every wave ends for good at 3 durations (a smooth taper), so which waves a window sees never changes the sound
        lo, hi = np.searchsorted(starts, t[0] - 4.7 * self.P) - 1, np.searchsorted(starts, t[-1]) + 1
        for j in range(max(lo, 0), min(hi, len(starts))):
            tau = t - starts[j] - (shift[j] * self.w if ear else 0.0)
            D = dur[j]
            taper = 1.0 - smoothstep((tau - 2.3 * D) / (0.7 * D))
            if band == "rumble":
                e += size[j] * _bump(tau, 0.30 * D, 2.2) * taper
            elif band == "wash":
                e += size[j] * 0.85 * _bump(tau, 0.42 * D, 1.8) * taper
            else:
                e += size[j] ** 1.5 * _bump(tau, 0.58 * D, 1.2) * taper
        return e

    def render(self, a, n):
        t = tpos(a, n)
        tc = coarse(a, n)  # the swell envelopes are slow, so they are computed at 100 Hz
        out = np.zeros((n, 2))
        floor = {"rumble": 0.22, "wash": 0.12, "foam": 0.0}
        gain = {"rumble": 0.7, "wash": 0.85, "foam": 0.42 * self.foam * (1 - 0.5 * self.dist)}
        for ear in (0, 1):
            for name, fn in self.bands.items():
                x = shaped(self.src[(name, ear)], a, n, fn)
                env = np.interp(t, tc, floor[name] + self.inten * self._env(tc, name, ear))
                if name == "foam":
                    env = env * (0.55 + 0.9 * vnoise(t, self.seed + 31 + ear, 16.0))
                out[:, ear] += x * env * gain[name]
        return out * 0.2


def _roof_kernels(seed, surface):
    def make(rng):
        if surface == "roof":
            f = rng.uniform(1300, 4800)
            tau = rng.uniform(0.0025, 0.009)
            n = int(tau * 6 * SR)
            t = np.arange(n) / SR
            return (np.sin(2 * np.pi * f * t + rng.uniform(0, 6.28)) + 0.5 * np.sin(2 * np.pi * f * 1.9 * t)) * np.exp(-t / tau) + rng.standard_normal(n) * 0.4 * np.exp(-t / 0.0012)
        if surface == "leaves":
            tau = rng.uniform(0.004, 0.012)
            n = int(tau * 6 * SR)
            t = np.arange(n) / SR
            x = rng.standard_normal(n) * np.exp(-t / tau)
            return np.convolve(x, np.ones(6) / 6.0, "same") * 1.6
        if surface == "ground":
            f = rng.uniform(110, 320)
            tau = rng.uniform(0.012, 0.03)
            n = int(tau * 6 * SR)
            t = np.arange(n) / SR
            return np.sin(2 * np.pi * f * t) * np.exp(-t / tau) + np.convolve(rng.standard_normal(n), np.ones(10) / 10.0, "same") * np.exp(-t / 0.006) * 0.5
        f = rng.uniform(3000, 7500)
        tau = rng.uniform(0.001, 0.003)
        n = int(tau * 7 * SR)
        t = np.arange(n) / SR
        return np.sin(2 * np.pi * f * t) * np.exp(-t / tau) + rng.standard_normal(n) * 0.3 * np.exp(-t / 0.0008)

    return _kern(seed, 12, make)


class Rain:
    BED = {
        "roof": (1400.0, 9500.0, -0.2), "leaves": (700.0, 6200.0, -0.4),
        "ground": (150.0, 3200.0, -0.5), "window": (1800.0, 11000.0, 0.0),
    }

    def __init__(self, L, seed, idx, total_s):
        self.seed = seed + idx * 7919
        self.inten = L.get("intensity", 0.5)
        self.surface = L.get("surface", "roof")
        lo, hi, tilt = self.BED[self.surface]
        self.fn = band_shape(lo, hi, 2, tilt)
        self.wl, self.wr = White(self.seed, 1), White(self.seed, 2)
        self.kernels = _roof_kernels(self.seed, self.surface)
        self.rmax = 40.0 + 1700.0 * (max(p[1] for p in self.inten) if isinstance(self.inten, list) else self.inten) ** 1.4

    def _i(self, t):
        return np.clip(curve(self.inten, t, 0.5), 0.0, 1.0)

    def render(self, a, n):
        t = tpos(a, n)
        i = self._i(t)
        out = _stereo(shaped(self.wl, a, n, self.fn), shaped(self.wr, a, n, self.fn))
        bed = 10.0 ** ((-26.0 + 20.0 * i) / 20.0)
        out = out * bed[:, None]
        rate = lambda tt: 40.0 + 1700.0 * self._i(tt) ** 1.4
        ts, ex = poisson_events(self.seed, a, n, self.rmax, rate, 4, 0.2)
        drops = np.zeros((n, 2))
        for tt, e in zip(ts, ex):
            gl, gr = pan_gl_gr(e[1] * 2 - 1)
            add_kernel(drops, a, tt, self.kernels[int(e[2] * len(self.kernels)) % len(self.kernels)], (0.05 + 0.5 * e[0] ** 2.5) * gl * 1.4, (0.05 + 0.5 * e[0] ** 2.5) * gr * 1.4)
        return (out + drops * 0.35) * 0.55


class Wind:
    def __init__(self, L, seed, idx, total_s):
        self.seed = seed + idx * 7919
        self.s, self.g, self.wh = L.get("strength", 0.5), L.get("gustiness", 0.5), L.get("whistle", 0.15)
        self.w = {(k, c): White(self.seed, 10 * k + c) for k in range(3) for c in (0, 1)}

    def _gust(self, t, ear):
        td = t - 0.7 * ear
        slow = vnoise(td, self.seed + 1, 0.06) * 0.6 + vnoise(td, self.seed + 2, 0.17) * 0.4
        return (1.0 - self.g * 0.8) + self.g * 1.6 * slow**2

    def render(self, a, n):
        t = tpos(a, n)
        tc = coarse(a, n)
        out = np.zeros((n, 2))
        for ear in (0, 1):
            g = np.interp(t, tc, self._gust(tc, ear))
            fc = lambda tt, e=ear: 180.0 + 650.0 * (0.25 + 0.75 * vnoise(tt - 0.7 * e, self.seed + 3, 0.09)) * (0.6 + 0.8 * self.s)
            body = shaped(self.w[(0, ear)], a, n, band_shape(70.0, fc, 2, -0.6))
            rustle = shaped(self.w[(1, ear)], a, n, band_shape(1800.0, 5200.0, 2, 0.0))
            ws = lambda tt, e=ear: 650.0 + 700.0 * vnoise(tt - 0.7 * e, self.seed + 4, 0.05)
            whis = shaped(self.w[(2, ear)], a, n, lambda c, f, ws=ws: _hp(f[None, :], ws(c / SR)[:, None] * 0.93, 4) * _lp(f[None, :], ws(c / SR)[:, None] * 1.07, 4))
            lvl = 10.0 ** ((-14.0 + 16.0 * self.s) / 20.0)
            out[:, ear] = (body * g * lvl + rustle * g**2 * lvl * 0.15 * self.s + whis * g**3 * 0.1 * self.wh * self.s)
        return out * 1.0


def _bubble(rng, kind):
    if kind == "big":
        f0, tau = rng.uniform(140, 520), rng.uniform(0.03, 0.09)
    else:
        f0, tau = rng.uniform(380, 2600), rng.uniform(0.012, 0.045)
    n = int(tau * 5 * SR)
    t = np.arange(n) / SR
    f = f0 * (1.0 + rng.uniform(0.6, 1.8) * (1.0 - np.exp(-t / (tau * 0.7))))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / tau)


class Creek:
    def __init__(self, L, seed, idx, total_s):
        self.seed = seed + idx * 7919
        self.flow, self.bright = L.get("flow", 0.5), L.get("brightness", 0.5)
        self.wl, self.wr = White(self.seed, 1), White(self.seed, 2)
        hi = 3500.0 + 4500.0 * self.bright
        self.fn = band_shape(650.0, hi, 2, -0.2)
        self.small = _kern(self.seed, 16, lambda r: _bubble(r, "small"))
        self.big = _kern(self.seed + 1, 8, lambda r: _bubble(r, "big"))

    def render(self, a, n):
        t = tpos(a, n)
        mod = lambda ear: (0.45 + 0.55 * vnoise(t, self.seed + 9 + ear, 2.7)) * (0.6 + 0.8 * vnoise(t, self.seed + 11 + ear, 0.35))
        out = _stereo(shaped(self.wl, a, n, self.fn) * mod(0), shaped(self.wr, a, n, self.fn) * mod(1)) * (0.4 + 0.6 * self.flow)
        bub = np.zeros((n, 2))
        for kind, rate, ker in (("small", 25.0 + 150.0 * self.flow, self.small), ("big", 1.0 + 5.0 * self.flow, self.big)):
            ts, ex = poisson_events(self.seed + (0 if kind == "small" else 77), a, n, rate, None, 3, 0.6)
            for tt, e in zip(ts, ex):
                gl, gr = pan_gl_gr(e[1] * 2 - 1)
                g = (0.08 + 0.5 * e[0] ** 2) * (1.0 if kind == "small" else 1.3)
                add_kernel(bub, a, tt, ker[int(e[2] * len(ker)) % len(ker)], g * gl, g * gr)
        return (out * 0.55 + bub * 0.35) * 0.9


class Crickets:
    def __init__(self, L, seed, idx, total_s):
        self.seed = seed + idx * 7919
        c = int(L.get("count", 6))
        self.dist = L.get("distance", 0.5)
        p = L.get("pitch_hz", 4400.0)
        tempo = L.get("tempo", 1.0)
        k = np.arange(c)
        self.fc = p * (0.86 + 0.28 * u01(self.seed, k))
        self.chirp = tempo * (1.7 + 1.5 * u01(self.seed + 1, k))
        self.pulses = 3 + (u01(self.seed + 2, k) * 3).astype(int)
        self.prate = 48.0 + 10.0 * u01(self.seed + 3, k)
        self.off = u01(self.seed + 4, k)
        self.pan = 2 * u01(self.seed + 5, k) - 1
        self.gain = 10.0 ** (-(self.dist * 14.0 * u01(self.seed + 6, k) + 4.0 * k / max(c, 1)) / 20.0)
        self.gate_rate = 1.0 / (14.0 + 20.0 * u01(self.seed + 7, k))

    def render(self, a, n):
        t = tpos(a, n)
        out = np.zeros((n, 2))
        for i in range(len(self.fc)):
            u = (t * self.chirp[i] + self.off[i]) % 1.0
            s = u / self.chirp[i]
            on = s < self.pulses[i] / self.prate[i]
            ph = (s * self.prate[i]) % 1.0
            env = np.where(on, np.sin(np.pi * np.minimum(ph / 0.55, 1.0)) ** 2 * (ph < 0.55), 0.0)
            gate = smoothstep((vnoise(t, self.seed + 100 + i, self.gate_rate[i]) - 0.28) / 0.15)
            amp = env * gate * self.gain[i]
            on_i = np.nonzero(amp > 1e-6)[0]
            if not len(on_i):
                continue
            tt = t[on_i]
            x = np.sin(2 * np.pi * ((tt * self.fc[i]) % 1.0) + 0.4 * np.sin(2 * np.pi * 3.1 * tt)) * amp[on_i]
            gl, gr = pan_gl_gr(self.pan[i])
            out[on_i, 0] += x * gl
            out[on_i, 1] += x * gr
        return out * 0.30


def _crackle(rng, kind):
    if kind == "pop":
        n = int(0.09 * SR)
        t = np.arange(n) / SR
        return np.sin(2 * np.pi * rng.uniform(90, 160) * t) * np.exp(-t / 0.02) + np.convolve(rng.standard_normal(n), np.ones(5) / 5, "same") * np.exp(-t / 0.004) * 0.9
    tau = rng.uniform(0.0008, 0.006)
    n = int(tau * 7 * SR)
    t = np.arange(n) / SR
    x = rng.standard_normal(n)
    w = int(rng.integers(1, 7))
    x = x - np.convolve(x, np.ones(w * 4) / (w * 4), "same")
    return x * np.exp(-t / tau)


class Fire:
    def __init__(self, L, seed, idx, total_s):
        self.seed = seed + idx * 7919
        self.roar, self.crackle = L.get("roar", 0.5), L.get("crackle", 0.5)
        self.wl, self.wr = White(self.seed, 1), White(self.seed, 2)
        self.fn = band_shape(45.0, lambda t: 320.0 + 260.0 * vnoise(t, self.seed + 3, 0.3), 2, -1.0)
        self.hiss = band_shape(900.0, 3600.0, 2, 0.0)
        self.wh = White(self.seed, 3)
        self.small = _kern(self.seed, 24, lambda r: _crackle(r, "small"))
        self.pops = _kern(self.seed + 1, 6, lambda r: _crackle(r, "pop"))

    def render(self, a, n):
        t = tpos(a, n)
        flutter = (0.55 + 0.45 * vnoise(t, self.seed + 5, 0.6)) * (0.7 + 0.5 * vnoise(t, self.seed + 6, 4.0))
        roar = _stereo(shaped(self.wl, a, n, self.fn), shaped(self.wr, a, n, self.fn)) * flutter[:, None] * (0.2 + 0.8 * self.roar)
        hiss = shaped(self.wh, a, n, self.hiss)[:, None] * (0.05 + 0.1 * self.crackle) * flutter[:, None]
        cr = np.zeros((n, 2))
        parents, ex = poisson_events(self.seed, a, n, 2.0 + 9.0 * self.crackle, None, 6, 0.6)
        for tt, e in zip(parents, ex):
            kids = 1 + int(e[3] * 6)
            for q in range(kids):
                tk = tt + (0.0 if q == 0 else min(-math.log(1.0 - min(e[4] * 0.99 + 0.003 * q, 0.99)) * 0.05 * q, 0.3))
                gl, gr = pan_gl_gr(e[1] * 2 - 1)
                g = (0.05 + 0.9 * (e[0] ** 3) * (0.9 ** q))
                add_kernel(cr, a, tk, self.small[int(e[2] * len(self.small) + q) % len(self.small)], g * gl, g * gr)
        pt, pe = poisson_events(self.seed + 9, a, n, 0.25 + 0.5 * self.crackle, None, 3, 0.2)
        for tt, e in zip(pt, pe):
            gl, gr = pan_gl_gr(e[1] * 2 - 1)
            add_kernel(cr, a, tt, self.pops[int(e[2] * len(self.pops)) % len(self.pops)], (0.5 + 0.5 * e[0]) * gl, (0.5 + 0.5 * e[0]) * gr)
        return (roar * 0.5 + hiss + cr * 0.5 * (0.3 + 0.7 * self.crackle))


class Pad:
    def __init__(self, L, seed, idx, total_s):
        self.seed = seed + idx * 7919
        self.notes = [dsp.freq_value(x) for x in L.get("notes", ["A2", "E3", "C4", "E4"])]
        self.bright, self.motion = L.get("brightness", 0.35), L.get("motion", 0.5)

    def render(self, a, n):
        t = tpos(a, n)
        out = np.zeros((n, 2))
        for ni, f in enumerate(self.notes):
            pan = (ni / max(len(self.notes) - 1, 1)) * 1.2 - 0.6
            gl, gr = pan_gl_gr(pan)
            trem = 1.0 - self.motion * 0.45 * (0.5 + 0.5 * np.sin(2 * np.pi * (0.025 + 0.02 * ni) * t + 6.28 * u01(self.seed, np.array([ni]))[0]))
            x = np.zeros(n)
            for k, g in enumerate([1.0, 0.5, 0.28, 0.14, 0.07], start=1):
                if f * k > 9000:
                    break
                gk = g * (self.bright ** (k - 1) if k > 1 else 1.0) * (1.0 if k == 1 else 1.0)
                df = f * k * (2.0 ** (1.6 / 1200.0) - 2.0 ** (-1.6 / 1200.0))  # two strings 3.2 cents apart beat at df Hz
                x += gk * 2.0 * np.sin(2 * np.pi * ((t * f * k) % 1.0) + k) * np.cos(np.pi * df * t)
            x *= trem / (len(self.notes) ** 0.5)
            out[:, 0] += x * gl
            out[:, 1] += x * gr
        return out * 0.07


CLASSES = {"binaural": Binaural, "isochronic": Isochronic, "noise": Noise, "waves": Waves, "rain": Rain, "wind": Wind, "creek": Creek, "crickets": Crickets, "fire": Fire, "pad": Pad}
# Each layer's output is brought to this RMS (dBFS) at gain_db 0, so gain_db means the same thing for every type.
NORM_DB = {"binaural": -17.5, "isochronic": -17.5, "noise": -20.0, "waves": -20.0, "rain": -20.0, "wind": -20.0, "creek": -20.0, "crickets": -22.0, "fire": -20.0, "pad": -22.0}


# ---------------------------------------------------------------- the mix


class Mixer:
    def __init__(self, recipe, total_s):
        self.recipe, self.total_s = recipe, total_s
        seed = recipe.get("seed", 1)
        self.layers = []
        for i, L in enumerate(recipe["layers"]):
            obj = CLASSES[L["type"]](L, seed, i, total_s)
            self.layers.append((L, obj, 10.0 ** (NORM_DB[L["type"]] / 20.0) / REF_RMS[L["type"]]))
        m = recipe.get("master", {})
        self.fade_in = m.get("fade", {}).get("in", min(10.0, total_s * 0.05))
        self.fade_out = m.get("fade", {}).get("out", min(10.0, total_s * 0.05))
        self.gain = 10.0 ** (m.get("gain_db", 0.0) / 20.0)
        self.total = int(round(total_s * SR))

    def render(self, a, n):
        """The mix for samples [a, a+n), absolute; zero outside the piece."""
        t = tpos(a, n)
        x = np.zeros((n, 2))
        for L, obj, norm in self.layers:
            db = L.get("gain_db", 0.0) + (curve(L["automation"], t, 0.0) if L.get("automation") else 0.0)
            x += obj.render(a, n) * (norm * 10.0 ** (np.asarray(db, dtype=float) / 20.0) * np.ones(n))[:, None]
        env = smoothstep(t / self.fade_in) if self.fade_in > 0 else np.ones(n)
        if self.fade_out > 0:
            env = env * smoothstep((self.total_s - t) / self.fade_out)
        env = env * ((t >= 0) & (t < self.total_s))
        return x * (env * self.gain)[:, None]


REF_RMS = {}  # filled by calibrate(); layer output RMS at default parameters, per type


def calibrate():
    """Measure each layer type at its defaults so NORM_DB means what it says. Run by the tests, and by --calibrate."""
    out = {}
    for ty in TYPES:
        obj = CLASSES[ty]({"type": ty}, 1, 0, 120.0)
        x = obj.render(60 * SR, 20 * SR)
        out[ty] = float(np.sqrt(np.mean(x * x)))
    return out


REF_RMS.update({
    "binaural": 0.2475, "isochronic": 0.1546, "noise": 0.1298, "waves": 0.1237, "rain": 0.1019, "wind": 0.3711, "creek": 0.2561,
    "crickets": 0.0314, "fire": 0.2370, "pad": 0.0466,
})


# ---------------------------------------------------------------- streaming loudness, true peak and file writing


def _k_ir(n=16384):
    ir = np.zeros(n)
    ir[0] = 1.0
    for b, a in dsp._k_filters():
        y = np.zeros(n)
        x1 = x2 = y1 = y2 = 0.0
        for i in range(n):
            v = b[0] * ir[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
            x2, x1 = x1, ir[i]
            y2, y1 = y1, v
            y[i] = v
        ir = y
    return ir


_KIR = []


class Meter:
    """BS.1770 loudness and true peak of a signal fed in chunks (flat memory). feed() takes the chunks in order."""

    def __init__(self):
        if not _KIR:
            _KIR.append(_k_ir())
        self.ir = _KIR[0]
        self.fir = np.fft.rfft  # kept for clarity
        self.tail = np.zeros((len(self.ir) - 1, 2))
        self.left = np.zeros((0, 2))
        self.sub = []
        self.peak = 0.0
        self.tp = 0.0
        self.prev = np.zeros((48, 2))
        self.n = 0
        self.sum = np.zeros(2)
        self.over = 0
        self.silent_blocks = 0
        self.blocks_total = 0

    def feed(self, x):
        n = len(x)
        if n == 0:
            return
        self.n += n
        self.sum += x.sum(axis=0)
        self.peak = max(self.peak, float(np.abs(x).max()))
        self.over += int(np.sum(np.abs(x) >= 32767.0 / 32768.0))
        cat = np.concatenate([self.prev, x])
        for c in range(2):
            for h in dsp._TP:
                v = np.abs(np.convolve(cat[:, c], h, mode="same"))[24 : 24 + n]
                self.tp = max(self.tp, float(v.max()))
        self.prev = cat[-48:]
        size = dsp.fast_len(n + len(self.ir))
        H = np.fft.rfft(self.ir, size)
        y = np.fft.irfft(np.fft.rfft(x, size, axis=0) * H[:, None], size, axis=0)[: n + len(self.ir) - 1]
        y[: len(self.tail)] += self.tail
        k = y[:n]
        self.tail = y[n:]
        sq = np.concatenate([self.left, k * k])
        sb = int(0.1 * SR)
        m = len(sq) // sb
        if m:
            self.sub.append(sq[: m * sb].reshape(m, sb, 2).mean(axis=1))
        self.left = sq[m * sb :]

    def blocks(self):
        if not self.sub:
            return np.zeros(0)
        s = np.concatenate(self.sub).sum(axis=1)
        if len(s) < 4:
            return s[:1] if len(s) else np.zeros(0)
        return (s[:-3] + s[1:-2] + s[2:-1] + s[3:]) / 4.0

    def lufs(self, z=None):
        return gated(self.blocks() if z is None else z)

    def true_peak_db(self):
        return dsp.lin_to_db(max(self.tp, self.peak))

    def dc(self):
        return float(np.max(np.abs(self.sum / max(self.n, 1))))


def gated(z):
    if len(z) == 0:
        return -math.inf
    l = -0.691 + 10.0 * np.log10(np.maximum(z, 1e-20))
    keep = l > -70.0
    if not keep.any():
        return -math.inf
    rel = -0.691 + 10.0 * math.log10(z[keep].mean()) - 10.0
    keep = l > max(rel, -70.0)
    if not keep.any():
        return -math.inf
    return -0.691 + 10.0 * math.log10(z[keep].mean())


class Writer:
    def __init__(self, path, bits):
        self.bits = bits
        self.w = wave.open(path, "wb")
        self.w.setnchannels(2)
        self.w.setsampwidth(3 if bits == 24 else 2)
        self.w.setframerate(SR)

    def write(self, x):
        y = np.clip(x, -1.0, 1.0)
        if self.bits == 24:
            v = np.round(y * 8388607.0).astype("<i4")
            self.w.writeframes(v.reshape(-1).view(np.uint8).reshape(-1, 4)[:, :3].tobytes())
        else:
            self.w.writeframes(np.round(y * 32767.0).astype("<i2").tobytes())

    def close(self):
        self.w.close()


def read_frames(path, a, n):
    """[n, 2] floats from frame a of a 16 or 24 bit WAV; positions outside the file read as zeros."""
    with wave.open(path, "rb") as w:
        total, sw, ch = w.getnframes(), w.getsampwidth(), w.getnchannels()
        lo, hi = max(a, 0), min(a + n, total)
        out = np.zeros((n, 2))
        if hi > lo:
            w.setpos(lo)
            raw = w.readframes(hi - lo)
            if sw == 2:
                v = np.frombuffer(raw, "<i2").astype(np.float64) / 32768.0
            else:
                b = np.frombuffer(raw, np.uint8).reshape(-1, 3)
                q = b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16)
                v = np.where(q >= 1 << 23, q - (1 << 24), q).astype(np.float64) / 8388608.0
            out[lo - a : hi - a] = v.reshape(-1, ch)[:, :2]
        return out


def file_frames(path):
    with wave.open(path, "rb") as w:
        return w.getnframes(), w.getsampwidth() * 8


def estimate_gain_lufs(mixer, total, chunk, target):
    """The loudness the piece would have at gain 0: all of it when it is short, else up to 12 windows spread across it."""
    z = []
    if total <= 90 * SR:
        m = Meter()
        for a in range(0, total, chunk):
            n = min(chunk, total - a)
            m.feed(mixer.render(a, n))
        return m.lufs()
    seg = 10 * SR
    k = int(min(12, max(3, total // (20 * SR))))
    for i in range(k):
        a = int((i + 0.5) / k * total) - seg // 2
        m = Meter()
        x = mixer.render(a - CTX, seg + 2 * CTX)[CTX : CTX + seg]
        m.feed(x)
        z.append(m.blocks())
    return gated(np.concatenate(z))


def render_to_file(recipe, total_s, out, chunk_s, bits, target, tp_limit, log=None):
    """Render in chunks straight to a WAV, then trim the gain from the finished file until it is on target. A piece of
    30 s or less is rendered once and kept in memory, so it is not rendered twice."""
    mixer = Mixer(recipe, total_s)
    total = mixer.total
    chunk = max(int(round(chunk_s * SR / HOP)) * HOP, 4 * HOP)
    full = None
    if total <= 30 * SR:
        full = mixer.render(-CTX, total + 2 * CTX)
        m0 = Meter()
        m0.feed(full[CTX : CTX + total])
        est = m0.lufs()
    else:
        est = estimate_gain_lufs(mixer, total, 30 * SR, target)
    if not math.isfinite(est):
        raise ValueError("the piece is silent: check gain_db, automation and the layers' parameters")
    gain = target - est
    ceiling = tp_limit - 0.15
    tmp = out + ".part"
    meter = Meter()
    wr = Writer(tmp, bits)
    red = 0.0
    g = 10.0 ** (gain / 20.0)
    for a in range(0, total, chunk):
        n = min(chunk, total - a)
        x = (full[a : a + n + 2 * CTX] if full is not None else mixer.render(a - CTX, n + 2 * CTX)) * g
        x, r = dsp.limit(x, ceiling)
        red = max(red, r)
        core = x[CTX : CTX + n]
        meter.feed(core)
        wr.write(core)
        if log:
            log(a + n, total)
    wr.close()
    for _ in range(4):
        err = target - meter.lufs()
        if abs(err) <= 0.1 and meter.true_peak_db() <= tp_limit + 0.02:
            break
        if not math.isfinite(err):
            break
        meter, red2 = trim_file(tmp, err if abs(err) > 0.1 else 0.0, ceiling, chunk, bits)
        red = max(red, red2)
    os.replace(tmp, out)
    return {"lufs": meter.lufs(), "true_peak": meter.true_peak_db(), "peak": dsp.lin_to_db(meter.peak), "over": meter.over, "dc": meter.dc(),
            "samples": meter.n, "gain_db": gain, "reduction_db": red}


def trim_file(path, gain_db, ceiling_db, chunk, bits):
    """Read a finished WAV back in chunks, apply gain and the limiter, write it again; returns its new meter."""
    total, _ = file_frames(path)
    tmp = path + ".trim"
    meter, wr = Meter(), Writer(tmp, bits)
    g = 10.0 ** (gain_db / 20.0)
    red = 0.0
    for a in range(0, total, chunk):
        n = min(chunk, total - a)
        x = read_frames(path, a - CTX, n + 2 * CTX) * g
        x, r = dsp.limit(x, ceiling_db)
        red = max(red, r)
        core = x[CTX : CTX + n]
        meter.feed(core)
        wr.write(core)
    wr.close()
    os.replace(tmp, path)
    return meter, red


# ---------------------------------------------------------------- measuring what is in a file


def _peak_hz(spec, freqs, lo, hi):
    m = (freqs >= lo) & (freqs <= hi)
    idx = np.where(m)[0]
    k = idx[int(np.argmax(spec[idx]))]
    if 0 < k < len(spec) - 1:
        a, b, c = np.log(spec[k - 1] + 1e-20), np.log(spec[k] + 1e-20), np.log(spec[k + 1] + 1e-20)
        d = (a - 2 * b + c)
        off = 0.5 * (a - c) / d if d != 0 else 0.0
    else:
        off = 0.0
    return float(freqs[k] + off * (freqs[1] - freqs[0]))


def measure_tone(path, t_center, seconds, lo, hi, channel):
    """The frequency of the strongest tone between lo and hi Hz in one channel around t_center, by a windowed,
    zero-padded FFT with a parabolic peak fit (accurate to a few hundredths of a hertz)."""
    n = int(seconds * SR)
    a = int(t_center * SR) - n // 2
    x = read_frames(path, a, n)[:, channel]
    size = dsp.fast_len(n * 4)
    sp = np.abs(np.fft.rfft(x * np.hanning(n), size))
    return _peak_hz(sp, np.fft.rfftfreq(size, 1.0 / SR), lo, hi)


def measure_rate(path, t_center, seconds, expect):
    """The gate rate of an isochronic tone from the envelope of the rectified signal."""
    n = int(seconds * SR)
    a = int(t_center * SR) - n // 2
    x = np.abs(read_frames(path, a, n)[:, 0])
    k = int(SR / 400)
    env = x[: len(x) // k * k].reshape(-1, k).mean(axis=1)
    env = env - env.mean()
    size = dsp.fast_len(len(env) * 8)
    sp = np.abs(np.fft.rfft(env * np.hanning(len(env)), size))
    return _peak_hz(sp, np.fft.rfftfreq(size, k / SR), max(expect - 1.5, 0.3), expect + 1.5)


def beat_checks(recipe, total_s, path):
    """For each binaural or isochronic layer, measure the beat or rate in the file at the middle of long steady stages."""
    out = []
    for i, L in enumerate(recipe["layers"]):
        if L["type"] not in ("binaural", "isochronic"):
            continue
        key = "beat_hz" if L["type"] == "binaural" else "rate_hz"
        sched = stage_sched(L, key, 10.0, total_s)
        car = stage_sched(L, "carrier_hz", 200.0, total_s)
        steady = [(t0, min(t1, total_s), v0) for t0, t1, v0, kind in zip(sched.t0, sched.t1, sched.v0, sched.kind)
                  if kind == 0 and t0 < total_s and min(t1, total_s) - t0 >= 9]
        if len(steady) > 8:  # a long journey: eight stages spread over it, the first and the last always among them
            steady = [steady[j] for j in sorted({round(k * (len(steady) - 1) / 7) for k in range(8)})]
        for t0, t1, v0 in steady:
            span = t1 - t0
            tc = t0 + span / 2
            win = min(12.0, span - 2)
            c = float(car.value(tc))
            if L["type"] == "binaural":
                half = v0 / 2.0
                els = (c, c + v0) if L.get("split") == "right" else (c - half, c + half)
                got = [measure_tone(path, tc, win, e - 2.5, e + 2.5, ch) for ch, e in enumerate(els)]
                measured = got[1] - got[0]
                out.append({"layer": i, "type": "binaural", "at_s": round(tc, 1), "expected_hz": v0, "measured_hz": round(measured, 3), "left_hz": round(got[0], 3), "right_hz": round(got[1], 3)})
            else:
                measured = measure_rate(path, tc, win, v0)
                out.append({"layer": i, "type": "isochronic", "at_s": round(tc, 1), "expected_hz": v0, "measured_hz": round(measured, 3)})
    return out


# ---------------------------------------------------------------- checking and the command line


def total_seconds(recipe, args_minutes=None, args_seconds=None):
    if args_seconds:
        return float(args_seconds)
    if args_minutes:
        return float(args_minutes) * 60.0
    if "seconds" in recipe:
        return float(recipe["seconds"])
    return float(recipe.get("minutes", 10.0)) * 60.0


def stretch(recipe, total_s):
    """A new length asked for on the command line scales every timeline in the recipe (stages, automation, intensity
    curves) with it, so a 30 minute journey asked for as 60 minutes is still the same journey, only slower."""
    old = float(recipe["seconds"]) if "seconds" in recipe else float(recipe.get("minutes", 10.0)) * 60.0
    f = total_s / old
    if abs(f - 1.0) < 1e-9:
        return
    for L in recipe["layers"]:
        if not isinstance(L, dict):
            continue
        for s in L.get("stages", []) if isinstance(L.get("stages"), list) else []:
            if isinstance(s, dict):
                if "seconds" in s:
                    s["seconds"] = s["seconds"] * f
                if "minutes" in s:
                    s["minutes"] = s["minutes"] * f
        for key in ("automation", "intensity"):
            if isinstance(L.get(key), list):
                L[key] = [[q[0] * f, q[1]] if isinstance(q, list) and len(q) == 2 else q for q in L[key]]
        if "ramp_s" in L:
            L["ramp_s"] = max(min(L["ramp_s"] * max(f, 0.05), 600), 1)


def check_recipe(recipe, total_s):
    errs, warns = [], []
    dsp.validate(recipe, RECIPE, "recipe", errs)
    if errs:
        return errs, warns
    if "minutes" in recipe and "seconds" in recipe:
        warns.append("recipe: both minutes and seconds are set; seconds is used")
    for i, L in enumerate(recipe["layers"]):
        p = f"layers[{i}]"
        ok = ONLY[L["type"]] | COMMON
        for k in L:
            if k not in ok:
                errs.append(f"{p}.{k}: does not apply to type {L['type']!r} (this type takes: {', '.join(sorted(ok - COMMON))})")
        au = L.get("automation")
        if au is not None:
            if not (isinstance(au, list) and len(au) >= 2 and all(isinstance(q, list) and len(q) == 2 and dsp._is_num(q[0]) and dsp._is_num(q[1]) for q in au)):
                errs.append(f"{p}.automation: use [[minutes, dB], ...] with at least two points")
            elif any(q[1] < -80 or q[1] > 12 for q in au):
                errs.append(f"{p}.automation: dB values must be between -80 and 12")
        it = L.get("intensity")
        if it is not None:
            if isinstance(it, list):
                if not (len(it) >= 2 and all(isinstance(q, list) and len(q) == 2 and dsp._is_num(q[0]) and dsp._is_num(q[1]) and 0 <= q[1] <= 1 for q in it)):
                    errs.append(f"{p}.intensity: use a number 0 to 1 or [[minutes, 0 to 1], ...]")
            elif not (dsp._is_num(it) and 0 <= it <= 1):
                errs.append(f"{p}.intensity: {it!r} is out of range 0 to 1")
        if L["type"] in ("binaural", "isochronic"):
            key = "beat_hz" if L["type"] == "binaural" else "rate_hz"
            other = "rate_hz" if key == "beat_hz" else "beat_hz"
            if other in L or any(other in s for s in L.get("stages", [])):
                errs.append(f"{p}: use {key} for a {L['type']} layer, not {other}")
            for j, s in enumerate(L.get("stages", [])):
                if "seconds" not in s and "minutes" not in s:
                    errs.append(f"{p}.stages[{j}]: needs seconds or minutes")
            if L.get("stages"):
                tot = sum(s.get("seconds", s.get("minutes", 0) * 60.0) for s in L["stages"])
                if tot < total_s - 1:
                    warns.append(f"{p}.stages: the stages add up to {tot / 60:.1f} min, shorter than the piece; the last stage holds")
                if tot > total_s + 1:
                    warns.append(f"{p}.stages: the stages add up to {tot / 60:.1f} min, longer than the piece; the later ones are cut off")
            c = L.get("carrier_hz", 200.0)
            if L["type"] == "binaural" and c > 900:
                warns.append(f"{p}.carrier_hz: binaural carriers work best below about 900 Hz")
        if L["type"] == "pad" and "notes" in L:
            pass
    return errs, warns


def check_stats(stats, total_s, target, tp_limit):
    errs, warns = [], []
    exp = int(round(total_s * SR))
    if stats["samples"] != exp:
        errs.append(f"length is {stats['samples'] / SR:.3f} s, not the {total_s:.3f} s asked for")
    if not math.isfinite(stats["lufs"]):
        errs.append("the file is silent")
        return errs, warns
    d = stats["lufs"] - target
    if abs(d) > 1.0:
        errs.append(f"loudness {stats['lufs']:.1f} LUFS is {d:+.1f} LU from the target {target}")
    elif abs(d) > 0.5:
        warns.append(f"loudness {stats['lufs']:.1f} LUFS is {d:+.1f} LU from the target {target}")
    if stats["true_peak"] > tp_limit + 0.05:
        errs.append(f"true peak {stats['true_peak']:.2f} dBTP is above the limit {tp_limit}")
    if stats["over"]:
        errs.append(f"clipping: {stats['over']} samples at full scale")
    if stats["dc"] > 0.005:
        errs.append(f"DC offset {stats['dc']:.4f}")
    if stats.get("reduction_db", 0) > 9.0:
        warns.append(f"the limiter took off up to {stats['reduction_db']:.1f} dB on peaks; lower the loudest layer for a more natural result")
    return errs, warns


def preset_dir():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "soundscapes")


def sample_check(recipe, total_s, target, tp_limit):
    """--check without an output file: three 10 second windows, rendered and measured."""
    mixer = Mixer(recipe, total_s)
    est = estimate_gain_lufs(mixer, mixer.total, 30 * SR, target)
    peaks = []
    for f in (0.2, 0.5, 0.8):
        a = int(f * mixer.total)
        x = mixer.render(a, 10 * SR)
        peaks.append(float(np.abs(x).max()))
    return {"estimated_lufs_at_gain_0": est, "gain_to_target_db": target - est, "window_peak_at_gain_0": max(peaks)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Render long seamless soundscapes from a JSON recipe.")
    ap.add_argument("paths", nargs="*")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--preset")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--minutes", type=float)
    ap.add_argument("--seconds", type=float)
    ap.add_argument("--seed", type=int)
    ap.add_argument("--chunk", type=float)
    ap.add_argument("--bits", type=int, choices=[16, 24], default=16)
    ap.add_argument("--sheet")
    args = ap.parse_args(argv)
    if args.list:
        for f in sorted(glob.glob(os.path.join(preset_dir(), "*.json"))):
            r = json.load(open(f, encoding="utf8"))
            print(f"{os.path.basename(f)[:-5]:<22} {r.get('note', '')[:100]}")
        return 0
    paths = list(args.paths)
    if args.preset:
        rpath = os.path.join(preset_dir(), args.preset + ".json")
    elif paths:
        rpath = paths.pop(0)
        if not os.path.exists(rpath) and os.path.exists(os.path.join(preset_dir(), rpath + ".json")):
            rpath = os.path.join(preset_dir(), rpath + ".json")
    else:
        ap.print_usage(sys.stderr)
        return 2
    out = paths[0] if paths else None
    if out is None and not args.check:
        print("soundscape.py: give an output file (out.wav), or use --check", file=sys.stderr)
        return 2
    try:
        recipe = json.load(open(rpath, encoding="utf8"))
    except (OSError, ValueError) as e:
        print(f"soundscape.py: cannot read {rpath}: {e}", file=sys.stderr)
        return 2
    if args.seed is not None:
        recipe["seed"] = args.seed
    total_s = total_seconds(recipe, args.minutes, args.seconds)
    if (args.minutes or args.seconds) and isinstance(recipe.get("layers"), list):
        stretch(recipe, total_s)
    ld = recipe.get("master", {}).get("loudness", {})
    target, tp = ld.get("lufs", DEFAULT_LUFS), ld.get("true_peak", DEFAULT_TP)
    errs, warns = check_recipe(recipe, total_s)
    stats, beats, est = None, [], None
    notes = []
    if any(L["type"] == "binaural" for L in recipe.get("layers", []) if isinstance(L, dict)):
        notes.append("Binaural beats need stereo headphones: the beat is made in the listener's head from two different tones, one per ear. No health or treatment claim is made.")
    if not errs:
        try:
            if out:
                ext = os.path.splitext(out)[1].lower()
                if ext not in (".wav", ".mp3", ".ogg"):
                    raise ValueError("the output file must end in .wav, .mp3 or .ogg")
                wav = out if ext == ".wav" else out + ".tmp.wav"
                cs = args.chunk or recipe.get("master", {}).get("chunk_s", 30.0)
                prog = (lambda a, t: print(f"\r{100 * a // t}%", end="", file=sys.stderr, flush=True)) if total_s > 120 and not args.json else None
                stats = render_to_file(recipe, total_s, wav, cs, args.bits, target, tp, prog)
                if prog:
                    print("", file=sys.stderr)
                e2, w2 = check_stats(stats, total_s, target, tp)
                errs += e2
                warns += w2
                beats = beat_checks(recipe, total_s, wav)
                for b in beats:
                    if abs(b["measured_hz"] - b["expected_hz"]) > 0.1:
                        errs.append(f"layers[{b['layer']}]: measured {b['type']} frequency {b['measured_hz']} Hz at {b['at_s']} s is not the {b['expected_hz']} Hz in the recipe")
                if args.sheet:
                    import sheet

                    sheet.make_sheet(wav, args.sheet, target_lufs=target)
                if errs:
                    os.unlink(wav)
                elif ext != ".wav":
                    if not shutil.which("ffmpeg"):
                        raise ValueError("ffmpeg is not installed, so only .wav can be written here")
                    enc = ["-c:a", "libmp3lame", "-b:a", "192k"] if ext == ".mp3" else ["-c:a", "libvorbis", "-q:a", "5"]
                    r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", wav, *enc, out], capture_output=True, text=True)
                    os.unlink(wav)
                    if r.returncode:
                        raise ValueError("ffmpeg could not write " + out + ": " + r.stderr.strip()[-200:])
            else:
                est = sample_check(recipe, total_s, target, tp)
        except ValueError as e:
            errs.append(str(e))
    report = {"ok": not errs, "errors": errs, "warnings": warns, "notes": notes, "seconds": total_s, "stats": stats, "beats": beats, "estimate": est, "file": out if out and not errs else None}
    if args.json:
        print(json.dumps(dsp.json_safe(report), indent=2))
    else:
        for e in errs:
            print("ERROR", e)
        for w in warns:
            print("warn ", w)
        for n_ in notes:
            print("note ", n_)
        for b in beats:
            print(f"beat  layer {b['layer']} at {b['at_s']} s: {b['measured_hz']} Hz measured, {b['expected_hz']} Hz in the recipe")
        if stats:
            print(f"{'FAIL' if errs else 'ok'}: {stats['samples'] / SR:.1f} s, {stats['lufs']:.1f} LUFS, true peak {stats['true_peak']:.2f} dBTP, DC {stats['dc']:.4f}" + (f" -> {out}" if out and not errs else ""))
        elif est:
            print(f"ok: sampled three windows; {est['estimated_lufs_at_gain_0']:.1f} LUFS before the master gain, which will add {est['gain_to_target_db']:+.1f} dB to reach {target}")
        elif errs:
            print("FAIL: fix the errors above; nothing was rendered")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
