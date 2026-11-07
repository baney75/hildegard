# SPDX-License-Identifier: AGPL-3.0-only
"""The built-in instruments and drum kits for music.py: synthesized with subtractive, additive, FM and plucked-string
models, numpy only. Not run on its own.

voice(name, midi, dur, vel, a, r) -> mono array: dur seconds held plus r seconds of release, at a steady loudness
(RMS about -20 dBFS while it sounds), so the mix levels in a score mean the same thing for every instrument.
"""
import math

import numpy as np

import dsp
from dsp import SR

# role, one-line description. The first entry of each role is its default.
INSTRUMENTS = {
    "warm_pad": ("pad", "detuned saws with a slow filter: a warm bed under everything", 0.55, 1.1),
    "strings": ("pad", "bowed ensemble: saws with vibrato and a bright filter", 0.30, 0.6),
    "glass_pad": ("pad", "soft airy tone with a slow shimmer: calm, ambient", 0.9, 1.4),
    "choir": ("pad", "an ensemble of voices on one vowel (formant filtered)", 0.35, 0.7),
    "organ": ("keys", "church-style drawbar organ with a gentle tremolo", 0.012, 0.09),
    "piano": ("keys", "additive piano with inharmonic partials and a hammer thump", 0.002, 0.45),
    "felt_piano": ("keys", "a darker, softer piano: lo-fi, intimate", 0.004, 0.5),
    "epiano": ("keys", "FM electric piano (tine and tone bar): warm, a little bell on the attack", 0.002, 0.4),
    "bell": ("keys", "inharmonic FM bell: music box, chimes, sparkle", 0.001, 1.0),
    "nylon_guitar": ("plucked", "plucked nylon string (waveguide): warm, short sustain", 0.001, 0.25),
    "steel_guitar": ("plucked", "plucked steel string: brighter and longer", 0.001, 0.3),
    "harp": ("plucked", "plucked harp string: pure, long ring", 0.001, 0.5),
    "pluck_synth": ("plucked", "short synth pluck with a closing filter", 0.001, 0.2),
    "sub_bass": ("bass", "a round sine bass with a little third harmonic", 0.006, 0.10),
    "synth_bass": ("bass", "saw and square bass with a filter that snaps shut", 0.003, 0.08),
    "upright_bass": ("bass", "plucked string bass, woody and short", 0.002, 0.12),
    "flute": ("lead", "breathy flute: sine with air and delayed vibrato", 0.07, 0.15),
    "synth_lead": ("lead", "two detuned saws through a filter, with vibrato", 0.01, 0.15),
    "soft_lead": ("lead", "mellow triangle lead: lo-fi melodies", 0.02, 0.2),
    "violin": ("lead", "solo bowed string with vibrato and body resonance", 0.08, 0.2),
    "choir_solo": ("lead", "one voice on a vowel", 0.12, 0.25),
}
ROLE_DEFAULT = {"pad": "warm_pad", "keys": "piano", "plucked": "nylon_guitar", "bass": "upright_bass", "melody": "flute", "lead": "flute", "chorale": "choir"}

KITS = {
    "acoustic": {"k0": 115, "k1": 54, "kd": 0.30, "kclick": 0.35, "s_tone": 0.55, "s_noise": 1.0, "s_lp": 11000, "h_hp": 6500, "drive": 3},
    "electronic": {"k0": 160, "k1": 52, "kd": 0.34, "kclick": 0.25, "s_tone": 0.35, "s_noise": 1.0, "s_lp": 14000, "h_hp": 8000, "drive": 7},
    "lofi": {"k0": 105, "k1": 52, "kd": 0.28, "kclick": 0.2, "s_tone": 0.5, "s_noise": 0.8, "s_lp": 5200, "h_hp": 5000, "drive": 5, "lp": 7500},
    "soft": {"k0": 100, "k1": 50, "kd": 0.26, "kclick": 0.12, "s_tone": 0.4, "s_noise": 0.6, "s_lp": 6500, "h_hp": 5500, "drive": 1, "lp": 9000},
}
DRUMS = ("kick", "snare", "snare_brush", "clap", "hat", "hat_open", "shaker", "rim", "tom", "ride")


