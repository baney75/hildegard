#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Contact sheet of an audio file, for a model that cannot hear. Python 3.10+, standard library plus numpy.

Draws one PNG: the waveform (min/max envelope with the RMS inside it, on a dB-shaped amplitude scale), a log-frequency
spectrogram, the short-term (3 s) loudness curve and the octave-band balance, with axis labels from a built-in 5x7 bitmap
font and a PNG writer made of zlib and struct. WAVs are read in chunks by seeking, so a one hour file costs flat memory;
anything else goes through ffmpeg. Looks at dsp.py (next to this file) for K-weighting when it can import it, and works
without it.

    python3 sheet.py in.wav out.png [--marker SECONDS[:LABEL] ...] [--target-lufs -14] [--width 1600] [--json]
"""
import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave
import zlib

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    import dsp
except Exception:  # sheet.py must run on any audio file alone
    dsp = None

SR = 44100
CHUNK = 1 << 20

BG = (16, 18, 22)
TEXT = (201, 206, 214)
GRID = (44, 49, 58)
BORDER = (88, 95, 108)
ENV = (66, 112, 184)
RMS = (150, 200, 255)
LOUD = (250, 176, 64)
MARK = (255, 96, 128)
TARGET = (120, 220, 140)
BAR = (110, 170, 230)

BANDS = [("60", 60.0), ("125", 125.0), ("250", 250.0), ("500", 500.0), ("1k", 1000.0), ("2k", 2000.0),
         ("4k", 4000.0), ("8k", 8000.0), ("16k", 16000.0)]

# ---------------------------------------------------------------- font

_ROWS = {
    "0": ".###. #...# #..## #.#.# ##..# #...# .###.",
    "1": "..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.",
    "2": ".###. #...# ....# ...#. ..#.. .#... #####",
    "3": ".###. #...# ....# ..##. ....# #...# .###.",
    "4": "...#. ..##. .#.#. #..#. ##### ...#. ...#.",
    "5": "##### #.... ####. ....# ....# #...# .###.",
    "6": "..##. .#... #.... ####. #...# #...# .###.",
    "7": "##### ....# ...#. ..#.. .#... .#... .#...",
    "8": ".###. #...# #...# .###. #...# #...# .###.",
    "9": ".###. #...# #...# .#### ....# ...#. .##..",
    "A": ".###. #...# #...# ##### #...# #...# #...#",
    "B": "####. #...# #...# ####. #...# #...# ####.",
    "C": ".###. #...# #.... #.... #.... #...# .###.",
    "D": "###.. #..#. #...# #...# #...# #..#. ###..",
    "E": "##### #.... #.... ####. #.... #.... #####",
    "F": "##### #.... #.... ####. #.... #.... #....",
    "G": ".###. #...# #.... #.### #...# #...# .###.",
    "H": "#...# #...# #...# ##### #...# #...# #...#",
    "I": ".###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.",
    "J": "..### ...#. ...#. ...#. ...#. #..#. .##..",
    "K": "#...# #..#. #.#.. ##... #.#.. #..#. #...#",
    "L": "#.... #.... #.... #.... #.... #.... #####",
    "M": "#...# ##.## #.#.# #.#.# #...# #...# #...#",
    "N": "#...# ##..# #.#.# #..## #...# #...# #...#",
    "O": ".###. #...# #...# #...# #...# #...# .###.",
    "P": "####. #...# #...# ####. #.... #.... #....",
    "Q": ".###. #...# #...# #...# #.#.# #..#. .##.#",
    "R": "####. #...# #...# ####. #.#.. #..#. #...#",
    "S": ".#### #.... #.... .###. ....# ....# ####.",
    "T": "##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..",
    "U": "#...# #...# #...# #...# #...# #...# .###.",
    "V": "#...# #...# #...# #...# #...# .#.#. ..#..",
    "W": "#...# #...# #...# #.#.# #.#.# ##.## #...#",
    "X": "#...# #...# .#.#. ..#.. .#.#. #...# #...#",
    "Y": "#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..",
    "Z": "##### ....# ...#. ..#.. .#... #.... #####",
    ".": "..... ..... ..... ..... ..... .##.. .##..",
    ":": "..... .##.. .##.. ..... .##.. .##.. .....",
    "-": "..... ..... ..... ##### ..... ..... .....",
    "+": "..... ..#.. ..#.. ##### ..#.. ..#.. .....",
    "/": "....# ....# ...#. ..#.. .#... #.... #....",
    "%": "##..# ##..# ...#. ..#.. .#... #..## #..##",
    " ": "..... ..... ..... ..... ..... ..... .....",
}
FONT = {k: [list(r) for r in v.split()] for k, v in _ROWS.items()}
_GLYPHS = {}


def _clean(s):
    return "".join(c for c in str(s).upper() if c in FONT)


def _glyph(ch, scale):
    key = (ch, scale)
    g = _GLYPHS.get(key)
    if g is None:
        bm = np.array([[c == "#" for c in row] for row in FONT[ch]], dtype=bool)
        g = _GLYPHS[key] = np.kron(bm, np.ones((scale, scale), dtype=bool))
    return g


def text_width(s, scale=1):
    n = len(_clean(s))
    return max(0, n * 6 * scale - scale)


def draw_text(img, x, y, s, color=TEXT, scale=1):
    """Draws upper-cased text with its top-left at (x, y); characters outside the font are skipped."""
    h, w = img.shape[:2]
    x, y = int(x), int(y)
    for ch in _clean(s):
        g = _glyph(ch, scale)
        gh, gw = g.shape
        x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + gw, w), min(y + gh, h)
        if x0 < x1 and y0 < y1:
            sub = g[y0 - y:y1 - y, x0 - x:x1 - x]
            img[y0:y1, x0:x1][sub] = color
        x += 6 * scale


# ---------------------------------------------------------------- PNG

def _chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def png_bytes(rgb):
    """A valid PNG from an [h, w, 3] uint8 array: 8-bit truecolor, Sub filter, zlib level 6."""
    a = np.ascontiguousarray(rgb, dtype=np.uint8)
    if a.ndim != 3 or a.shape[2] != 3:
        raise ValueError("png_bytes wants an [h, w, 3] uint8 array")
    h, w = a.shape[:2]
    flat = a.reshape(h, w * 3)
    f = flat.copy()
    f[:, 3:] = flat[:, 3:] - flat[:, :-3]
    raw = np.empty((h, w * 3 + 1), dtype=np.uint8)
    raw[:, 0] = 1
    raw[:, 1:] = f
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", zlib.compress(raw.tobytes(), 6)) + _chunk(b"IEND", b""))


# ---------------------------------------------------------------- reading audio

class _Src:
    """Random access to stereo float32 frames from a WAV (by seeking), any other file (via ffmpeg) or an array."""

    def __init__(self, src):
        self.wav = self.arr = self.tmp = None
        self.sr = SR
        if isinstance(src, (str, os.PathLike)):
            path = os.fspath(src)
            if not os.path.isfile(path):
                raise FileNotFoundError(f"no such audio file: {path}")
            self._open_file(path)
        else:
            a = np.asarray(src, dtype=np.float32)
            if a.ndim == 1:
                a = np.stack([a, a], axis=1)
            elif a.ndim == 2 and a.shape[1] == 1:
                a = np.repeat(a, 2, axis=1)
            elif a.ndim == 2 and a.shape[1] >= 2:
                a = a[:, :2]
            else:
                raise ValueError("audio array must be shaped [n] or [n, 2]")
            self.arr = a
        self.total = len(self.arr) if self.arr is not None else self.wav.getnframes()
        if self.total <= 0:
            self.close()
            raise ValueError("no audio samples to draw")

    def _open_file(self, path):
        try:
            w = wave.open(path, "rb")
            if w.getsampwidth() not in (1, 2, 3, 4) or w.getnframes() == 0:
                w.close()
                raise wave.Error("unsupported")
            if w.getframerate() != SR and shutil.which("ffmpeg"):
                w.close()
                raise wave.Error("resample")
            self.wav, self.sr = w, w.getframerate()
            return
        except (wave.Error, EOFError):
            pass
        if not shutil.which("ffmpeg"):
            raise ValueError(f"{path} is not a PCM WAV and ffmpeg is not installed to decode it")
        fd, tmp = tempfile.mkstemp(suffix=".f32")
        os.close(fd)
        self.tmp = tmp
        r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", path, "-f", "f32le", "-ac", "2",
                            "-ar", str(SR), tmp], capture_output=True)
        frames = os.path.getsize(tmp) // 8
        if r.returncode != 0 or frames == 0:
            self.close()
            raise ValueError(f"ffmpeg could not decode {path}: " + r.stderr.decode("utf-8", "replace").strip()[-200:])
        self.arr = np.memmap(tmp, dtype="<f4", mode="r", shape=(frames, 2))

    def read(self, start, n):
        """[m, 2] float32 frames from start, shorter than n only at the end of the file."""
        start = max(int(start), 0)
        n = max(min(int(n), self.total - start), 0)
        if n == 0:
            return np.zeros((0, 2), dtype=np.float32)
        if self.arr is not None:
            return np.nan_to_num(np.asarray(self.arr[start:start + n], dtype=np.float32))
        w = self.wav
        w.setpos(start)
        raw = w.readframes(n)
        sw, ch = w.getsampwidth(), w.getnchannels()
        if sw == 1:
            x = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
        elif sw == 2:
            x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        elif sw == 3:
            b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
            v = ((b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)) << 8)
            x = (v >> 8).astype(np.float32) / 8388608.0
        else:
            x = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
        x = x[: (len(x) // ch) * ch].reshape(-1, ch)
        return np.stack([x[:, 0], x[:, 1 if ch > 1 else 0]], axis=1)

    def close(self):
        if self.wav is not None:
            self.wav.close()
            self.wav = None
        if self.tmp:
            self.arr = None
            try:
                os.unlink(self.tmp)
            except OSError:
                pass
            self.tmp = None


# ---------------------------------------------------------------- analysis

def _scan(read_fn, total_samples, ncols):
    """One chunked pass: per-column min, max, rms of the mid channel, plus peak and the L/R correlation sums."""
    total = int(total_samples)
    if total <= 0 or ncols <= 0:
        raise ValueError("nothing to scan")
    n = min(int(ncols), total)
    edges = (np.arange(n + 1, dtype=np.int64) * total) // n
    mins, maxs, ms = np.zeros(n), np.zeros(n), np.zeros(n)
    peak = 0.0
    s = np.zeros(5)  # sum L, R, LL, RR, LR
    c = 0
    while c < n:
        c1 = c + 1
        while c1 < n and edges[c1] - edges[c] < CHUNK:
            c1 += 1
        x = np.asarray(read_fn(int(edges[c]), int(edges[c1] - edges[c])), dtype=np.float32)
        loc = edges[c:c1] - edges[c]
        if len(x) >= edges[c1] - edges[c]:
            mid = x.mean(axis=1) if x.ndim == 2 else x
            mins[c:c1] = np.minimum.reduceat(mid, loc)
            maxs[c:c1] = np.maximum.reduceat(mid, loc)
            cnt = np.diff(edges[c:c1 + 1]).astype(np.float64)
            ms[c:c1] = np.add.reduceat(mid.astype(np.float64) ** 2, loc) / cnt
            peak = max(peak, float(np.max(np.abs(x))))
            if x.ndim == 2:
                l, r = x[:, 0].astype(np.float64), x[:, 1].astype(np.float64)
                s += (l.sum(), r.sum(), (l * l).sum(), (r * r).sum(), (l * r).sum())
        c = c1
    m = total
    vl, vr = s[2] / m - (s[0] / m) ** 2, s[3] / m - (s[1] / m) ** 2
    corr = (s[4] / m - s[0] * s[1] / m / m) / math.sqrt(vl * vr) if vl > 1e-14 and vr > 1e-14 else 0.0
    idx = (np.arange(ncols) * n) // int(ncols)
    return mins[idx], maxs[idx], np.sqrt(ms[idx]), peak, float(max(-1.0, min(1.0, corr)))


def waveform_columns(read_fn, total_samples, ncols):
    """(mins, maxs, rms) of the mid channel for each of ncols equal slices of the file, read in chunks."""
    mins, maxs, rms, _, _ = _scan(read_fn, total_samples, ncols)
    return mins, maxs, rms


def spectrogram_columns(read_fn, total_samples, ncols, nfft=4096):
    """[ncols, nfft//2+1] magnitude in dB (0 dB is a full-scale sine): one Hann FFT of the mono mix centered on each column."""
    total = int(total_samples)
    if total <= 0 or ncols <= 0:
        raise ValueError("nothing to analyze")
    buf = np.zeros((ncols, nfft), dtype=np.float32)
    for i in range(ncols):
        s = int((i + 0.5) * total / ncols) - nfft // 2
        a, b = max(s, 0), min(s + nfft, total)
        if b > a:
            seg = np.asarray(read_fn(a, b - a), dtype=np.float32)
            if seg.ndim == 2:
                seg = seg.mean(axis=1)
            buf[i, a - s:a - s + len(seg)] = seg
    win = np.hanning(nfft + 1)[:-1].astype(np.float32)
    mag = np.abs(np.fft.rfft(buf * win, axis=1)) / (win.sum() / 2.0)
    return (20.0 * np.log10(mag + 1e-10)).astype(np.float32)


def _short_term(src, npts):
    """3 s loudness at npts evenly spaced times: (times in s, LUFS with -inf for silence)."""
    sr, total = src.sr, src.total
    half = int(1.5 * sr)
    times = (np.arange(npts) + 0.5) * total / npts
    vals = np.full(npts, -np.inf)
    for i, c in enumerate(times):
        a = max(int(c) - half, 0)
        x = src.read(a, min(int(c) + half, total) - a)
        if len(x) == 0 or float(np.max(np.abs(x))) < 1e-7:
            continue
        y = dsp.k_weight(x) if dsp is not None else x
        ms = float(np.mean(np.sum(np.asarray(y, dtype=np.float64) ** 2, axis=1)))
        if ms > 0:
            vals[i] = -0.691 + 10.0 * math.log10(ms)
    return times / sr, vals


def _gate(power):
    """Integrated LUFS of block powers: absolute gate at -70 LUFS, then relative gate 10 LU under the gated mean."""
    power = np.asarray(power, dtype=np.float64)
    power = power[power > 10.0 ** ((-70.0 + 0.691) / 10.0)]
    if len(power) == 0:
        return -120.0
    m = float(power.mean())
    keep = power[power > m * 0.1]
    if len(keep):
        m = float(keep.mean())
    return max(-0.691 + 10.0 * math.log10(m), -120.0)


def _gated_mean(v):
    """Integrated loudness estimated from a short-term curve in LUFS."""
    return _gate(10.0 ** ((v[np.isfinite(v)] + 0.691) / 10.0))


HOP = 4410  # 100 ms


def _hop_energy(src):
    """Mean K-weighted power (channels summed) of every 100 ms hop, computed in 20 s segments with 1 s of padding."""
    total, pad, core = src.total, src.sr, 200 * HOP
    out = []
    for a in range(0, total, core):
        b = min(a + core, total)
        pa = max(a - pad, 0)
        x = src.read(pa, min(b + pad, total) - pa)
        y = np.asarray(dsp.k_weight(x) if dsp is not None else x, dtype=np.float64)[a - pa:a - pa + (b - a)]
        p = (y * y).sum(axis=1)
        starts = np.arange(0, len(p), HOP)
        out.append(np.add.reduceat(p, starts) / np.diff(np.append(starts, len(p))))
    return np.concatenate(out)


def _curve_from_energy(e, npts, sr, total):
    """3 s loudness at npts times from the 100 ms energies: (times in s, LUFS with -inf for silence)."""
    times = (np.arange(npts) + 0.5) * total / npts
    cs = np.concatenate([[0.0], np.cumsum(e)])
    j = times / HOP
    lo = np.clip(np.floor(j - 15).astype(int), 0, len(e) - 1)
    hi = np.clip(np.ceil(j + 15).astype(int), lo + 1, len(e))
    ms = (cs[hi] - cs[lo]) / (hi - lo)
    vals = np.where(ms > 1e-14, -0.691 + 10.0 * np.log10(np.maximum(ms, 1e-30)), -np.inf)
    return times / sr, vals


def _band_db(spec, sr, nfft):
    p = (10.0 ** (spec.astype(np.float64) / 10.0)).mean(axis=0)
    f = np.arange(len(p)) * sr / nfft
    e = np.array([p[(f >= c / math.sqrt(2)) & (f < c * math.sqrt(2))].sum() for _, c in BANDS])
    top = e.max()
    if top <= 1e-18:
        return {k: -120.0 for k, _ in BANDS}
    return {k: round(max(10.0 * math.log10(max(v, 1e-30) / top), -120.0), 2) for (k, _), v in zip(BANDS, e)}


def _peak_hz(spec, sr, nfft):
    p = (10.0 ** (spec.astype(np.float64) / 10.0)).mean(axis=0)
    lo = max(int(math.ceil(20.0 * nfft / sr)), 1)
    k = lo + int(np.argmax(p[lo:-1]))
    delta = 0.0
    if p[k - 1] > 0 and p[k + 1] > 0 and p[k] > 0:
        a, b, c = math.log(p[k - 1]), math.log(p[k]), math.log(p[k + 1])
        den = a - 2 * b + c
        if den < 0:
            delta = max(-0.5, min(0.5, 0.5 * (a - c) / den))
    return float((k + delta) * sr / nfft)


# ---------------------------------------------------------------- drawing

def _cmap():
    stops = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0]
    cols = [(0, 0, 4), (40, 11, 84), (120, 28, 109), (200, 60, 80), (252, 140, 50), (252, 253, 191)]
    t = np.linspace(0, 1, 256)
    return np.stack([np.interp(t, stops, [c[i] for c in cols]) for i in range(3)], axis=1).round().astype(np.uint8)


