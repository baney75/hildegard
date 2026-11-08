#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Render a sound effect from a JSON recipe. Python 3.10+, standard library plus numpy; ffmpeg only for .mp3 and .ogg.

  python3 sfx.py recipe.json out.wav [--check]     render a recipe (a bare preset name like "coin" works too)
  python3 sfx.py recipe.json --check               validate and measure only; writes nothing
  python3 sfx.py --preset coin out.wav             render a preset from ../presets/
  python3 sfx.py --list                            the presets, with their one-line notes
  options: --seed N (replace the recipe's seed), --json (the report as JSON), --bits 16|24

--check reports unknown fields, values out of range, a clipping mix, loudness off target, silence, DC offset and
odd length. Errors make the exit status 1 and no file is written. The recipe format is in ../SKILL.md; every file in
../presets/ is a working example. The same seed always gives the same sound.
"""
import argparse
import glob
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import dsp  # noqa: E402
from dsp import SR  # noqa: E402

SOURCES = ["sine", "triangle", "saw", "square", "white", "pink", "brown", "fm", "sample"]
NOISES = ("white", "pink", "brown")
CURVE = ("enum", ["lin", "exp", "fast"])

LAYER = ("obj", {
    "source": ("enum", SOURCES),
    "freq": ("freq", 10, 20000),
    "freq_points": ("pts", 10, 20000),
    "sweep": ("obj", {"to": ("freq", 10, 20000), "time": ("num", 0.001, 30), "curve": CURVE}, ["to", "time"]),
    "vibrato": ("obj", {"rate": ("num", 0.1, 30), "depth_cents": ("num", 0, 1200), "delay": ("num", 0, 10)}, ["rate", "depth_cents"]),
    "pulse_width": ("num", 0.05, 0.95),
    "fm": ("obj", {"ratio": ("num", 0.1, 16), "index": ("num", 0, 20), "index_points": ("pts", 0, 20)}, []),
    "file": ("str",),
    "rate": ("num", 0.1, 4),
    "offset": ("num", 0, 600),
    "stereo": ("bool",),
    "start": ("num", 0, 120),
    "dur": ("num", 0.005, 60),
    "gain_db": ("num", -60, 12),
    "pan": ("num", -1, 1),
    "env": ("obj", {
        "attack": ("num", 0, 30), "decay": ("num", 0, 30), "sustain": ("num", 0, 1), "release": ("num", 0, 30),
        "points": ("pts", 0, 1), "curve": ("enum", ["lin", "exp"]),
    }, []),
    "filter": ("obj", {
        "type": ("enum", ["lowpass", "highpass", "bandpass"]),
        "cutoff": ("numpts", 20, 20000), "q": ("num", 0.3, 12), "poles": ("int", 2, 4),
        "lfo": ("obj", {"rate": ("num", 0.05, 40), "octaves": ("num", 0, 4)}, ["rate", "octaves"]),
    }, ["type", "cutoff"]),
    "distortion": ("obj", {
        "type": ("enum", ["tanh", "clip", "fold", "crush"]), "drive_db": ("num", 0, 40), "mix": ("num", 0, 1),
        "bits": ("int", 2, 16), "down": ("int", 1, 32),
    }, ["type"]),
    "events": ("obj", {
        "count": ("int", 2, 400), "interval": ("num", 0.005, 30), "span": ("num", 0.05, 60), "random": ("bool",),
        "jitter": ("num", 0, 1), "decay_db": ("num", -24, 0), "gain_jitter_db": ("num", 0, 12),
        "pitch_jitter_cents": ("num", 0, 1200),
    }, ["count"]),
}, ["source", "dur"])

MASTER = ("obj", {
    "eq": ("list", ("obj", {
        "type": ("enum", ["peak", "lowshelf", "highshelf", "lowcut", "highcut"]), "freq": ("num", 20, 20000),
        "gain_db": ("num", -24, 24), "q": ("num", 0.2, 10),
    }, ["type", "freq"]), 0, 8),
    "compressor": ("obj", {
        "threshold_db": ("num", -60, 0), "ratio": ("num", 1, 20), "attack_ms": ("num", 0.1, 200),
        "release_ms": ("num", 5, 2000), "makeup_db": ("num", 0, 24),
    }, []),
    "reverb": ("obj", {
        "mix": ("num", 0, 1), "room": ("num", 0, 1), "damp": ("num", 0, 1), "predelay_ms": ("num", 0, 200),
        "highcut": ("num", 1000, 20000),
    }, ["mix"]),
    "width": ("num", 0, 2),
    "gain_db": ("num", -60, 24),
    "fade": ("obj", {"in": ("num", 0, 10), "out": ("num", 0, 30)}, []),
    "tail": ("num", 0, 20),
    "normalize": ("bool",),
    "loudness": ("obj", {"lufs": ("num", -40, -6), "true_peak": ("num", -6, 0), "limit_db": ("num", 0, 20)}, []),
}, [])

RECIPE = ("obj", {
    "name": ("str",), "note": ("str",), "vary": ("list", ("str",), 0, 12),
    "seed": ("int", 0, 2**31 - 1),
    "duration": ("num", 0.02, 120),
    "layers": ("list", LAYER, 1, 24),
    "master": MASTER,
}, ["layers"])

DEFAULT_LUFS, DEFAULT_TP = -18.0, -1.0


def freq_track(L, n, fmul):
    f0 = dsp.freq_value(L.get("freq", 440.0)) or 440.0
    t = np.arange(n) / SR
    if "freq_points" in L:
        f = dsp.points_curve(n, L["freq_points"], geometric=True)
    else:
        f = np.full(n, f0)
    sw = L.get("sweep")
    if sw:
        start = f[0]
        to = dsp.freq_value(sw["to"])
        x = np.clip(t / sw["time"], 0.0, 1.0)
        c = sw.get("curve", "fast")
        if c == "lin":
            f = start + (to - start) * x
        else:
            x = 1.0 - (1.0 - x) ** 3 if c == "fast" else x
            f = start * (to / start) ** x
    vb = L.get("vibrato")
    if vb:
        ramp = np.clip((t - vb.get("delay", 0.0)) / 0.3, 0.0, 1.0)
        f = f * 2.0 ** (vb["depth_cents"] / 1200.0 * ramp * np.sin(2 * np.pi * vb["rate"] * t))
    return f * fmul


def make_envelope(L, n):
    e = L.get("env")
    if not e:
        return dsp.adsr(n, 0.002, 0.0, 1.0, 0.01)
    if "points" in e:
        return dsp.points_curve(n, e["points"], geometric=e.get("curve") == "exp") * dsp.adsr(n, 0.0005, 0.0, 1.0, 0.002)
    a, d, s, r = e.get("attack", 0.002), e.get("decay", 0.0), e.get("sustain", 1.0), e.get("release", 0.01)
    if a + d + r > L["dur"]:
        k = L["dur"] / (a + d + r)
        a, d, r = a * k, d * k, r * k
    return dsp.adsr(n, a, d, s, r)


def render_layer(L, rng, base, fmul=1.0):
    """One event of a layer: a mono array of dur seconds."""
    n = max(int(L["dur"] * SR), 8)
    src = L["source"]
    pw = L.get("pulse_width", 0.5)
    if src in NOISES:
        if L.get("stereo"):
            y = np.stack([dsp.noise(src, n, rng), dsp.noise(src, n, rng)], axis=1)
        else:
            y = dsp.noise(src, n, rng)
    else:
        f = freq_track(L, n, fmul)
        if src in ("sine", "triangle", "saw", "square"):
            y = dsp.oscillator(src, f, pw) * 0.5
        elif src == "fm":
            fm = L.get("fm", {})
            idx = dsp.points_curve(n, fm["index_points"]) if "index_points" in fm else fm.get("index", 3.0)
            y = dsp.fm_pair(f, fm.get("ratio", 2.0), idx) * 0.5
        else:
            a = dsp.read_audio(os.path.join(base, L["file"]))
            pos = L.get("offset", 0.0) * SR + np.cumsum(f / f[0]) * L.get("rate", 1.0)
            y = np.interp(pos, np.arange(len(a)), a, right=0.0) * 0.5
    flt = L.get("filter")
    if flt:
        cut = flt["cutoff"]
        cut = dsp.points_curve(n, cut, geometric=True) if isinstance(cut, list) else cut
        if "lfo" in flt:
            t = np.arange(n) / SR
            cut = np.broadcast_to(np.asarray(cut, dtype=float), (n,)) * 2.0 ** (flt["lfo"]["octaves"] * np.sin(2 * np.pi * flt["lfo"]["rate"] * t))
        cut = np.minimum(np.asarray(cut, dtype=float) * fmul, SR * 0.45)
        one = lambda v: dsp.filt(v, flt["type"], cut, flt.get("q", 0.707), flt.get("poles", 2))
        y = np.stack([one(y[:, c]) for c in range(y.shape[1])], axis=1) if y.ndim == 2 else one(y)
    ds = L.get("distortion")
    if ds:
        y = dsp.distort(y, ds["type"], ds.get("drive_db", 12.0), ds.get("mix", 1.0), ds.get("bits", 8), ds.get("down", 1))
    env = make_envelope(L, n)
    y = y * (env[:, None] if y.ndim == 2 else env)
    y = y * 10.0 ** (L.get("gain_db", 0.0) / 20.0)
    if y.ndim == 1:
        l, r = dsp.pan_gains(L.get("pan", 0.0))
        y = np.stack([y * l, y * r], axis=1)
    elif L.get("pan", 0.0):
        l, r = dsp.pan_gains(L["pan"])
        y = y * np.array([l, r]) * math.sqrt(2)
    return y


def event_plan(L, rng, seed):
    """(start offset, gain dB, pitch ratio) per event. Times and gains come from a stream shared by every layer, so layers
    with the same events fields line up (the thump and the click of one footstep); pitch jitter is each layer's own."""
    ev = L.get("events")
    if not ev:
        return [(0.0, 0.0, 1.0)]
    shared = np.random.default_rng([seed, 7777])
    out = []
    for i in range(ev["count"]):
        u1, u2 = shared.uniform(-1, 1), shared.uniform(0, 1)
        if ev.get("random"):
            t = u2 * ev.get("span", ev["count"] * ev.get("interval", 0.1))
        else:
            iv = ev.get("interval", 0.1)
            t = i * iv + u1 * ev.get("jitter", 0.0) * iv * 0.5
        g = ev.get("decay_db", 0.0) * i + u1 * ev.get("gain_jitter_db", 0.0)
        p = 2.0 ** (rng.uniform(-1, 1) * ev.get("pitch_jitter_cents", 0.0) / 1200.0)
        out.append((max(t, 0.0), g, p))
    return out


def render(recipe, base="."):
    seed = recipe.get("seed", 1)
    m = recipe.get("master", {})
    plans = []
    end = 0.0
    for i, L in enumerate(recipe["layers"]):
        rng = np.random.default_rng([seed, i])
        plan = event_plan(L, rng, seed)
        plans.append((rng, plan))
        end = max(end, L.get("start", 0.0) + max(t for t, _, _ in plan) + L["dur"])
    rv = m.get("reverb")
    tail = m.get("tail", min(1.5, dsp.reverb_tail_seconds(rv.get("room", 0.5)) * 0.5) if rv and rv["mix"] > 0 else 0.0)
    total = int((end + tail) * SR) + 8
    mix = np.zeros((total, 2))
    for L, (rng, plan) in zip(recipe["layers"], plans):
        for t, g, p in plan:
            y = render_layer(L, rng, base, p) * 10.0 ** (g / 20.0)
            s = int((L.get("start", 0.0) + t) * SR)
            e = min(s + len(y), total)
            mix[s:e] += y[: e - s]
    x = mix
    if m.get("eq"):
        x = dsp.apply_eq(x, m["eq"])
    c = m.get("compressor")
    if c:
        x = dsp.compress(x, c.get("threshold_db", -18.0), c.get("ratio", 2.5), c.get("attack_ms", 8.0), c.get("release_ms", 120.0), c.get("makeup_db", 0.0))
    if rv and rv["mix"] > 0:
        wet = dsp.reverb(x, rv.get("room", 0.5), rv.get("damp", 0.5), rv.get("predelay_ms", 10.0), rv.get("highcut", 7000.0))
        x = x * (1.0 - rv["mix"] * 0.5) + wet * rv["mix"] * 1.4
    x = dsp.width(x, m.get("width", 1.0))
    x = x * 10.0 ** (m.get("gain_db", 0.0) / 20.0)
    if "duration" in recipe:
        n = int(recipe["duration"] * SR)
        x = x[:n] if len(x) >= n else np.vstack([x, np.zeros((n - len(x), 2))])
    fd = m.get("fade", {})
    x = dsp.fade(x, fd.get("in", 0.0), fd.get("out", 0.01))
    # a gentle high-pass keeps DC and sub-bass rumble out of the file
    x = dsp.apply_eq(x, [{"type": "lowcut", "freq": 25.0}])
    info = {}
    if m.get("normalize", True):
        ld = m.get("loudness", {})
        x, info = dsp.master_loudness(x, ld.get("lufs", DEFAULT_LUFS), ld.get("true_peak", DEFAULT_TP), ld.get("limit_db", 9.0))
    return x, info


def check_recipe(recipe, base, path_label="recipe"):
    errs, warns = [], []
    dsp.validate(recipe, RECIPE, path_label, errs)
    if errs:
        return errs, warns
    for i, L in enumerate(recipe["layers"]):
        p = f"layers[{i}]"
        src = L["source"]
        if src in NOISES and ("freq" in L or "freq_points" in L or "sweep" in L or "vibrato" in L):
            warns.append(f"{p}: freq, sweep and vibrato do nothing on a noise source")
        if src != "fm" and "fm" in L:
            warns.append(f"{p}.fm: only used when source is \"fm\"")
        if src != "sample" and ("file" in L or "rate" in L or "offset" in L):
            warns.append(f"{p}: file, rate and offset only apply to source \"sample\"")
        if src == "sample":
            if "file" not in L:
                errs.append(f"{p}: source \"sample\" needs a file")
            elif not os.path.exists(os.path.join(base, L["file"])):
                errs.append(f"{p}.file: {L['file']} was not found next to the recipe")
        if src != "square" and "pulse_width" in L:
            warns.append(f"{p}.pulse_width: only used by square")
        if src not in NOISES and L.get("stereo"):
            warns.append(f"{p}.stereo: only used by noise sources; use pan instead")
        e = L.get("env", {})
        if "points" in e and e["points"][-1][0] > L["dur"] + 1e-6:
            warns.append(f"{p}.env.points: the last point is at {e['points'][-1][0]} s, after the layer ends at {L['dur']} s")
        if "points" not in e and e.get("attack", 0) + e.get("decay", 0) + e.get("release", 0) > L["dur"] + 1e-6:
            warns.append(f"{p}.env: attack + decay + release is longer than dur {L['dur']} s; it will be squeezed")
        for k in ("cutoff",):
            fl = L.get("filter")
            if fl and isinstance(fl[k], list) and fl[k][-1][0] > L["dur"] + 1e-6:
                warns.append(f"{p}.filter.cutoff: the last point is after the layer ends")
        ev = L.get("events", {})
        if ev and not ev.get("random") and "interval" not in ev:
            warns.append(f"{p}.events: without random or interval, 0.1 s is used")
        if ev and ev.get("random") and "span" not in ev:
            warns.append(f"{p}.events: random needs span; using count x interval")
    return errs, warns


def check_audio(x, recipe, info):
    errs, warns = [], []
    m = recipe.get("master", {})
    a = dsp.analyze(x, info)
    if a["silent"]:
        errs.append("the result is silent (peak below -60 dBFS): raise gain_db, check envelopes and filter cutoffs")
        return errs, warns, a
    if a["over_samples"]:
        errs.append(f"clipping: {a['over_samples']} samples go past full scale; turn normalize on or lower master.gain_db and layer gain_db")
    if m.get("normalize", True):
        ld = m.get("loudness", {})
        target = ld.get("lufs", DEFAULT_LUFS)
        tp = ld.get("true_peak", DEFAULT_TP)
        d = a["lufs"] - target
        if abs(d) > 1.0:
            errs.append(f"loudness {a['lufs']:.1f} LUFS is {d:+.1f} LU from the target {target}: the peaks stop the limiter; thin the transient or lower the target")
        elif abs(d) > 0.5:
            warns.append(f"loudness {a['lufs']:.1f} LUFS is {d:+.1f} LU from the target {target}")
        if a["true_peak_dbtp"] > tp + 0.05:
            errs.append(f"true peak {a['true_peak_dbtp']:.2f} dBTP is above the limit {tp}")
    elif a["peak_dbfs"] > -0.1:
        warns.append(f"peak {a['peak_dbfs']:.1f} dBFS with normalize off")
    if a["dc_offset"] > 0.02:
        errs.append(f"DC offset {a['dc_offset']:.3f}")
    elif a["dc_offset"] > 0.005:
        warns.append(f"DC offset {a['dc_offset']:.3f}")
    if a["lead_silence_s"] > 0.3:
        warns.append(f"{a['lead_silence_s']:.2f} s of silence before the sound starts")
    if a["tail_silence_s"] > 1.0:
        warns.append(f"{a['tail_silence_s']:.2f} s of silence at the end")
    if a["duration_s"] > 30:
        warns.append(f"{a['duration_s']:.0f} s is long for an effect; is this a bed? loop a short one instead")
    if a["duration_s"] < 0.03:
        errs.append(f"only {a['duration_s'] * 1000:.0f} ms long")
    return errs, warns, a


def preset_dir():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "presets")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Render a sound effect from a JSON recipe.")
    ap.add_argument("paths", nargs="*", help="recipe.json out.wav (or, with --preset, just out.wav)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--preset")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--bits", type=int, choices=[16, 24], default=16)
    ap.add_argument("--sheet", help="also draw a PNG contact sheet (waveform, spectrogram, loudness, band balance) to look at")
    args = ap.parse_args(argv)
    if args.list:
        for f in sorted(glob.glob(os.path.join(preset_dir(), "*.json"))):
            r = json.load(open(f, encoding="utf8"))
            print(f"{os.path.basename(f)[:-5]:<18} {r.get('note', '')[:110]}")
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
        print("sfx.py: give an output file (out.wav), or use --check", file=sys.stderr)
        return 2
    try:
        with open(rpath, encoding="utf8") as fh:
            recipe = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"sfx.py: cannot read {rpath}: {e}", file=sys.stderr)
        return 2
    if args.seed is not None:
        recipe["seed"] = args.seed
    base = os.path.dirname(os.path.abspath(rpath))
    errs, warns = check_recipe(recipe, base)
    stats = None
    if not errs:
        x, info = render(recipe, base)
        e2, w2, stats = check_audio(x, recipe, info)
        errs += e2
        warns += w2
        if out and not errs:
            dsp.write_audio(out, x, args.bits)
        if args.sheet:
            import sheet

            sheet.make_sheet(x, args.sheet, target_lufs=recipe.get("master", {}).get("loudness", {}).get("lufs", DEFAULT_LUFS) if recipe.get("master", {}).get("normalize", True) else None)
    if args.json:
        print(json.dumps(dsp.json_safe({"ok": not errs, "errors": errs, "warnings": warns, "stats": stats, "file": out if out and not errs else None}), indent=2))
    else:
        for e in errs:
            print("ERROR", e)
        for w in warns:
            print("warn ", w)
        if stats:
            print(f"{'FAIL' if errs else 'ok'}: {stats['duration_s']:.2f} s, {stats['lufs']:.1f} LUFS, true peak {stats['true_peak_dbtp']:.2f} dBTP, "
                  f"peak {stats['peak_dbfs']:.1f} dBFS, DC {stats['dc_offset']:.4f}, stereo correlation {stats['correlation']:.2f}"
                  + (f" -> {out}" if out and not errs else ""))
        elif errs:
            print("FAIL: fix the errors above; nothing was rendered")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