def hz(m):
    return float(dsp.midi_to_hz(m))


def _rng(*key):
    return np.random.default_rng([abs(int(k)) % (2**31) for k in key])


def _norm_rms(y, target=0.1, span=1.0):
    seg = y[: int(span * SR)]
    seg = seg[np.abs(seg) > 1e-6]
    rms = math.sqrt(float(np.mean(seg * seg))) if len(seg) else 0.0
    return y * (target / rms) if rms > 1e-9 else y


def _env(n, a, r):
    return dsp.adsr(n, a, 0.0, 1.0, r)


def _count(dur, r):
    return max(int((dur + r) * SR), 64)


def _vib(n, rate, cents, delay=0.2, seed=0.0):
    t = np.arange(n) / SR
    ramp = np.clip((t - delay) / 0.4, 0.0, 1.0)
    return 2.0 ** (cents / 1200.0 * ramp * np.sin(2 * np.pi * rate * t + seed))


def _pad_saws(f0, n, detunes, vib=None, tri_sub=0.0):
    y = np.zeros(n)
    for i, c in enumerate(detunes):
        f = f0 * 2.0 ** (c / 1200.0) * (_vib(n, vib[0], vib[1], 0.25, i * 1.3) if vib else 1.0)
        y += dsp.oscillator("saw", np.broadcast_to(f, (n,)), phase0=i * 0.37)
    y /= len(detunes)
    if tri_sub:
        y += tri_sub * dsp.oscillator("triangle", np.full(n, f0 * 0.5))
    return y


def warm_pad(m, dur, vel, a, r):
    n = _count(dur, r)
    y = _pad_saws(hz(m), n, [-9, 0, 8, 14], vib=(0.27, 4), tri_sub=0.6)
    t = np.arange(n) / SR
    cut = np.minimum(900.0 + 1400.0 * (1 - np.exp(-t / 1.2)) + hz(m) * 0.8, 4200.0)
    y = dsp.filt(y, "lowpass", cut, 0.8)
    return y * _env(n, a, r)


def strings(m, dur, vel, a, r):
    n = _count(dur, r)
    y = _pad_saws(hz(m), n, [-11, -5, 4, 10], vib=(5.2, 7))
    y = dsp.filt(y, "lowpass", min(2600.0 + hz(m) * 3.0, 7000.0), 0.9)
    bow = dsp.filt(_rng(m, 1).standard_normal(n) * 0.03, "bandpass", 2500.0, 0.8)
    return (y + bow) * _env(n, a, r)


def glass_pad(m, dur, vel, a, r):
    n = _count(dur, r)
    f0 = hz(m)
    y = np.zeros(n)
    t = np.arange(n) / SR
    for k, g, c in [(1, 1.0, -4), (1, 0.8, 5), (2, 0.35, 0), (3, 0.12, 3), (4, 0.06, -3)]:
        trem = 1.0 + 0.25 * np.sin(2 * np.pi * (0.2 + 0.07 * k) * t + k)
        y += g * trem * np.sin(2 * np.pi * f0 * k * 2.0 ** (c / 1200.0) * t + k)
    y += 0.12 * dsp.fm_pair(np.full(n, f0 * 2.0), 3.01, 0.5 + 0.5 * np.sin(2 * np.pi * 0.13 * t))
    return y * _env(n, a, r)


def _formant(y, vowel, strength=1.0):
    F = {"ah": [(800, 7, 16), (1150, 8, 12), (2900, 9, 8)], "oo": [(350, 6, 16), (700, 8, 8), (2700, 9, 6)], "oh": [(500, 6, 16), (900, 8, 11), (2830, 9, 7)]}[vowel]
    bands = [{"type": "peak", "freq": f, "gain_db": g * strength, "q": q} for f, q, g in F]
    bands.append({"type": "highcut", "freq": 5200})
    bands.append({"type": "lowcut", "freq": 110})
    return dsp.apply_eq(y, bands)


