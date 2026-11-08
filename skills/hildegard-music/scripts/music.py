#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Render a short piece of music from a JSON score. Python 3.10+, standard library plus numpy; ffmpeg only for .mp3/.ogg.

  python3 music.py score.json out.wav [--check]     render a score (a bare template name like "lofi" works too)
  python3 music.py score.json --check               validate and measure only; writes nothing
  python3 music.py --template lofi out.wav          render a template from ../templates/
  python3 music.py --list                           the templates, with their one-line notes
  options: --key "D major" --tempo 84 --length 30 (replace the score's), --seed N, --json, --bits 16|24

A score is a tempo, a key, a time signature, sections (with bar counts and a chord progression), and tracks: pad, bass,
keys, plucked, melody, chorale and drums. Each track says, per section, which built-in pattern it plays (or the melody,
as scale degrees with rhythm). The mix sets levels, pan, reverb and ducking under the kick, and the master brings the
result to -14 LUFS with true peak under -1 dBTP. --check reports unknown fields, values out of range, a melody note
outside the key, bars that do not add up, clipping, loudness off target, silence, DC offset and length. Errors make the
exit status 1 and no file is written. Same seed, same audio. This is synthesized music, not a recorded band.
"""
import argparse
import bisect
import glob
import json
import math
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402

import dsp  # noqa: E402
import voices  # noqa: E402
from dsp import SR  # noqa: E402

MODES = {
    "major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10], "dorian": [0, 2, 3, 5, 7, 9, 10],
    "mixolydian": [0, 2, 4, 5, 7, 9, 10], "lydian": [0, 2, 4, 6, 7, 9, 11], "phrygian": [0, 1, 3, 5, 7, 8, 10],
}
TIMES = ["2/4", "3/4", "4/4", "5/4", "6/8", "9/8", "12/8"]
ROLES = ["pad", "bass", "keys", "plucked", "melody", "chorale", "drums"]
# small, fixed timing habits in milliseconds (positive is late): a snare a hair behind, a bass a hair ahead, a pad lazy
GROOVE_MS = {"pad": 10.0, "bass": -3.0, "keys": 3.0, "plucked": 2.0, "melody": 4.0, "chorale": 4.0}
DRUM_GROOVE_MS = {"kick": -2.0, "snare": 6.0, "snare_brush": 5.0, "clap": 5.0, "hat": 2.0, "hat_open": 2.0, "shaker": 3.0, "rim": 3.0, "tom": 1.0, "ride": 2.0}
HAT_ACCENT = {4: (1.0, 0.55, 0.82, 0.6), 3: (1.0, 0.55, 0.8)}
LEVEL_DEFAULT = {"pad": -7.0, "bass": -1.0, "keys": -4.0, "plucked": -4.0, "melody": -2.0, "chorale": -4.0, "drums": -3.0}
REVERB_DEFAULT = {"pad": 0.35, "bass": 0.0, "keys": 0.25, "plucked": 0.25, "melody": 0.3, "chorale": 0.4, "drums": 0.12}
PAN_DEFAULT = {"pad": 0.0, "bass": 0.0, "keys": -0.15, "plucked": 0.2, "melody": 0.05, "chorale": 0.0, "drums": 0.0}

# ---------------------------------------------------------------- theory


def parse_key(s):
    m = re.match(r"^\s*([A-Ga-g])([#b]?)\s+(\w+)\s*$", str(s))
    if not m or m.group(3).lower() not in MODES:
        return None
    pc = dsp.NOTE_PC[m.group(1).lower()] + {"#": 1, "b": -1, "": 0}[m.group(2)]
    return pc % 12, m.group(3).lower()


class Chord:
    def __init__(self, root, ivs, bass, name):
        self.root, self.ivs, self.bass, self.name = root, tuple(ivs), bass, name

    def pcs(self):
        return [(self.root + i) % 12 for i in self.ivs]

    @property
    def bass_pc(self):
        return self.root if self.bass is None else self.bass


ROMAN = re.compile(r"^(?P<acc>[b#]?)(?P<num>VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(?P<rest>.*)$")
NAMED = re.compile(r"^(?P<root>[A-G])(?P<acc>[#b]?)(?P<rest>.*)$")
ROMAN_DEG = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5, "vi": 6, "vii": 7}
TOKENS = ["maj9", "maj7", "M7", "dim7", "m7b5", "ø", "sus2", "sus4", "sus", "add9", "9", "7", "6", "5", "dim", "aug", "°", "+"]


def _quality(base, rest):
    ivs = {"maj": [0, 4, 7], "min": [0, 3, 7], "dim": [0, 3, 6], "aug": [0, 4, 8]}[base]
    seen = set()
    while rest:
        for t in TOKENS:
            if rest.startswith(t):
                seen.add(t)
                rest = rest[len(t):]
                break
        else:
            return None
    if seen & {"dim", "°", "dim7", "m7b5", "ø"}:
        ivs = [0, 3, 6]
    if seen & {"aug", "+"}:
        ivs = [0, 4, 8]
    if "sus2" in seen:
        ivs = [0, 2, 7]
    if seen & {"sus4", "sus"}:
        ivs = [0, 5, 7]
    if "5" in seen:
        ivs = [0, 7]
    if seen & {"maj7", "M7", "maj9"}:
        ivs = ivs + [11]
    elif "dim7" in seen:
        ivs = ivs + [9]
    elif seen & {"7", "9", "m7b5", "ø"}:
        ivs = ivs + [10]
    if "6" in seen:
        ivs = ivs + [9]
    if seen & {"9", "maj9", "add9"}:
        ivs = ivs + [14]
    return ivs


def parse_chord(sym, key):
    """A roman numeral (I, vi, IV7, bVII, V/3) or a chord name (C, Am7, F#m, Bbsus4, G/B). None if it is neither."""
    s = str(sym).strip()
    bass_spec = None
    if "/" in s:
        s, bass_spec = s.split("/", 1)
    tonic, mode = key
    m = ROMAN.match(s)
    if m:
        num = m.group("num")
        deg = ROMAN_DEG[num.lower()]
        root = (tonic + MODES[mode][deg - 1] + {"#": 1, "b": -1, "": 0}[m.group("acc")]) % 12
        rest = m.group("rest")
        base = "maj" if num.isupper() else "min"
    else:
        m = NAMED.match(s)
        if not m:
            return None
        root = (dsp.NOTE_PC[m.group("root").lower()] + {"#": 1, "b": -1, "": 0}[m.group("acc")]) % 12
        rest = m.group("rest")
        base = "maj"
        if rest.startswith("maj"):
            pass
        elif rest.startswith("m") and not rest.startswith("m7b5"):
            base, rest = "min", rest[1:]
        elif rest.startswith("m7b5"):
            base = "min"
    ivs = _quality(base, rest)
    if ivs is None:
        return None
    bass = None
    if bass_spec:
        if bass_spec in ("3", "5", "7"):
            idx = {"3": 1, "5": 2, "7": 3}[bass_spec]
            if idx >= len(ivs):
                return None
            bass = (root + ivs[idx]) % 12
        else:
            nm = NAMED.match(bass_spec)
            if not nm or nm.group("rest"):
                return None
            bass = (dsp.NOTE_PC[nm.group("root").lower()] + {"#": 1, "b": -1, "": 0}[nm.group("acc")]) % 12
    return Chord(root, ivs, bass, str(sym))


def parse_time(s):
    n, d = s.split("/")
    return int(n) * 4.0 / int(d)


def swing_warp(x, swing):
    """Map a position inside a quarter note (0 to 1) so the off-beat eighth moves toward the triplet: swing 0..1."""
    if swing <= 0:
        return x
    p = 0.5 + swing * (2.0 / 3.0 - 0.5)
    return x / 0.5 * p if x < 0.5 else p + (x - 0.5) / 0.5 * (1.0 - p)


# ---------------------------------------------------------------- patterns
# A pattern turns one chord event into notes: (offset in quarters, length in quarters, midi, velocity[, extras]).


class Ctx:
    def __init__(self, chord, nxt, dur, bpb, voicing, bass):
        self.chord, self.nxt, self.dur, self.bpb, self.voicing, self.bass = chord, nxt, dur, bpb, voicing, bass

    def fifth(self):
        return self.bass + (7 if 7 in self.chord.ivs else 6 if 6 in self.chord.ivs else 8 if 8 in self.chord.ivs else 7)


def _at(c, pos, ln, midi, vel):
    return [(pos, min(ln, c.dur - pos), midi, vel)] if pos < c.dur - 1e-6 else []


def _chord_at(c, pos, ln, vel, notes=None):
    out = []
    for i, v in enumerate(notes if notes is not None else c.voicing):
        out += _at(c, pos, ln, v, vel - 0.02 * i)
    return out


def _arp(c, step, order=None):
    v = c.voicing
    seq = order if order else v + v[-2:0:-1]
    out, i, pos = [], 0, 0.0
    while pos < c.dur - 1e-6:
        out += _at(c, pos, step * 0.95, seq[i % len(seq)], 0.78 if abs(pos % 1.0) < 1e-6 else 0.6)
        i, pos = i + 1, pos + step
    return out


def p_sustain(c):
    return [(0.0, c.dur, v, 0.7 - 0.03 * i) for i, v in enumerate(c.voicing)]


def p_swell(c):
    return [(0.0, c.dur, v, 0.7 - 0.03 * i, {"a_frac": 0.45}) for i, v in enumerate(c.voicing)]


def p_restrike(c):
    out, pos = [], 0.0
    while pos < c.dur - 1e-6:
        out += _chord_at(c, pos, min(2.0, c.dur - pos), 0.65)
        pos += 2.0
    return out


def p_block(c):
    return [(0.02 * i, c.dur * 0.97, v, 0.72 - 0.03 * i) for i, v in enumerate(c.voicing)]


def p_quarters(c):
    out = []
    for q in range(int(c.dur)):
        out += _chord_at(c, float(q), 0.95, 0.78 if q % max(int(c.bpb), 1) == 0 else 0.6)
    return out


def p_half(c):
    out = []
    for pos in np.arange(0.0, c.dur, 2.0):
        out += _chord_at(c, float(pos), 1.9, 0.72 if pos == 0 else 0.6)
    return out


def p_offbeat(c):
    out = []
    for pos in np.arange(0.5, c.dur, 1.0):
        out += _chord_at(c, float(pos), 0.35, 0.65)
    return out


def p_arp_up(c):
    return _arp(c, 0.5)


def p_arp_16(c):
    return _arp(c, 0.25)


def p_alberti(c):
    v = c.voicing
    order = [v[0], v[min(2, len(v) - 1)], v[min(1, len(v) - 1)], v[min(2, len(v) - 1)]]
    return _arp(c, 0.5, order)


def p_waltz(c):
    out = _at(c, 0.0, 1.0, c.bass + 12, 0.8)
    for q in range(1, int(c.dur)):
        out += _chord_at(c, float(q), 0.9, 0.6)
    return out


def p_lofi_comp(c):
    out = []
    for pos, ln, vel in ((0.0, 1.25, 0.72), (1.5, 0.75, 0.55), (2.5, 1.0, 0.62)):
        out += _chord_at(c, pos, ln, vel)
    return out


def p_ballad(c):
    out = _at(c, 0.0, c.dur, c.bass + 12, 0.7)
    v = c.voicing
    seq = v + v[-2:0:-1]
    for i, pos in enumerate(np.arange(0.5, c.dur, 0.5)):
        out += _at(c, float(pos), 0.9, seq[i % len(seq)], 0.58)
    return out


def p_strum(c):
    return [(0.015 * i, c.dur * 0.98, v, 0.75 - 0.03 * i) for i, v in enumerate(c.voicing)]


def p_strum_folk(c):
    out = []
    hits = ((0.0, "d"), (1.0, "d"), (1.5, "u"), (2.5, "u"), (3.0, "d"), (3.5, "u")) if c.bpb >= 4 else ((0.0, "d"), (1.0, "d"), (1.5, "u"), (2.0, "d"))
    for pos, dirn in hits:
        notes = c.voicing if dirn == "d" else c.voicing[-3:]
        for i, v in enumerate(notes):
            out += _at(c, pos + 0.012 * i, 0.95 if dirn == "d" else 0.45, v, (0.78 if dirn == "d" else 0.55) - 0.03 * i)
    return out


def p_fingerpick(c):
    v = c.voicing
    idx = [0, 3, 2, 3, 1, 3, 2, 3] if c.bpb >= 4 else [0, 3, 2, 3, 1, 3]
    out = []
    for i, pos in enumerate(np.arange(0.0, c.dur, 0.5)):
        out += _at(c, float(pos), 1.2 if idx[i % len(idx)] == 0 else 0.9, v[idx[i % len(idx)] % len(v)], 0.8 if i % 2 == 0 else 0.6)
    return out


def p_boom_chick(c):
    out = _at(c, 0.0, 0.9, c.bass + 12, 0.85)
    out += _chord_at(c, 1.0, 0.4, 0.6, c.voicing[-3:])
    out += _at(c, 2.0, 0.9, c.fifth() + 12, 0.75)
    out += _chord_at(c, 3.0, 0.4, 0.6, c.voicing[-3:])
    return out


def p_sparse(c):
    out = _at(c, 0.0, 2.0, c.voicing[0], 0.78)
    out += _at(c, 2.0, 2.0, c.voicing[-1], 0.62)
    return out


def b_root(c):
    return _at(c, 0.0, c.dur * 0.97, c.bass, 0.9)


def b_root_half(c):
    return _at(c, 0.0, 1.9, c.bass, 0.9) + _at(c, 2.0, 1.9, c.bass, 0.78)


def b_root_fifth(c):
    return _at(c, 0.0, 1.8, c.bass, 0.9) + _at(c, 2.0, 1.8, c.fifth(), 0.8)


def b_eighths(c):
    return [n for i, pos in enumerate(np.arange(0.0, c.dur, 0.5)) for n in _at(c, float(pos), 0.45, c.bass, 0.9 if i % 2 == 0 else 0.7)]


def b_octave_8ths(c):
    return [n for i, pos in enumerate(np.arange(0.0, c.dur, 0.5)) for n in _at(c, float(pos), 0.45, c.bass + (12 if i % 2 else 0), 0.9 if i % 2 == 0 else 0.7)]


def b_pulse(c):
    return [n for pos in np.arange(0.0, c.dur, 1.0) for n in _at(c, float(pos), 0.6, c.bass, 0.85 if pos % c.bpb == 0 else 0.7)]


def b_walking(c):
    third = c.bass + (c.chord.ivs[1] if len(c.chord.ivs) > 1 else 4)
    out = _at(c, 0.0, 0.95, c.bass, 0.9) + _at(c, 1.0, 0.95, third, 0.75) + _at(c, 2.0, 0.95, c.fifth(), 0.8)
    if c.nxt is not None:
        t = c.nxt.bass_pc
        tm = 33 + ((t - 33) % 12)
        app = tm - 1 if tm >= c.bass else tm + 1
    else:
        app = c.bass + 2
    return out + _at(c, 3.0, 0.95, app, 0.75)


def b_shuffle_walk(c):
    third = c.bass + (c.chord.ivs[1] if len(c.chord.ivs) > 1 else 4)
    return _at(c, 0.0, 0.95, c.bass, 0.9) + _at(c, 1.0, 0.95, third, 0.75) + _at(c, 2.0, 0.95, c.fifth(), 0.8) + _at(c, 3.0, 0.95, c.bass + 9, 0.75)


def b_syncopated(c):
    return _at(c, 0.0, 1.25, c.bass, 0.9) + _at(c, 1.5, 0.75, c.bass, 0.7) + _at(c, 2.5, 0.5, c.bass, 0.6) + _at(c, 3.25, 0.65, c.fifth(), 0.65)


PATTERNS = {
    "pad": {"sustain": p_sustain, "swell": p_swell, "restrike": p_restrike, "off": lambda c: []},
    "keys": {"block": p_block, "quarters": p_quarters, "half": p_half, "offbeat": p_offbeat, "arp_up": p_arp_up, "arp_16": p_arp_16,
             "alberti": p_alberti, "waltz": p_waltz, "lofi_comp": p_lofi_comp, "ballad": p_ballad, "sustain": p_sustain, "off": lambda c: []},
    "plucked": {"strum": p_strum, "strum_folk": p_strum_folk, "fingerpick": p_fingerpick, "boom_chick": p_boom_chick, "arp_up": p_arp_up,
                "arp_16": p_arp_16, "sparse": p_sparse, "off": lambda c: []},
    "bass": {"root": b_root, "root_half": b_root_half, "root_fifth": b_root_fifth, "eighths": b_eighths, "octave_8ths": b_octave_8ths,
             "pulse": b_pulse, "walking": b_walking, "shuffle_walk": b_shuffle_walk, "syncopated": b_syncopated, "off": lambda c: []},
}
PATTERN_NOTES = {
    "sustain": "the chord held for its whole length", "swell": "held, with a slow fade-in", "restrike": "the chord again every two beats",
    "block": "the chord held", "quarters": "the chord on every beat", "half": "the chord on beats 1 and 3", "offbeat": "short chords on the off-beats",
    "arp_up": "eighth-note arpeggio up and back", "arp_16": "sixteenth-note arpeggio", "alberti": "low-high-middle-high broken chord",
    "waltz": "bass, chord, chord (for 3/4)", "lofi_comp": "off-beat chord stabs (use swing)", "ballad": "held bass with a rolling eighth arpeggio",
    "strum": "one strum per chord", "strum_folk": "down down-up up-down-up strum", "fingerpick": "picked pattern, eighths", "boom_chick": "bass note, chord, fifth, chord (country)",
    "sparse": "two plucks per bar", "root": "the root held", "root_half": "root on 1 and 3", "root_fifth": "root on 1, fifth on 3",
    "eighths": "root eighth notes", "octave_8ths": "root and octave eighths (disco)", "pulse": "root on every beat", "walking": "quarter-note walking line",
    "shuffle_walk": "root, third, fifth, sixth (blues and country shuffle)", "syncopated": "root with off-beat pushes", "off": "silent",
}

# drum grids: x normal, X accent, o ghost, . rest; one string per drum; len == steps per bar
DRUM_PATTERNS = {
    "four_floor": (4, {"kick": "x...x...x...x...", "clap": "....x.......x...", "hat": "..x...x...x...x."}),
    "backbeat": (4, {"kick": "x.......x.x.....", "snare": "....x.......x...", "hat": "x.x.x.x.x.x.x.x."}),
    "rock": (4, {"kick": "x.....x.x.......", "snare": "....x.......x...", "hat": "x.x.x.x.x.x.x.x."}),
    "halftime": (4, {"kick": "x.......x.......", "snare": "........x.......", "hat": "x.x.x.x.x.x.x.x."}),
    "lofi": (4, {"kick": "x.....x...x.....", "rim": "....x.......x...", "snare": "..............o.", "hat": "x.xoxxx.x.xoxxx."}),
    "soft_pop": (4, {"kick": "x.......x.......", "rim": "....x.......x...", "shaker": "x.x.x.x.x.x.x.x."}),
    "corporate": (4, {"kick": "x...x...x...x...", "clap": "....x.......x...", "hat": "..x...x...x...x.", "shaker": "oxoxoxoxoxoxoxox"}),
    "shaker_8th": (4, {"kick": "x.......x.......", "shaker": "x.x.x.x.x.x.x.x."}),
    "brush": (4, {"kick": "x.......x.......", "snare_brush": "....x.......x...", "shaker": "x.x.x.x.x.x.x.x."}),
    "tick": (4, {"rim": "x...x...x...x..."}),
    "kick_only": (4, {"kick": "x...x...x...x..."}),
    "epic": (4, {"tom": "x.......x......."}),
    "build": (4, {"snare": "x.x.x.x.xxxxxxxx", "kick": "x...x...x...x..."}),
    "shuffle": (3, {"kick": "x.....x.....", "snare_brush": "...x.....x..", "hat": "x.xx.xx.xx.x"}),
    "country_shuffle": (3, {"kick": "x.....x.....", "snare_brush": "...x.....x..", "shaker": "x.xx.xx.xx.x"}),
    "waltz": (4, {"kick": "x...........", "rim": "....x...x...", "hat": "x.x.x.x.x.x."}),
    "waltz_soft": (4, {"kick": "x...........", "shaker": "x.x.x.x.x.x."}),
    "compound": (4, {"kick": "x...........", "rim": "......x.....", "hat": "x.x.x.x.x.x."}),
}
DRUM_BARS = {"four_floor": 4, "backbeat": 4, "rock": 4, "halftime": 4, "lofi": 4, "soft_pop": 4, "corporate": 4, "shaker_8th": 4, "brush": 4, "tick": 4, "kick_only": 4, "epic": 4, "build": 4, "shuffle": 4, "country_shuffle": 4, "waltz": 3, "waltz_soft": 3, "compound": 3}
FILL = {"kick": "x...............", "tom": "........x.x.xxxx", "snare": "............x.x."}
DRUM_PAN = {"hat": 0.25, "hat_open": 0.25, "shaker": -0.3, "tom": -0.15, "ride": 0.3, "rim": -0.1, "clap": 0.05}
DRUM_VEL = {"x": 0.8, "X": 1.0, "o": 0.4}
DRUM_GAIN = {"kick": 0.42, "snare": 0.7, "snare_brush": 0.8, "clap": 0.8, "hat": 0.4, "hat_open": 0.35, "shaker": 0.35, "rim": 0.6, "tom": 0.9, "ride": 0.3}

# ---------------------------------------------------------------- melody strings

TOK = re.compile(r"^(?:(?P<rest>r)|(?P<tie>-)|(?P<acc>[b#]?)(?P<deg>[1-7])(?P<oct>[\^_]*)|(?P<name>[A-Ga-g][#b]?-?\d))$")


def _beats(s):
    try:
        if "/" in s:
            a, b = s.split("/")
            return float(a) / float(b)
        return float(s)
    except ValueError:
        return None


def tonic_midi(key):
    return 60 + ((key[0] + 5) % 12) - 5


def parse_melody(text, key, bpb, label, errs):
    """'3:1 5:1 6:2 | 5:2 r:1 3:1' -> list per bar of (pos, dur, midi or None, is_tie). Records problems in errs."""
    tonic, mode = key
    scale = MODES[mode]
    tm = tonic_midi(key)
    bars = []
    for bi, bar in enumerate(str(text).split("|")):
        toks = bar.split()
        notes, pos = [], 0.0
        for tk in toks:
            if ":" not in tk:
                errs.append(f"{label} bar {bi + 1}: {tk!r} needs a length, like 3:1 (degree 3 for one beat) or r:2 (rest for two)")
                continue
            ps, ls = tk.split(":", 1)
            ln = _beats(ls)
            m = TOK.match(ps)
            if not m or ln is None or ln <= 0:
                errs.append(f"{label} bar {bi + 1}: cannot read {tk!r}; use a degree 1-7 (optional b/# in front, ^ up an octave, _ down), r for rest, - to hold, or a note name like E4, then :beats")
                continue
            if m.group("rest"):
                midi = None
            elif m.group("tie"):
                midi = "tie"
            elif m.group("name"):
                midi = dsp.note_to_midi(m.group("name"))
            else:
                midi = tm + scale[int(m.group("deg")) - 1] + {"#": 1, "b": -1, "": 0}[m.group("acc")] + 12 * (m.group("oct").count("^") - m.group("oct").count("_"))
            notes.append((pos, ln, midi))
            pos += ln
        if abs(pos - bpb) > 1e-6:
            errs.append(f"{label} bar {bi + 1}: the lengths add up to {pos:g} beats but a bar is {bpb:g}")
        bars.append(notes)
    return bars


# ---------------------------------------------------------------- four-part voice leading (chorale)

RANGE_S, RANGE_A, RANGE_T, RANGE_B = (60, 82), (55, 75), (48, 70), (38, 61)


def harmonize(slots, tonic):
    """slots: [(Chord, soprano midi)]. Returns [(S, A, T, B)] by dynamic programming: smooth inner voices, a root bass,
    no parallel fifths or octaves, no doubled third or leading tone."""
    cands = []
    for ch, s in slots:
        pcs = set(ch.pcs())
        need = {ch.root % 12, (ch.root + ch.ivs[1]) % 12} if len(ch.ivs) > 1 else {ch.root}
        if len(ch.ivs) > 3:
            need.add((ch.root + ch.ivs[3]) % 12)
        third = (ch.root + ch.ivs[1]) % 12 if len(ch.ivs) > 1 else -1
        lead = (tonic - 1) % 12
        A = [m for m in range(*RANGE_A) if m % 12 in pcs and m < s]
        T = [m for m in range(*RANGE_T) if m % 12 in pcs]
        B = [m for m in range(*RANGE_B) if m % 12 == ch.bass_pc]
        out = []
        for a in A:
            if s - a > 12:
                continue
            for t in T:
                if t >= a or a - t > 12:
                    continue
                for b in B:
                    if b >= t:
                        continue
                    pcs4 = [s % 12, a % 12, t % 12, b % 12]
                    if not need <= set(pcs4):
                        continue
                    cost = 0.0
                    cost += 4.0 * (pcs4.count(third) - 1) if third >= 0 and pcs4.count(third) > 1 else 0.0
                    cost += 6.0 if pcs4.count(lead) > 1 else 0.0
                    cost += 0.5 if (ch.root + 7) % 12 not in pcs4 else 0.0
                    out.append(((s, a, t, b), cost))
        if not out:
            raise ValueError(f"no four-part voicing for chord {ch.name} under soprano {s}; move the melody note or the chord")
        cands.append(out)

    def trans(u, v):
        c = abs(u[1] - v[1]) + abs(u[2] - v[2]) + 0.5 * abs(u[3] - v[3]) + 0.3 * abs(u[0] - v[0])
        if abs(u[3] - v[3]) > 7:
            c += 1.5
        for i in range(4):
            for j in range(i + 1, 4):
                if u[i] == v[i] and u[j] == v[j]:
                    continue
                iu, iv = (u[i] - u[j]) % 12, (v[i] - v[j]) % 12
                if iu == iv and iu in (0, 7) and (u[i] != v[i] or u[j] != v[j]):
                    c += 40.0
        return c

    best = [[c for _, c in cands[0]]]
    back = [[-1] * len(cands[0])]
    for k in range(1, len(cands)):
        prev_idx = sorted(range(len(cands[k - 1])), key=lambda i: best[k - 1][i])[:30]
        cur, bp = [], []
        for v, sc in cands[k]:
            bi = min(prev_idx, key=lambda i: best[k - 1][i] + trans(cands[k - 1][i][0], v))
            cur.append(best[k - 1][bi] + trans(cands[k - 1][bi][0], v) + sc)
            bp.append(bi)
        best.append(cur)
        back.append(bp)
    i = int(np.argmin(best[-1]))
    path = []
    for k in range(len(cands) - 1, -1, -1):
        path.append(cands[k][i][0])
        i = back[k][i]
    return path[::-1]


# ---------------------------------------------------------------- the score format

HUM = ("obj", {"timing_ms": ("num", 0, 40), "velocity": ("num", 0, 0.4)}, [])
SECTION = ("obj", {"name": ("str",), "bars": ("int", 1, 64), "chords": ("list", ("str",), 1, 64)}, ["name", "bars", "chords"])
TRACK = ("obj", {
    "role": ("enum", ROLES), "instrument": ("enum", list(voices.INSTRUMENTS)), "kit": ("enum", list(voices.KITS)),
    "sections": ("any",), "level_db": ("num", -40, 12), "pan": ("num", -1, 1), "reverb": ("num", 0, 1), "duck": ("num", 0, 18),
    "duck_release_ms": ("num", 40, 800), "lowcut": ("num", 20, 2000), "highcut": ("num", 500, 20000), "octave": ("int", -2, 2),
    "attack": ("num", 0, 4), "release": ("num", 0, 6), "chorus": ("num", 0, 1), "humanize": HUM, "offset_ms": ("num", -60, 60),
    "fill": ("bool",), "mute": ("bool",), "spread": ("num", 0, 1), "name": ("str",),
}, ["role", "sections"])
SCORE = ("obj", {
    "name": ("str",), "title": ("str",), "note": ("str",), "vary": ("list", ("str",), 0, 12), "seed": ("int", 0, 2**31 - 1), "tempo": ("num", 40, 220),
    "key": ("str",), "time": ("enum", TIMES), "swing": ("num", 0, 1), "length_s": ("num", 2, 900),
    "sections": ("list", SECTION, 1, 40), "tracks": ("list", TRACK, 1, 12), "humanize": HUM,
    "mix": ("obj", {"reverb": ("obj", {"room": ("num", 0, 1), "damp": ("num", 0, 1), "predelay_ms": ("num", 0, 100), "level_db": ("num", -30, 6), "highcut": ("num", 1000, 20000)}, [])}, []),
    "master": ("obj", {
        "loudness": ("obj", {"lufs": ("num", -30, -8), "true_peak": ("num", -6, 0), "limit_db": ("num", 0, 20)}, []),
        "eq": ("list", ("obj", {"type": ("enum", ["peak", "lowshelf", "highshelf", "lowcut", "highcut"]), "freq": ("num", 20, 20000), "gain_db": ("num", -24, 24), "q": ("num", 0.2, 10)}, ["type", "freq"]), 0, 8),
        "compressor": ("obj", {"threshold_db": ("num", -60, 0), "ratio": ("num", 1, 20), "attack_ms": ("num", 0.1, 200), "release_ms": ("num", 5, 2000), "makeup_db": ("num", 0, 24)}, []),
        "multiband": ("obj", {"low_hz": ("num", 60, 400), "high_hz": ("num", 1500, 9000), "ratio": ("num", 1, 6), "threshold_db": ("num", -50, 0)}, []),
        "saturation": ("obj", {"drive_db": ("num", 0, 18), "mix": ("num", 0, 1)}, []),
        "width": ("num", 0, 2), "fade_in": ("num", 0, 10), "fade_out": ("num", 0, 30), "tail": ("num", 0, 20), "normalize": ("bool",),
        "gain_db": ("num", -60, 24),
    }, []),
}, ["tempo", "key", "sections", "tracks"])


class Piece:
    """A parsed score: timing, chord events, and per-track note lists."""

    def __init__(self, score):
        self.s = score
        self.key = parse_key(score["key"])
        self.time = score.get("time", "4/4")
        self.bpb = parse_time(self.time)
        self.tempo = float(score["tempo"])
        self.spq = 60.0 / self.tempo
        self.swing = float(score.get("swing", 0.0))
        self.sections = []
        q = 0.0
        for sec in score["sections"]:
            self.sections.append({"name": sec["name"], "bars": sec["bars"], "chords": sec["chords"], "start_q": q})
            q += sec["bars"] * self.bpb
        self.total_q = q
        self.events = []  # (start_q, dur_q, Chord, section index)
        self.event_starts = []

    def build_events(self, errs):
        for si, sec in enumerate(self.sections):
            for b in range(sec["bars"]):
                item = sec["chords"][b % len(sec["chords"])]
                parts = [p.strip() for p in str(item).split("|")]
                for k, sym in enumerate(parts):
                    ch = parse_chord(sym, self.key)
                    if ch is None:
                        errs.append(f"sections[{si}].chords: cannot read the chord {sym!r}; use roman numerals like I, vi, IV, V7, bVII or names like C, Am7, F#m, G/B")
                        return
                    dur = self.bpb / len(parts)
                    self.events.append((sec["start_q"] + b * self.bpb + k * dur, dur, ch, si))
        self.event_starts = [e[0] for e in self.events]

    def chord_at(self, q):
        i = bisect.bisect_right(self.event_starts, q + 1e-6) - 1
        return self.events[max(i, 0)][2]

    def t(self, q):
        """Seconds for a position in quarters, with swing on the off-beat eighths."""
        if self.swing <= 0:
            return q * self.spq
        base = math.floor(q + 1e-9)
        x = q - base
        if abs(x * 3 - round(x * 3)) < 1e-6:
            return q * self.spq  # already on the triplet grid (a shuffle's 2/3): swinging it again would land it late
        return (base + swing_warp(x, self.swing)) * self.spq


def section_value(track, name):
    v = track["sections"].get(name, track["sections"].get("*"))
    return v


def voicing_for(ch, prev, lo, hi, center, open_=False):
    """Notes of the chord for a pad, keys or guitar part. Chooses the inversion that moves least from the previous chord,
    keeps common tones, and keeps the top line smooth. open_ spreads the chord (root, fifth, then the third an octave up;
    drop-2 for four notes), which sounds fuller under a melody."""
    pcs = ch.pcs()
    n = len(pcs)
    best, bc = None, 1e9
    for rot in range(n):
        order = pcs[rot:] + pcs[:rot]
        for base in range(lo, lo + 12):
            if base % 12 != order[0]:
                continue
            notes = [base]
            for pc in order[1:]:
                m = notes[-1] + 1
                while m % 12 != pc:
                    m += 1
                notes.append(m)
            if open_ and n >= 3:
                notes = [notes[0], notes[2], notes[1] + 12] if n == 3 else sorted([notes[-2] - 12] + [x for i, x in enumerate(notes) if i != n - 2])
            if notes[-1] > hi + 4 or notes[0] < lo - 12:
                continue
            ref = prev if prev and len(prev) == len(notes) else [center + (i - (len(notes) - 1) / 2.0) * 4 for i in range(len(notes))]
            cost = sum(abs(a - b) for a, b in zip(notes, ref)) + 0.2 * max(0, notes[-1] - hi)
            cost += 1.5 * abs(notes[-1] - ref[-1]) - 1.2 * len(set(notes) & set(prev or []))
            if cost < bc:
                best, bc = notes, cost
    return best if best else [lo + p for p in range(n)]


def bass_midi(pc, octave):
    return 33 + ((pc - 33) % 12) + 12 * octave


def build_tracks(piece, errs, warns):
    """Note lists per track. Each note: dict(t, dur, midi, vel, pan, instr or drum, a, r)."""
    out = []
    key = piece.key
    glob_h = piece.s.get("humanize", {"timing_ms": 8, "velocity": 0.08})
    glob_h = {"timing_ms": glob_h.get("timing_ms", 8), "velocity": glob_h.get("velocity", 0.08)}
    for ti, tr in enumerate(piece.s["tracks"]):
        role = tr["role"]
        label = f"tracks[{ti}]"
        rng = np.random.default_rng([piece.s.get("seed", 1), ti])
        hum = {**glob_h, **tr.get("humanize", {})}
        instr = tr.get("instrument", voices.ROLE_DEFAULT.get(role, "piano"))
        if role != "drums" and instr not in voices.INSTRUMENTS:
            errs.append(f"{label}.instrument: unknown {instr!r}")
            continue
        notes = []
        oct_shift = tr.get("octave", 0)
        prev_voicing = None
        names = {s["name"] for s in piece.sections}
        for k in tr["sections"]:
            if k != "*" and k not in names:
                warns.append(f"{label}.sections.{k}: there is no section named {k!r}; it is never played")
        for si, sec in enumerate(piece.sections):
            val = section_value(tr, sec["name"])
            if val is None:
                continue
            spec = val if isinstance(val, dict) else {"pattern": val} if role not in ("melody", "chorale") else {"melody": val}
            if not isinstance(val, (str, dict)):
                errs.append(f"{label}.sections.{sec['name']}: needs text or an object")
                continue
            if isinstance(val, dict) and "gain_db" in spec and not dsp._is_num(spec["gain_db"]):
                errs.append(f"{label}.sections.{sec['name']}.gain_db: not a number")
                continue
            gdb = spec.get("gain_db", 0.0) if isinstance(spec, dict) else 0.0
            gmul = 10.0 ** (gdb / 20.0)
            evs = [(i, e) for i, e in enumerate(piece.events) if e[3] == si]
            base_q = sec["start_q"]
            if role == "drums":
                _drum_section(piece, tr, spec, sec, label, notes, errs, rng, hum, gmul)
                continue
            if role in ("melody", "chorale"):
                text = spec.get("melody")
                if text is None and "notes" not in spec:
                    errs.append(f"{label}.sections.{sec['name']}: a {role} track needs a melody string such as \"3:1 5:1 6:2 | 5:4\"")
                    continue
                if text and text.startswith("same:"):
                    ref = text[5:]
                    text = section_value(tr, ref)
                    text = text.get("melody") if isinstance(text, dict) else text
                    if text is None:
                        errs.append(f"{label}.sections.{sec['name']}: same:{ref} names a section with no melody")
                        continue
                seq = []
                if "notes" in spec:
                    for j, n in enumerate(spec["notes"]):
                        if not (isinstance(n, list) and len(n) >= 3):
                            errs.append(f"{label}.sections.{sec['name']}.notes[{j}]: use [start_beat, beats, \"E4\" or midi number, optional velocity]")
                            continue
                        mid = n[2] if isinstance(n[2], (int, float)) else dsp.note_to_midi(n[2])
                        if mid is None:
                            errs.append(f"{label}.sections.{sec['name']}.notes[{j}]: {n[2]!r} is not a note")
                            continue
                        seq.append((base_q + n[0], n[1], int(mid) + 12 * oct_shift, n[3] if len(n) > 3 else 0.75))
                else:
                    bars = parse_melody(text, key, piece.bpb, f"{label}.sections.{sec['name']}", errs)
                    if len(bars) < sec["bars"] and sec["bars"] % len(bars) == 0:
                        bars = bars * (sec["bars"] // len(bars))
                    if len(bars) != sec["bars"]:
                        errs.append(f"{label}.sections.{sec['name']}: the melody has {len(bars)} bars but the section has {sec['bars']} (a shorter melody repeats only when it divides the bar count)")
                        continue
                    for bi, bar in enumerate(bars):
                        for pos, ln, mid in bar:
                            if mid is None:
                                continue
                            if mid == "tie":
                                if seq:
                                    p0, l0, m0, v0 = seq[-1]
                                    seq[-1] = (p0, l0 + ln, m0, v0)
                                continue
                            vel = 0.85 if pos == 0 else 0.72 if pos % 1.0 == 0 else 0.62
                            seq.append((base_q + bi * piece.bpb + pos, ln, mid + 12 * oct_shift, vel))
                if role == "melody":
                    for st, ln, mid, vel in seq:
                        notes.append({"q": st, "dq": ln, "midi": mid, "vel": vel * gmul, "pan": 0.0})
                    _scale_check(piece, seq, f"{label}.sections.{sec['name']}", warns)
                    _downbeat_check(piece, seq, f"{label}.sections.{sec['name']}", warns, base_q)
                else:
                    slots = [(piece.chord_at(st), mid) for st, ln, mid, vel in seq]
                    try:
                        sats = harmonize(slots, key[0]) if slots else []
                    except ValueError as e:
                        errs.append(f"{label}.sections.{sec['name']}: {e}")
                        continue
                    spread = tr.get("spread", 0.6)
                    pans = (0.35, -0.25, 0.25, -0.35)
                    for (st, ln, mid, vel), vo in zip(seq, sats):
                        for vi, m in enumerate(vo):
                            notes.append({"q": st, "dq": ln, "midi": m + 12 * oct_shift if vi else m, "vel": (vel - (0.0 if vi == 0 else 0.12)) * gmul, "pan": pans[vi] * spread})
                    _scale_check(piece, seq, f"{label}.sections.{sec['name']}", warns)
                continue
            # pad, keys, plucked, bass: one pattern over every chord event of the section
            pname = spec.get("pattern")
            table = PATTERNS[role]
            if pname not in table:
                errs.append(f"{label}.sections.{sec['name']}: unknown {role} pattern {pname!r}; choose one of {', '.join(table)}")
                continue
            for i, e in evs:
                q0, dq, ch = e[0], e[1], e[2]
                nxt = piece.events[i + 1][2] if i + 1 < len(piece.events) else None
                if role == "bass":
                    voicing = [bass_midi(ch.bass_pc, oct_shift)]
                    bm = voicing[0]
                else:
                    lo, hi, center = {"pad": (48, 70, 60), "keys": (52, 74, 63), "plucked": (50, 72, 60)}[role]
                    lo, hi, center = lo + 12 * oct_shift, hi + 12 * oct_shift, center + 12 * oct_shift
                    voicing = voicing_for(ch, prev_voicing, lo, hi, center, open_=role == "pad")
                    prev_voicing = voicing
                    bm = bass_midi(ch.bass_pc, oct_shift)
                ctx = Ctx(ch, nxt, dq, piece.bpb, voicing, bm)
                for n in table[pname](ctx):
                    ex = n[4] if len(n) > 4 else {}
                    notes.append({"q": q0 + n[0], "dq": n[1], "midi": n[2], "vel": n[3] * gmul, "pan": 0.0, **ex})
        # humanize and convert to seconds
        th, vh = hum["timing_ms"] / 1000.0, hum["velocity"]
        off = tr.get("offset_ms", 0.0) / 1000.0
        for n in notes:
            habit = DRUM_GROOVE_MS.get(n.get("drum"), 0.0) if role == "drums" else GROOVE_MS.get(role, 0.0)
            n["t"] = max(piece.t(n["q"]) + off + habit / 1000.0 + float(np.clip(rng.normal(0, th * 0.5), -th, th)), 0.0)
            n["dur"] = max(n["dq"] * piece.spq * 0.985 * (1.0 + float(np.clip(rng.normal(0, 0.04), -0.1, 0.1))), 0.04)
            n["vel"] = float(np.clip(n["vel"] * (1.0 + rng.normal(0, vh)), 0.05, 1.0))
        out.append({"track": tr, "index": ti, "notes": notes, "instrument": instr})
    return out


def _scale_check(piece, seq, label, warns):
    tonic, mode = piece.key
    sc = {(tonic + s) % 12 for s in MODES[mode]}
    bad = sorted({n[2] for n in seq if n[2] % 12 not in sc})
    if bad:
        names = ", ".join(_pc_name(m) for m in bad)
        warns.append(f"{label}: melody note(s) {names} are outside {piece.s['key']}; fine only if you meant a chromatic note")


def _downbeat_check(piece, seq, label, warns, base_q):
    """A held note that lands on the first beat of a bar and is not in the chord sounds like a mistake."""
    bad = []
    for st, ln, mid, vel in seq:
        if abs(st % piece.bpb) < 1e-6 and ln >= 1.0 and mid % 12 not in piece.chord_at(st).pcs():
            bad.append(f"{_pc_name(mid)} over {piece.chord_at(st).name} in bar {int((st - base_q) // piece.bpb) + 1} of the section")
    if bad:
        warns.append(f"{label}: first-beat notes that are not in the chord: {'; '.join(bad[:3])}{' ...' if len(bad) > 3 else ''}")


def _pc_name(m):
    return ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][m % 12] + str(m // 12 - 1)


def _grid_clean(g):
    return "".join(ch for ch in g if ch not in " |")


def _drum_section(piece, tr, spec, sec, label, notes, errs, rng, hum, gmul):
    kit = tr.get("kit", "acoustic")
    spq = 4
    if "grid" in spec:
        grid = {k: _grid_clean(v) for k, v in spec["grid"].items()}
        spq = int(spec.get("spq", 4))
    else:
        pname = spec.get("pattern")
        if pname in (None, "none", "off"):
            return
        if pname not in DRUM_PATTERNS:
            errs.append(f"{label}.sections.{sec['name']}: unknown drum pattern {pname!r}; choose one of {', '.join(DRUM_PATTERNS)}")
            return
        spq, grid = DRUM_PATTERNS[pname]
        want = DRUM_BARS[pname]
        if abs(piece.bpb - want) > 1e-6 and not (pname in ("backbeat", "rock") and piece.bpb == 4):
            errs.append(f"{label}.sections.{sec['name']}: the drum pattern {pname!r} is for {want}-beat bars; use a grid for {piece.time}")
            return
    steps = int(round(piece.bpb * spq))
    for dname, g in grid.items():
        if dname not in voices.DRUMS:
            errs.append(f"{label}.sections.{sec['name']}.grid.{dname}: unknown drum; use {', '.join(voices.DRUMS)}")
            return
        if len(g) != steps:
            errs.append(f"{label}.sections.{sec['name']}.grid.{dname}: has {len(g)} steps, a {piece.time} bar at {spq} steps per beat needs {steps}")
            return
        if set(g) - set("xXo.-"):
            errs.append(f"{label}.sections.{sec['name']}.grid.{dname}: use only x X o . in a grid")
            return
    for b in range(sec["bars"]):
        g_use = grid
        if tr.get("fill") and b == sec["bars"] - 1 and sec["bars"] > 1 and spq == 4 and piece.bpb == 4:
            g_use = {**{k: v for k, v in grid.items() if k not in ("hat", "shaker", "snare", "clap", "snare_brush", "rim")}, "kick": FILL["kick"], "tom": FILL["tom"], "snare": FILL["snare"]}
        for dname, g in g_use.items():
            for si, ch in enumerate(g):
                if ch in ".-":
                    continue
                q = sec["start_q"] + b * piece.bpb + si / spq
                acc = HAT_ACCENT.get(spq, (1.0,) * spq)[si % spq] if dname in ("hat", "shaker", "hat_open") else (0.85 if si % spq else 1.0)
                notes.append({"q": q, "dq": 0.1, "drum": dname, "vel": DRUM_VEL[ch] * gmul * acc, "pan": DRUM_PAN.get(dname, 0.0), "variant": int(rng.integers(0, 3)), "kit": kit})


# ---------------------------------------------------------------- rendering


def duck_curve(depth_db, release_ms, attack_ms=7.0):
    a = int(attack_ms * SR / 1000.0)
    n = int((release_ms * 5.0) * SR / 1000.0)
    g = 10.0 ** (-depth_db / 20.0)
    c = np.ones(a + n)
    c[:a] = np.linspace(1.0, g, a)
    c[a:] = 1.0 - (1.0 - g) * np.exp(-np.arange(n) / (release_ms * SR / 1000.0))
    return c


def render_track(piece, tinfo, total, kick_times):
    tr = tinfo["track"]
    role = tr["role"]
    buf = np.zeros((total, 2))
    cache = {}
    pan0 = tr.get("pan", PAN_DEFAULT[role])
    per_note_pan = False
    hats = sorted(n["t"] for n in tinfo["notes"] if n.get("drum") in ("hat", "hat_open"))
    for n in tinfo["notes"]:
        s = int(n["t"] * SR)
        if s >= total:
            continue
        if "drum" in n:
            vb = 0.4 if n["vel"] < 0.5 else 0.7 if n["vel"] < 0.9 else 1.0
            key = (n["kit"], n["drum"], vb, n["variant"])
            y = cache.get(key)
            if y is None:
                y = cache.setdefault(key, voices.drum(n["drum"], n["kit"], vb, n["variant"]))
            amp = n["vel"] / vb * DRUM_GAIN[n["drum"]]
            if n["drum"] == "hat_open":  # a closed hat (or the next open one) chokes the ring, as a foot on the pedal does
                k = bisect.bisect_right(hats, n["t"] + 1e-4)
                if k < len(hats):
                    cut = int((hats[k] - n["t"]) * SR)
                    if 0 < cut < len(y):
                        y = y[:cut].copy()
                        fl = min(int(0.004 * SR), len(y))
                        y[-fl:] *= np.linspace(1.0, 0.0, fl)
        else:
            a = tr.get("attack")
            if "a_frac" in n:
                a = max(a or 0.0, n["dur"] * n["a_frac"])
            vb = 0.45 if n["vel"] < 0.55 else 0.7 if n["vel"] < 0.8 else 0.95
            key = (tinfo["instrument"], n["midi"], round(n["dur"] / 0.05), vb, None if a is None else round(a, 2), tr.get("release"))
            y = cache.get(key)
            if y is None:
                y = cache.setdefault(key, voices.voice(tinfo["instrument"], int(n["midi"]), n["dur"], vb, a, tr.get("release")))
            amp = (0.55 + 0.7 * n["vel"]) / (0.55 + 0.7 * vb)
        e = min(s + len(y), total)
        p = float(np.clip(pan0 + n["pan"], -1, 1))
        if n["pan"]:
            per_note_pan = True
        l, r = dsp.pan_gains(p)
        buf[s:e, 0] += y[: e - s] * amp * l
        buf[s:e, 1] += y[: e - s] * amp * r
    if role == "drums":  # parallel compression and a touch of saturation make a kit sound like one instrument
        par = dsp.compress(buf, thr_db=-30.0, ratio=8.0, attack_ms=3.0, release_ms=70.0, makeup_db=10.0)
        buf = dsp.saturate(buf * 0.85 + par * 0.3, 3.0, 0.35)
    ch = tr.get("chorus", 0.0)
    if ch > 0 and not per_note_pan and role != "drums":
        mono = buf.mean(axis=1)
        l, r = dsp.pan_gains(pan0)
        st = dsp.chorus(mono, mix=0.35 + 0.4 * ch)
        buf = st * np.array([l, r]) * 1.4
    bands = []
    if role == "drums" and "highcut" not in tr:
        bands.append({"type": "highcut", "freq": 11000.0})
    if "lowcut" in tr:
        bands.append({"type": "lowcut", "freq": tr["lowcut"]})
    if "highcut" in tr:
        bands.append({"type": "highcut", "freq": tr["highcut"]})
    if bands:
        buf = dsp.apply_eq(buf, bands)
    lvl = 10.0 ** (tr.get("level_db", LEVEL_DEFAULT[role]) / 20.0)
    buf *= lvl
    duck = tr.get("duck", 0.0)
    if duck > 0 and len(kick_times):
        curve = duck_curve(duck, tr.get("duck_release_ms", 160.0))
        g = np.ones(total)
        for t in kick_times:
            s0 = max(int(t * SR) - int(0.007 * SR), 0)
            e0 = min(s0 + len(curve), total)
            if e0 > s0:
                g[s0:e0] = np.minimum(g[s0:e0], curve[: e0 - s0])
        buf *= g[:, None]
    return buf


def render(score, errs=None, warns=None):
    errs = errs if errs is not None else []
    warns = warns if warns is not None else []
    piece = Piece(score)
    piece.build_events(errs)
    if errs:
        return None, {}, piece
    tracks = build_tracks(piece, errs, warns)
    if errs:
        return None, {}, piece
    m = score.get("master", {})
    tail = m.get("tail", 2.5)
    total_s = piece.total_q * piece.spq + tail
    total = int(total_s * SR) + 8
    kick_times = sorted(n["t"] for t in tracks if t["track"]["role"] == "drums" for n in t["notes"] if n.get("drum") == "kick")
    for t in tracks:
        if t["track"].get("duck", 0) > 0 and not kick_times:
            warns.append(f"tracks[{t['index']}].duck: there is no kick in the drums to duck under, so it does nothing")
    dry = np.zeros((total, 2))
    bus = np.zeros((total, 2))
    stats = []
    for t in tracks:
        if t["track"].get("mute") or not t["notes"]:
            continue
        buf = render_track(piece, t, total, kick_times)
        dry += buf
        send = t["track"].get("reverb", REVERB_DEFAULT[t["track"]["role"]])
        if send > 0:
            bus += buf * send
        stats.append({"track": t["index"], "role": t["track"]["role"], "instrument": t["instrument"] if t["track"]["role"] != "drums" else t["track"].get("kit", "acoustic"), "notes": len(t["notes"]), "rms_db": round(dsp.lin_to_db(float(np.sqrt(np.mean(buf * buf)))), 1)})
    rv = score.get("mix", {}).get("reverb", {})
    wet = dsp.reverb(bus, rv.get("room", 0.55), rv.get("damp", 0.5), rv.get("predelay_ms", 18.0), rv.get("highcut", 6500.0))
    x = dry + wet * 10.0 ** (rv.get("level_db", -4.0) / 20.0)
    pk = float(np.max(np.abs(x))) or 1.0
    x = x * (0.5 / pk)
    eq = m.get("eq", [{"type": "lowcut", "freq": 38.0}, {"type": "lowshelf", "freq": 110.0, "gain_db": -4.5}, {"type": "highshelf", "freq": 7000.0, "gain_db": -3.0}])
    x = dsp.apply_eq(x, eq)
    mb = m.get("multiband", {})
    r = mb.get("ratio", 1.8)
    if r > 1.0:
        th = mb.get("threshold_db", -24.0)
        x = dsp.multiband(x, (mb.get("low_hz", 150.0), mb.get("high_hz", 4000.0)), [
            {"thr_db": th, "ratio": r, "attack_ms": 35.0, "release_ms": 240.0, "makeup_db": 0.0},
            {"thr_db": th + 2.0, "ratio": r, "attack_ms": 18.0, "release_ms": 160.0, "makeup_db": 0.0},
            {"thr_db": th, "ratio": r * 0.9, "attack_ms": 6.0, "release_ms": 90.0, "makeup_db": 0.0}])
    sat = m.get("saturation", {"drive_db": 3.0, "mix": 0.25})
    x = dsp.saturate(x, sat.get("drive_db", 3.0), sat.get("mix", 0.25))
    c = m.get("compressor", {"threshold_db": -16.0, "ratio": 1.8, "attack_ms": 30.0, "release_ms": 220.0})
    if c:
        x = dsp.compress(x, c.get("threshold_db", -16.0), c.get("ratio", 1.8), c.get("attack_ms", 30.0), c.get("release_ms", 220.0), c.get("makeup_db", 0.0))
    x = dsp.width(x, m.get("width", 1.1)) * 10.0 ** (m.get("gain_db", 0.0) / 20.0)
    if "length_s" in score:
        n = int(score["length_s"] * SR)
        x = x[:n] if len(x) >= n else np.vstack([x, np.zeros((n - len(x), 2))])
    x = dsp.fade(x, m.get("fade_in", 0.0), m.get("fade_out", 0.15))
    info = {"tracks": stats}
    if m.get("normalize", True):
        ld = m.get("loudness", {})
        x, li = dsp.master_loudness(x, ld.get("lufs", -14.0), ld.get("true_peak", -1.0), ld.get("limit_db", 9.0))
        info.update(li)
    return x, info, piece


def check_score(score):
    errs, warns = [], []
    dsp.validate(score, SCORE, "score", errs)
    if errs:
        return errs, warns, None, None
    key = parse_key(score["key"])
    if key is None:
        errs.append(f"score.key: {score['key']!r} should look like \"C major\", \"A minor\", \"D dorian\" (modes: {', '.join(MODES)})")
        return errs, warns, None, None
    names = [s["name"] for s in score["sections"]]
    for i, sec in enumerate(score["sections"]):
        if sec["bars"] % len(sec["chords"]) and len(sec["chords"]) < sec["bars"]:
            warns.append(f"sections[{i}] ({sec['name']}): {len(sec['chords'])} chords over {sec['bars']} bars cycles unevenly; the progression is cut off at the end")
        if len(sec["chords"]) > sec["bars"]:
            warns.append(f"sections[{i}] ({sec['name']}): {len(sec['chords'])} chords but only {sec['bars']} bars; the extra chords are never played")
    for i, tr in enumerate(score["tracks"]):
        if not isinstance(tr["sections"], dict):
            errs.append(f"tracks[{i}].sections: must be an object like {{\"verse\": \"pattern\"}}")
            continue
        if "instrument" in tr and tr["role"] != "drums":
            want = voices.INSTRUMENTS[tr["instrument"]][0]
            ok = {"melody": ("lead", "keys", "plucked", "pad"), "chorale": ("pad", "keys", "lead")}.get(tr["role"], (tr["role"],))
            if want not in ok:
                warns.append(f"tracks[{i}].instrument: {tr['instrument']} is a {want} sound, an unusual choice for a {tr['role']} track")
        if tr["role"] == "drums" and "instrument" in tr:
            errs.append(f"tracks[{i}].instrument: drums use \"kit\" (acoustic, electronic, lofi, soft), not instrument")
    if errs:
        return errs, warns, None, None
    ee = []
    x, info, piece = render(score, ee, warns)
    errs += ee
    if x is None:
        return errs, warns, None, None
    unused = [n for n in names if not any(n in tr["sections"] or "*" in tr["sections"] for tr in score["tracks"])]
    for n in unused:
        warns.append(f"section {n!r} has no track playing in it")
    a = dsp.analyze(x, info)
    m = score.get("master", {})
    if a["silent"]:
        errs.append("the result is silent: check that the tracks have entries for the section names")
        return errs, warns, a, x
    if a["over_samples"]:
        errs.append(f"clipping: {a['over_samples']} samples past full scale; turn master.normalize on or lower master.gain_db")
    if m.get("normalize", True):
        ld = m.get("loudness", {})
        target, tp = ld.get("lufs", -14.0), ld.get("true_peak", -1.0)
        d = a["lufs"] - target
        if abs(d) > 1.0:
            errs.append(f"loudness {a['lufs']:.1f} LUFS is {d:+.1f} LU from the target {target}; peaks stop the limiter: thin the drums or lower level_db on loud tracks")
        elif abs(d) > 0.5:
            warns.append(f"loudness {a['lufs']:.1f} LUFS is {d:+.1f} LU from the target {target}")
        if a["true_peak_dbtp"] > tp + 0.05:
            errs.append(f"true peak {a['true_peak_dbtp']:.2f} dBTP is above the limit {tp}")
    if a["dc_offset"] > 0.01:
        errs.append(f"DC offset {a['dc_offset']:.3f}")
    if a["lead_silence_s"] > 1.0:
        warns.append(f"{a['lead_silence_s']:.1f} s of silence at the start")
    if a["tail_silence_s"] > 4.0:
        warns.append(f"{a['tail_silence_s']:.1f} s of silence at the end; lower master.tail or set length_s")
    if "length_s" in score and abs(a["duration_s"] - score["length_s"]) > 0.05:
        errs.append(f"length {a['duration_s']:.2f} s is not the requested {score['length_s']} s")
    expect = piece.total_q * piece.spq
    if "length_s" not in score and a["duration_s"] < expect:
        errs.append(f"length {a['duration_s']:.1f} s is shorter than the bars ({expect:.1f} s)")
    if a["duration_s"] > 600:
        errs.append(f"length {a['duration_s']:.0f} s: this tool is for short pieces; render sections and join them")
    if a["correlation"] > 0.995 and a["duration_s"] > 1:
        warns.append("the mix is nearly mono; pan some tracks or add chorus and reverb")
    a["bars_s"] = expect
    a["tracks"] = info.get("tracks")
    a["sections"] = [(sec["start_q"] * piece.spq, sec["name"]) for sec in piece.sections]
    return errs, warns, a, x


def template_dir():
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "templates")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Render a short piece of music from a JSON score.")
    ap.add_argument("paths", nargs="*", help="score.json out.wav (or, with --template, just out.wav)")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--template")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--seed", type=int)
    ap.add_argument("--key")
    ap.add_argument("--tempo", type=float)
    ap.add_argument("--length", type=float)
    ap.add_argument("--bits", type=int, choices=[16, 24], default=16)
    ap.add_argument("--sheet", help="also draw a PNG contact sheet (waveform, spectrogram, loudness, band balance) to look at")
    args = ap.parse_args(argv)
    if args.list:
        for f in sorted(glob.glob(os.path.join(template_dir(), "*.json"))):
            r = json.load(open(f, encoding="utf8"))
            print(f"{os.path.basename(f)[:-5]:<18} {r.get('note', '')[:110]}")
        return 0
    paths = list(args.paths)
    if args.template:
        spath = os.path.join(template_dir(), args.template + ".json")
    elif paths:
        spath = paths.pop(0)
        if not os.path.exists(spath) and os.path.exists(os.path.join(template_dir(), spath + ".json")):
            spath = os.path.join(template_dir(), spath + ".json")
    else:
        ap.print_usage(sys.stderr)
        return 2
    out = paths[0] if paths else None
    if out is None and not args.check:
        print("music.py: give an output file (out.wav), or use --check", file=sys.stderr)
        return 2
    try:
        with open(spath, encoding="utf8") as fh:
            score = json.load(fh)
    except (OSError, ValueError) as e:
        print(f"music.py: cannot read {spath}: {e}", file=sys.stderr)
        return 2
    if args.seed is not None:
        score["seed"] = args.seed
    if args.key:
        score["key"] = args.key
    if args.tempo:
        score["tempo"] = args.tempo
    if args.length:
        score["length_s"] = args.length
    errs, warns, stats, wav = check_score(score)
    if not errs and out:
        dsp.write_audio(out, wav, args.bits)
    if args.sheet and wav is not None:
        import sheet

        sheet.make_sheet(wav, args.sheet, markers=stats.get("sections") if stats else None, target_lufs=score.get("master", {}).get("loudness", {}).get("lufs", -14.0))
    if args.json:
        print(json.dumps(dsp.json_safe({"ok": not errs, "errors": errs, "warnings": warns, "stats": stats, "file": out if out and not errs else None}), indent=2))
    else:
        for e in errs:
            print("ERROR", e)
        for w in warns:
            print("warn ", w)
        if stats:
            print(f"{'FAIL' if errs else 'ok'}: {stats['duration_s']:.1f} s, {stats['lufs']:.1f} LUFS, true peak {stats['true_peak_dbtp']:.2f} dBTP, "
                  f"peak {stats['peak_dbfs']:.1f} dBFS, DC {stats['dc_offset']:.4f}, stereo correlation {stats['correlation']:.2f}" + (f" -> {out}" if out and not errs else ""))
        elif errs:
            print("FAIL: fix the errors above; nothing was rendered")
    return 1 if errs else 0


if __name__ == "__main__":
    sys.exit(main())