CMAP = _cmap()


def _rect(img, x0, y0, x1, y1, color):
    h, w = img.shape[:2]
    x0, y0, x1, y1 = max(int(x0), 0), max(int(y0), 0), min(int(x1), w), min(int(y1), h)
    if x0 < x1 and y0 < y1:
        img[y0:y1, x0:x1] = color


def _blend_hline(img, x0, x1, y, color, a=0.3):
    if 0 <= y < img.shape[0]:
        seg = img[y, x0:x1].astype(np.float32)
        img[y, x0:x1] = (seg * (1 - a) + np.array(color, dtype=np.float32) * a).astype(np.uint8)


def _frame(img, x0, y0, w, h):
    _rect(img, x0, y0, x0 + w, y0 + 1, BORDER)
    _rect(img, x0, y0 + h - 1, x0 + w, y0 + h, BORDER)
    _rect(img, x0, y0, x0 + 1, y0 + h, BORDER)
    _rect(img, x0 + w - 1, y0, x0 + w, y0 + h, BORDER)


def _label_left(img, x0, y, s):
    draw_text(img, x0 - 5 - text_width(s), y - 3, s)


STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800]


def time_ticks(dur):
    """(step, [tick times]) with at most 12 ticks, as many as the step list allows."""
    step = next((s for s in STEPS if int(dur / s) + 1 <= 12), STEPS[-1])
    return step, [k * step for k in range(int(dur / step + 1e-9) + 1)]