def _voices(m, n, count, seed, vowel="ah"):
    f0 = hz(m)
    out = np.zeros(n)
    for i in range(count):
        c = (i - (count - 1) / 2.0) * 9.0
        f = f0 * 2.0 ** (c / 1200.0) * _vib(n, 5.0 + 0.4 * i, 11, 0.35, i * 2.1)
        out += dsp.oscillator("saw", f, phase0=i * 0.21)
    out /= count
    out += dsp.filt(_rng(m, seed).standard_normal(n) * 0.04, "bandpass", 1800.0, 0.8)
    return _formant(out, vowel)


def choir(m, dur, vel, a, r):
    n = _count(dur, r)
    return _voices(m, n, 4, 3) * _env(n, a, r)


def choir_solo(m, dur, vel, a, r):
    n = _count(dur, r)
    return _voices(m, n, 1, 4, "oh") * _env(n, a, r)


def organ(m, dur, vel, a, r):
    n = _count(dur, r)
    f0 = hz(m)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for mult, g in [(0.5, 0.5), (1, 1.0), (2, 0.75), (3, 0.45), (4, 0.4), (6, 0.2), (8, 0.14)]:
        if f0 * mult < SR * 0.45:
            y += g * np.sin(2 * np.pi * f0 * mult * t)
    y *= 1.0 + 0.07 * np.sin(2 * np.pi * 5.6 * t)
    y += dsp.filt(_rng(m, 5).standard_normal(n) * np.exp(-t / 0.015) * 0.25, "highpass", 1500.0)
    return dsp.filt(y, "lowpass", 5200.0, 0.7) * _env(n, a, r)


def _piano(m, dur, vel, a, r, soft):
    n = _count(dur, r) + int(0.0 * SR)
    f0 = hz(m)
    t = np.arange(n) / SR
    K = int(min(24, SR * 0.45 / f0))
    k = np.arange(1, K + 1)[:, None]
    B = 0.00015 * (f0 / 130.0) ** 1.4
    fk = k * f0 * np.sqrt(1.0 + B * k * k)
    bright = (0.5 + 0.9 * vel) * (0.55 if soft else 1.0)
    amp = np.exp(-(k - 1) * (1.25 - bright) * 0.55) / k ** 0.9
    amp = amp * (np.abs(np.sin(np.pi * k / 8.0 + 0.25)) * 0.8 + 0.35)
    tau = (3.4 - 1.6 * np.clip((m - 36) / 60.0, 0, 1)) / (1.0 + 0.3 * (k - 1))
    ph = 2 * np.pi * fk * t
    y = np.sum(amp * np.exp(-t / tau) * 0.5 * (np.sin(ph) + np.sin(ph * (1.0 + 0.0007) + k)), axis=0)
    knock = np.convolve(_rng(m, 7).standard_normal(n), np.ones(24) / 24.0, "same") * np.exp(-t / 0.012) * (0.5 + vel) * 0.25
    y = y + knock
    if soft:
        y = dsp.filt(y, "lowpass", 1900.0 + 800.0 * vel, 0.7)
    return y * dsp.adsr(n, a, 0.0, 1.0, r)


def piano(m, dur, vel, a, r):
    return _piano(m, dur, vel, a, r, False)


def felt_piano(m, dur, vel, a, r):
    return _piano(m, dur, vel * 0.8, a, r, True)


def epiano(m, dur, vel, a, r):
    n = _count(dur, r)
    f = np.full(n, hz(m))
    t = np.arange(n) / SR
    idx = (0.35 + 1.5 * vel) * np.exp(-t / 0.5) + 0.2
    body = dsp.fm_pair(f, 1.0, idx)
    tine = dsp.fm_pair(f * 1.0, 14.0, 0.8 * vel * np.exp(-t / 0.04)) * np.exp(-t / 0.15) * 0.25
    y = (body + tine) * np.exp(-t / (2.4 - 1.2 * np.clip((m - 40) / 50.0, 0, 1)))
    y *= 1.0 + 0.05 * np.sin(2 * np.pi * 5.0 * t)
    return y * dsp.adsr(n, a, 0.0, 1.0, r)


def bell(m, dur, vel, a, r):
    n = _count(dur, r)
    f0 = hz(m)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for ratio, g, tau in [(1.0, 1.0, 1.6), (2.76, 0.5, 0.8), (5.4, 0.25, 0.45), (8.93, 0.12, 0.25)]:
        if f0 * ratio < SR * 0.45:
            y += g * np.exp(-t / tau) * np.sin(2 * np.pi * f0 * ratio * t)
    y += 0.3 * dsp.fm_pair(np.full(n, f0), 3.5, 1.2 * np.exp(-t / 0.3)) * np.exp(-t / 1.0)
    return y * dsp.adsr(n, a, 0.0, 1.0, r)


def _pluck(m, dur, vel, a, r, t60, soft, damp, pulse=False, body=None):
    f = hz(m)
    n_out = _count(dur, r)
    D = max(int(SR / f - damp), 4)
    f_eff = SR / (D + damp)
    ratio = f / f_eff
    n_ks = int(n_out * ratio) + D * 2
    rng = _rng(m, 11)
    exc = rng.standard_normal(D)
    if pulse:
        exc = np.sin(np.pi * np.arange(D) / D) * (1.0 + 0.3 * exc)
    w = 1 + int(soft)
    if w > 1:
        exc = np.convolve(np.concatenate([exc[-w:], exc]), np.ones(w) / w, "same")[w:]
    exc *= 0.6 + 0.8 * vel
    x = np.zeros(n_ks)
    x[:D] = exc
    t60 = t60 * (f / 220.0) ** -0.35
    g = 10.0 ** (-3.0 / (max(t60, 0.2) * f_eff))
    y = dsp._comb(x, D, min(g, 0.9995), damp)
    y = dsp.resample_by(y, ratio)[:n_out]
    if len(y) < n_out:
        y = np.pad(y, (0, n_out - len(y)))
    if body:
        y = dsp.apply_eq(y, body)
    y = y - y.mean()
    return y * dsp.adsr(n_out, a, 0.0, 1.0, r)


GUITAR_BODY = [{"type": "peak", "freq": 105, "gain_db": 5, "q": 2.5}, {"type": "peak", "freq": 230, "gain_db": 3, "q": 2.0}, {"type": "peak", "freq": 3000, "gain_db": 1.5, "q": 0.8}]


def nylon_guitar(m, dur, vel, a, r):
    return _pluck(m, dur, vel, a, r, 2.6, 5, 0.5, body=GUITAR_BODY)


def steel_guitar(m, dur, vel, a, r):
    return _pluck(m, dur, vel, a, r, 3.4, 2, 0.42, body=GUITAR_BODY)


def harp(m, dur, vel, a, r):
    return _pluck(m, dur, vel, a, r, 4.5, 2, 0.48, pulse=True)


def upright_bass(m, dur, vel, a, r):
    y = _pluck(m, dur, vel, a, r, 1.5, 6, 0.5, body=[{"type": "peak", "freq": 90, "gain_db": 4, "q": 1.5}, {"type": "highcut", "freq": 1400}])
    t = np.arange(len(y)) / SR
    thump = np.sin(2 * np.pi * hz(m) * t) * np.exp(-t / 0.18) * 0.5
    return (y + thump) * 1.0


def pluck_synth(m, dur, vel, a, r):
    n = _count(dur, r)
    f = hz(m)
    y = 0.6 * dsp.oscillator("saw", np.full(n, f)) + 0.4 * dsp.oscillator("saw", np.full(n, f * 1.007))
    t = np.arange(n) / SR
    cut = 350.0 + (3500.0 + f * 2) * np.exp(-t / 0.12) * (0.4 + 0.6 * vel)
    y = dsp.filt(y, "lowpass", np.minimum(cut, 9000.0), 1.4)
    return y * np.exp(-t / 0.45) * dsp.adsr(n, a, 0.0, 1.0, r)


def sub_bass(m, dur, vel, a, r):
    n = _count(dur, r)
    f = hz(m)
    t = np.arange(n) / SR
    y = np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t + 0.5) + 0.12 * np.sin(6 * np.pi * f * t)
    y = np.tanh(y * 1.4) * np.exp(-t / 1.6)
    return y * dsp.adsr(n, a, 0.0, 1.0, r)