def fmt_time(t, step):
    if step < 1:
        return f"{t:g}"
    t = int(round(t))
    h, rem = divmod(t, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _time_axis(img, x0, pw, ybottom, dur, label=True):
    step, ticks = time_ticks(dur)
    for t in ticks:
        x = x0 + int(round(t / dur * (pw - 1)))
        _rect(img, x, ybottom, x + 1, ybottom + 4, TEXT)
        if label:
            s = fmt_time(t, step)
            tw = text_width(s)
            draw_text(img, min(max(x - tw // 2, 2), img.shape[1] - tw - 2), ybottom + 7, s)


def _time_grid(img, x0, y0, pw, h, dur):
    for t in time_ticks(dur)[1][1:]:
        x = x0 + int(round(t / dur * (pw - 1)))
        _blend_hline_v(img, x, y0, y0 + h, GRID)


def _blend_hline_v(img, x, y0, y1, color):
    if 0 <= x < img.shape[1]:
        img[y0:y1, x] = color


def _markers(img, marks, x0, pw, y0, h, dur):
    last = -1000
    for t, label in marks:
        x = x0 + int(round(t / dur * (pw - 1)))
        _rect(img, x, y0 + 1, x + 1, y0 + h - 1, MARK)
        lab = _clean(label)
        if lab and x > last:
            tw = text_width(lab)
            _rect(img, x + 2, y0 + 2, x + 6 + tw, y0 + 12, BG)
            draw_text(img, x + 4, y0 + 4, lab, MARK)
            last = x + 8 + tw


def _nice(span, maxn):
    for s in (1, 2, 3, 5, 6, 10, 12, 20, 30, 50, 100):
        if span / s <= maxn:
            return s
    return 100


def make_sheet(src, out_png, markers=None, target_lufs=None, width=1600, title_text=None):
    """Draws the contact sheet to out_png and returns the numbers it shows."""
    width = int(width)
    if width < 640:
        raise ValueError("width must be at least 640")
    s = _Src(src)
    try:
        return _make(s, src, out_png, markers or [], target_lufs, width, title_text)
    finally:
        s.close()


def _make(s, src, out_png, markers, target_lufs, width, title_text):
    sr, total = s.sr, s.total
    dur = total / sr
    X0, PW = 70, width - 90
    ncols = PW
    read = s.read

    mins, maxs, rms, peak, corr = _scan(read, total, ncols)
    spec = spectrogram_columns(read, total, ncols, 4096)
    if total < 8 * 60 * sr:
        e = _hop_energy(s)
        lt, lv = _curve_from_energy(e, min(ncols, max(8, len(e))), sr, total)
        blocks = np.convolve(e, np.ones(4) / 4, mode="valid") if len(e) >= 4 else e.mean(keepdims=True)
        lufs = _gate(blocks)
    else:
        lt, lv = _short_term(s, 400)
        lufs = _gated_mean(lv)
    bands = _band_db(spec, sr, 4096)
    peak_db = max(20.0 * math.log10(peak), -120.0) if peak > 0 else -120.0
    peak_hz = _peak_hz(spec, sr, 4096)

    H = 880
    img = np.empty((H, width, 3), dtype=np.uint8)
    img[:] = BG

    name = title_text if title_text is not None else (os.path.basename(os.fspath(src)) if isinstance(src, (str, os.PathLike)) else "AUDIO")
    name = _clean(name)[:36]
    draw_text(img, X0, 5, name, TEXT, 2)
    info = f"{fmt_time(dur, 1)}  PEAK {peak_db:.1f} DB  {lufs:.1f} LUFS  CORR {corr:.2f}  PEAK AT {peak_hz:.0f} HZ"
    draw_text(img, X0 + text_width(name, 2) + 24, 9, info)

    marks = sorted((float(t), l) for t, l in markers if 0 <= float(t) <= dur)

    # 1. waveform
    y0, h = 34, 170
    draw_text(img, X0, y0 - 9, "WAVEFORM  DB")
    cy, half = y0 + h // 2, h // 2 - 2
    _time_grid(img, X0, y0, PW, h, dur)

    def amp(a):
        return np.clip((20.0 * np.log10(np.maximum(a, 1e-9)) + 54.0) / 54.0, 0.0, 1.0)

    for db in (-6, -12, -24, -48):
        f = (db + 54.0) / 54.0
        for yy in (cy - int(round(f * half)), cy + int(round(f * half))):
            _blend_hline(img, X0, X0 + PW, yy, TEXT, 0.18)
        _label_left(img, X0, cy - int(round(f * half)), str(db))
    _blend_hline(img, X0, X0 + PW, cy, TEXT, 0.3)
    up, dn = amp(np.maximum(maxs, 0)) * half, amp(np.maximum(-mins, 0)) * half
    ur = amp(rms) * half
    for x in range(PW):
        _rect(img, X0 + x, cy - int(round(up[x])), X0 + x + 1, cy + int(round(dn[x])) + 1, ENV)
        _rect(img, X0 + x, cy - int(round(ur[x])), X0 + x + 1, cy + int(round(ur[x])) + 1, RMS)
    _frame(img, X0, y0, PW, h)
    _markers(img, marks, X0, PW, y0, h, dur)
    _time_axis(img, X0, PW, y0 + h, dur)

    # 2. spectrogram
    y0, h = 232, 300
    draw_text(img, X0, y0 - 9, "SPECTROGRAM  HZ")
    fmin, fmax = 30.0, min(18000.0, sr * 0.5 * 0.99)
    binhz = sr / 4096.0
    sn = (np.clip((spec - (float(spec.max()) - 90.0)) / 90.0, 0.0, 1.0)).T.astype(np.float32)
    nb = sn.shape[0]
    ratio = fmax / fmin
    rows = np.empty((h, PW), dtype=np.float32)
    for r in range(h):
        flo, fhi = fmax * ratio ** (-(r + 1) / h), fmax * ratio ** (-r / h)
        lo, hi = int(math.floor(flo / binhz)), int(math.ceil(fhi / binhz))
        if hi - lo > 1:
            rows[r] = sn[min(lo, nb - 1):min(hi + 1, nb)].max(axis=0)
        else:
            pos = math.sqrt(flo * fhi) / binhz
            i0 = min(int(pos), nb - 2)
            fr = pos - i0
            rows[r] = sn[i0] * (1 - fr) + sn[i0 + 1] * fr
    img[y0:y0 + h, X0:X0 + PW] = CMAP[(rows * 255).astype(np.uint8)]
    for f in (50, 100, 200, 500, 1000, 2000, 5000, 10000):
        if fmin < f < fmax:
            yy = y0 + int(round(h * (1 - math.log(f / fmin) / math.log(ratio))))
            _blend_hline(img, X0, X0 + PW, yy, TEXT, 0.22)
            _label_left(img, X0, yy, f"{f // 1000}K" if f >= 1000 else str(f))
    _frame(img, X0, y0, PW, h)
    _markers(img, marks, X0, PW, y0, h, dur)
    _time_axis(img, X0, PW, y0 + h, dur)

    # 3. short-term loudness
    y0, h = 566, 140
    draw_text(img, X0, y0 - 9, "SHORT-TERM LOUDNESS  LUFS")
    fin = lv[lv > -70.0]
    pool = list(fin) + ([float(target_lufs)] if target_lufs is not None else [])
    lo, hi = (min(pool) - 6.0, max(pool) + 6.0) if pool else (-60.0, 0.0)
    if hi - lo < 12:
        mid = (hi + lo) / 2
        lo, hi = mid - 6, mid + 6
    _time_grid(img, X0, y0, PW, h, dur)

    def ly(v):
        return y0 + 1 + (hi - np.clip(v, lo, hi)) / (hi - lo) * (h - 3)

    st = _nice(hi - lo, 5)
    v = math.ceil(lo / st) * st
    while v <= hi:
        yy = int(round(float(ly(v))))
        _blend_hline(img, X0, X0 + PW, yy, TEXT, 0.18)
        _label_left(img, X0, yy, str(int(v)))
        v += st
    if target_lufs is not None:
        yy = int(round(float(ly(float(target_lufs)))))
        for xx in range(X0, X0 + PW, 10):
            _rect(img, xx, yy, min(xx + 6, X0 + PW), yy + 1, TARGET)
        draw_text(img, X0 + PW - 4 - text_width(f"TARGET {target_lufs:g}"), yy - 10, f"TARGET {target_lufs:g}", TARGET)
    xs = np.arange(PW)
    tx = lt / dur * (PW - 1)
    ys = np.round(ly(np.interp(xs, tx, np.where(np.isfinite(lv), lv, lo - 100)))).astype(int)
    live = np.interp(xs, tx, np.isfinite(lv).astype(float)) > 0.99
    for x in range(PW):
        if live[x]:
            a = ys[x - 1] if x and live[x - 1] else ys[x]
            _rect(img, X0 + x, min(a, ys[x]), X0 + x + 1, max(a, ys[x]) + 2, LOUD)
    _frame(img, X0, y0, PW, h)
    _markers(img, marks, X0, PW, y0, h, dur)
    _time_axis(img, X0, PW, y0 + h, dur)

    # 4. octave bands
    y0, h = 752, 100
    draw_text(img, X0, y0 - 9, "OCTAVE BANDS  HZ  DB BELOW LOUDEST")
    top, bot = y0 + 14, y0 + h - 2
    for db in (0, -20, -40, -60):
        yy = top + int(round(-db / 60.0 * (bot - top)))
        _blend_hline(img, X0, X0 + PW, yy, TEXT, 0.18)
        _label_left(img, X0, yy, str(db))
    sw = PW / len(BANDS)
    for i, (k, _) in enumerate(BANDS):
        d = bands[k]
        yb = top + int(round(min(-d, 60.0) / 60.0 * (bot - top)))
        bx = X0 + int(i * sw + sw * 0.2)
        _rect(img, bx, yb, X0 + int(i * sw + sw * 0.8), bot, BAR)
        lab = f"{d:.0f}"
        draw_text(img, X0 + int(i * sw + sw / 2) - text_width(lab) // 2, max(yb - 10, y0 + 2), lab)
        draw_text(img, X0 + int(i * sw + sw / 2) - text_width(k) // 2, y0 + h + 6, k)
    _frame(img, X0, y0, PW, h)

    with open(out_png, "wb") as f:
        f.write(png_bytes(img))
    return {"duration_s": round(dur, 3), "width": width, "height": H, "peak_dbfs": round(peak_db, 2),
            "lufs": round(lufs, 2), "band_db": bands, "correlation": round(corr, 3), "spec_peak_hz": round(peak_hz, 1)}


# ---------------------------------------------------------------- command line

def _parse_marker(text):
    sec, _, label = text.partition(":")
    return float(sec), label


def main(argv=None):
    ap = argparse.ArgumentParser(description="Draw a contact sheet PNG of an audio file.")
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--marker", action="append", default=[], metavar="SECONDS[:LABEL]")
    ap.add_argument("--target-lufs", type=float, default=None)
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    try:
        marks = [_parse_marker(m) for m in a.marker]
        info = make_sheet(a.input, a.output, markers=marks, target_lufs=a.target_lufs, width=a.width)
    except (OSError, ValueError) as e:
        print(f"sheet.py: {e}", file=sys.stderr)
        return 2
    if a.json:
        print(json.dumps(info))
    else:
        for k, v in info.items():
            print(f"{k}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