def synth_bass(m, dur, vel, a, r):
    n = _count(dur, r)
    f = hz(m)
    t = np.arange(n) / SR
    y = dsp.oscillator("saw", np.full(n, f)) * 0.7 + dsp.oscillator("square", np.full(n, f * 1.004), 0.5) * 0.5
    cut = 160.0 + (900.0 + f * 6) * np.exp(-t / 0.14)
    y = dsp.filt(y, "lowpass", np.minimum(cut, 6000.0), 2.2)
    return np.tanh(y * 1.2) * dsp.adsr(n, a, 0.0, 1.0, r)


def flute(m, dur, vel, a, r):
    n = _count(dur, r)
    f = np.full(n, hz(m)) * _vib(n, 5.0, 10, 0.3)
    t = np.arange(n) / SR
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.18 * np.sin(4 * np.pi * np.cumsum(f) / SR) + 0.05 * np.sin(6 * np.pi * np.cumsum(f) / SR)
    air = dsp.filt(_rng(m, 13).standard_normal(n) * 0.12, "bandpass", min(hz(m) * 2.5, 6000.0), 1.2) * (0.5 + 0.5 * np.exp(-t / 0.08))
    return (y + air) * dsp.adsr(n, a, 0.12, 0.9, r)


def synth_lead(m, dur, vel, a, r):
    n = _count(dur, r)
    f = hz(m) * _vib(n, 5.4, 12, 0.25)
    y = 0.5 * dsp.oscillator("saw", f) + 0.5 * dsp.oscillator("saw", f * 1.006, phase0=0.3)
    y = dsp.filt(y, "lowpass", min(2600.0 + hz(m) * 4.0, 8000.0), 1.3)
    return y * dsp.adsr(n, a, 0.1, 0.85, r)


def soft_lead(m, dur, vel, a, r):
    n = _count(dur, r)
    f = hz(m) * _vib(n, 4.8, 9, 0.3)
    y = dsp.oscillator("triangle", f) + 0.25 * dsp.oscillator("sine", f * 2.0)
    y = dsp.filt(y, "lowpass", 2400.0, 0.7)
    return y * dsp.adsr(n, a, 0.15, 0.8, r)


def violin(m, dur, vel, a, r):
    n = _count(dur, r)
    f = hz(m) * _vib(n, 5.5, 17, 0.2)
    y = 0.5 * dsp.oscillator("saw", f) + 0.5 * dsp.oscillator("saw", f * 1.004, phase0=0.4)
    y = dsp.apply_eq(y, [{"type": "peak", "freq": 450, "gain_db": 6, "q": 3}, {"type": "peak", "freq": 1100, "gain_db": 5, "q": 2.5}, {"type": "peak", "freq": 2600, "gain_db": 4, "q": 2}, {"type": "highcut", "freq": 7000}])
    y += dsp.filt(_rng(m, 17).standard_normal(n) * 0.035, "bandpass", 3000.0, 0.8)
    return y * dsp.adsr(n, a, 0.15, 0.9, r)


DECAYING = {"piano", "felt_piano", "epiano", "bell", "nylon_guitar", "steel_guitar", "harp", "pluck_synth", "upright_bass"}
FUNCS = {k: v for k, v in globals().items() if k in INSTRUMENTS}


def voice(name, m, dur, vel, a=None, r=None):
    """One note of an instrument. a and r (seconds) replace the instrument's attack and release."""
    _, _, da, dr = INSTRUMENTS[name]
    y = FUNCS[name](m, dur, vel, da if a is None else a, dr if r is None else r)
    y = _norm_rms(y, 0.1, 0.3 if name in DECAYING else 1.0)
    return dsp.fade_edges(y, 0.0, 0.002)


# ---------------------------------------------------------------- drums


def _drum_noise(kind, n, name, lo=None, hi=None, q=0.7):
    x = _rng(sum(map(ord, name)), n).standard_normal(n) * 0.5
    if lo:
        x = dsp.filt(x, "highpass", lo, q)
    if hi:
        x = dsp.filt(x, "lowpass", hi, q)
    return x


def drum(name, kit, vel, variant=0):
    """A drum hit, peak about 0.8 * vel."""
    p = KITS[kit]
    t = lambda n: np.arange(n) / SR
    if name in ("kick",):
        n = int(0.6 * SR)
        tt = t(n)
        f = p["k1"] + (p["k0"] - p["k1"]) * np.exp(-tt / 0.028)
        y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / p["kd"])
        y = np.tanh(y * (1.0 + p["drive"] * 0.3))
        click = np.convolve(_rng(variant, 3).standard_normal(n), np.ones(6) / 6.0, "same") * np.exp(-tt / 0.004) * p["kclick"]
        y = y + click
    elif name == "snare":
        n = int(0.4 * SR)
        tt = t(n)
        noise = _drum_noise("w", n, "snare" + str(variant), 1400.0, p["s_lp"]) * np.exp(-tt / 0.11) * p["s_noise"]
        tone = (np.sin(2 * np.pi * 185.0 * tt) * np.exp(-tt / 0.07) + 0.5 * np.sin(2 * np.pi * 330.0 * tt) * np.exp(-tt / 0.045)) * p["s_tone"]
        y = noise * 1.1 + tone * 0.9
    elif name == "snare_brush":
        n = int(0.4 * SR)
        tt = t(n)
        env = np.minimum(tt / 0.012, 1.0) * np.exp(-tt / 0.13)
        y = _drum_noise("w", n, "brush" + str(variant), 900.0, 7500.0) * env + 0.1 * np.sin(2 * np.pi * 200 * tt) * np.exp(-tt / 0.05)
    elif name == "clap":
        n = int(0.4 * SR)
        tt = t(n)
        raw = _drum_noise("w", n, "clap" + str(variant), 900.0, 3800.0, 1.2)
        env = np.zeros(n)
        for off in (0.0, 0.011, 0.023):
            m = tt >= off
            env[m] += np.exp(-(tt[m] - off) / 0.006) * 0.7
        env += np.where(tt >= 0.03, np.exp(-(tt - 0.03) / 0.07), 0.0)
        y = raw * env
    elif name in ("hat", "hat_open"):
        dec = 0.025 if name == "hat" else 0.16
        n = int(min(dec * 8, 0.8) * SR)
        tt = t(n)
        y = _drum_noise("w", n, name + str(variant), p["h_hp"], 15000.0) * np.exp(-tt / dec)
        metal = sum(np.sign(np.sin(2 * np.pi * f * tt)) for f in (4180, 5870, 6930, 8210, 9380, 10750)) / 6.0
        y = y + 0.18 * dsp.filt(metal * np.exp(-tt / dec), "highpass", p["h_hp"], 0.7)
    elif name == "shaker":
        n = int(0.15 * SR)
        tt = t(n)
        y = _drum_noise("w", n, "shaker" + str(variant), 4500.0, 11000.0) * np.minimum(tt / 0.012, 1.0) * np.exp(-tt / 0.04)
    elif name == "rim":
        n = int(0.12 * SR)
        tt = t(n)
        y = np.sin(2 * np.pi * 1750.0 * tt) * np.exp(-tt / 0.008) * 0.6 + _drum_noise("w", n, "rim" + str(variant), 2500.0, 8000.0) * np.exp(-tt / 0.01)
    elif name == "tom":
        n = int(0.5 * SR)
        tt = t(n)
        f = 95.0 + 85.0 * np.exp(-tt / 0.05)
        y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-tt / 0.22) + _drum_noise("w", n, "tom", 1500.0, 6000.0) * np.exp(-tt / 0.01) * 0.15
    else:  # ride
        n = int(1.2 * SR)
        tt = t(n)
        metal = sum(np.sin(2 * np.pi * f * tt + i) for i, f in enumerate((3210, 4630, 5420, 6870, 8340))) / 5.0
        y = (metal * np.exp(-tt / 0.5) * 0.8 + _drum_noise("w", n, "ride", 5000.0, 14000.0) * np.exp(-tt / 0.18)) * np.minimum(tt / 0.002, 1.0)
    if "lp" in p and name not in ("kick", "tom"):
        y = dsp.filt(y, "lowpass", p["lp"], 0.7)
    pk = float(np.max(np.abs(y))) or 1.0
    y = y / pk * 0.8 * vel
    return dsp.fade_edges(y, 0.0, 0.005)
