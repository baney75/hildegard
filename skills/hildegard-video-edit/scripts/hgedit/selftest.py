# SPDX-License-Identifier: AGPL-3.0-only
"""Made-up recordings, and the self-test that proves the gate works.

`python edit_video.py selftest` makes a screen recording with a fake API key on screen for a few seconds, edits it twice,
and asserts the gate FAILS on the edit with no blur over the key and PASSES on the one with it. It needs tesseract for that
part and says so plainly when it is missing; the rest of the gate is exercised either way.
"""

import json
import os
import shutil
import tempfile
from fractions import Fraction

import av
import numpy as np
from PIL import Image, ImageDraw

from . import render, textfx, verify
from .media import RATE

# Built from pieces so this file holds no key-shaped text for a secret scanner to trip on.
FAKE_KEY = "-".join(["sk", "live", "51Hh3kJ9mQxZ2vB7nT4wRpL8"])
KEY_LINE = f"API_KEY={FAKE_KEY}"


# ── Sound ───────────────────────────────────────────────────────────────────────────────────────────────────────


def speech(seconds, seed=0, level=0.25):
    """Something with a voice's shape: a wavering 120 Hz buzz with 25 harmonics, loud and soft about four times a second."""
    n = int(seconds * RATE)
    t = np.arange(n) / RATE
    f0 = 120 + 10 * np.sin(2 * np.pi * 3 * t + seed)
    ph = np.cumsum(2 * np.pi * f0 / RATE)
    s = sum(np.sin(k * ph) / k for k in range(1, 26))
    s *= 0.6 + 0.4 * np.sin(2 * np.pi * 4 * t) ** 2
    return (level * s / np.max(np.abs(s))).astype(np.float32)


def fan(seconds, seed=1, level=0.01):
    rng = np.random.default_rng(seed)
    n = rng.normal(0, 1, int(seconds * RATE))
    n = np.convolve(n, np.ones(200) / 200, "same")
    return (level * n / np.std(n)).astype(np.float32)


def clicks(seconds, times, seed=2, level=0.3):
    """Keystrokes: 6 ms of decaying noise at each time."""
    rng = np.random.default_rng(seed)
    x = np.zeros(int(seconds * RATE), dtype=np.float32)
    for t in times:
        i = int(t * RATE)
        n = min(300, len(x) - i)
        if n > 0:
            x[i : i + n] += (level * rng.normal(0, 1, n) * np.exp(-np.arange(n) / 60)).astype(np.float32)
    return x


def voice_track(seconds, talk, typing=(), fan_level=0.01):
    """A mono track: fan noise all through, speech in each (start, end) of `talk`, keystrokes at each time in `typing`."""
    x = fan(seconds, level=fan_level) + clicks(seconds, typing)
    for i, (a, b) in enumerate(talk):
        n = int((b - a) * RATE)
        s = speech(b - a, seed=i)
        x[int(a * RATE) : int(a * RATE) + n] += s[: len(x) - int(a * RATE)]
    return x


def write_recording(path, seconds, fps, size, audio=None, scene=None):
    """An H.264/AAC MP4. `scene(i, t)` returns an (H, W, 3) uint8 frame; `audio` is a mono float track at 48 kHz or None."""
    w, h = size
    with av.open(path, "w", format="mp4") as c:
        v = c.add_stream("libx264", rate=Fraction(fps))
        v.width, v.height, v.pix_fmt = w, h, "yuv420p"
        v.options = {"crf": "16", "preset": "veryfast", "g": str(int(fps))}
        a = None
        if audio is not None:
            a = c.add_stream("aac", rate=RATE, layout="stereo")
            a.time_base = Fraction(1, RATE)
        for i in range(int(round(seconds * fps))):
            img = scene(i, i / fps) if scene else np.full((h, w, 3), (i * 3) % 255, np.uint8)
            fr = av.VideoFrame.from_ndarray(img, format="rgb24").reformat(format="yuv420p")
            fr.pts = i
            fr.time_base = Fraction(1, 1) / Fraction(fps)
            for p in v.encode(fr):
                c.mux(p)
        for p in v.encode():
            c.mux(p)
        if a is not None:
            size_ = a.codec_context.frame_size or 1024
            mono = audio[: int(seconds * RATE)]
            pad = (-len(mono)) % size_
            mono = np.concatenate([mono, np.zeros(pad, dtype=np.float32)])
            st = np.stack([mono, mono])
            pts = 0
            for i in range(0, st.shape[1], size_):
                fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(st[:, i : i + size_]), format="fltp", layout="stereo")
                fr.sample_rate = RATE
                fr.pts = pts
                fr.time_base = Fraction(1, RATE)
                pts += fr.samples
                for p in a.encode(fr):
                    c.mux(p)
            for p in a.encode():
                c.mux(p)


# ── A screen recording with a secret on it ──────────────────────────────────────────────────────────────────────

KEY_BOX = (0.03, 0.42, 0.94, 0.12)  # x, y, w, h as fractions of the frame


def terminal_scene(size, secret_from, secret_to, key_line=KEY_LINE):
    """Frames of a dark terminal: a few lines of text, a ticking counter, and `key_line` from `secret_from` to `secret_to`."""
    w, h = size
    fnt = textfx.font(h * 0.062)
    small = textfx.font(h * 0.045)
    base = Image.new("RGB", (w, h), (18, 22, 28))
    d = ImageDraw.Draw(base)
    d.text((w * 0.04, h * 0.06), "deploy@build-01:~$ ./release.sh --prod", font=small, fill=(120, 220, 140))
    d.text((w * 0.04, h * 0.17), "Building the release bundle ...", font=small, fill=(200, 200, 205))
    d.text((w * 0.04, h * 0.27), "Reading the environment:", font=small, fill=(200, 200, 205))
    d.text((w * 0.04, h * 0.67), "Uploading to the CDN ...", font=small, fill=(200, 200, 205))
    base_arr = np.asarray(base)

    def scene(i, t):
        img = Image.fromarray(base_arr.copy())
        dd = ImageDraw.Draw(img)
        if secret_from <= t < secret_to:
            dd.text((w * 0.04, h * 0.44), key_line, font=fnt, fill=(255, 235, 140))
        dd.text((w * 0.04, h * 0.84), f"step {i:04d}", font=small, fill=(150, 180, 255))
        dd.rectangle((w * 0.9, h * 0.06, w * 0.9 + 10 + (i % 40), h * 0.09), fill=(90, 90, 200))
        return np.asarray(img)

    return scene


def make_secret_recording(path, seconds=8.0, fps=15, size=(960, 540), secret=(2.0, 6.0)):
    talk = [(0.3, 2.0), (3.0, 5.0), (6.0, 7.5)]
    write_recording(path, seconds, fps, size, voice_track(seconds, talk), terminal_scene(size, *secret))
    return {"talk": talk, "secret": secret, "box": list(KEY_BOX), "key": FAKE_KEY}


# ── The self-test ───────────────────────────────────────────────────────────────────────────────────────────────


def run(workdir=None, say=print):
    """Returns (ok, [lines]). ok is True only when the gate failed the unblurred edit and passed the blurred one (or, with no
    tesseract, when everything else passed and the OCR step was reported as skipped)."""
    own = workdir is None
    d = workdir or tempfile.mkdtemp(prefix="hg-selftest-")
    lines = []

    def note(s):
        lines.append(s)
        say(s)

    try:
        src = os.path.join(d, "recording.mp4")
        info = make_secret_recording(src)
        base = {"version": 1, "sources": {"a": {"path": src}}, "target": {"name": "test", "height": 540, "lufs": -16, "peak": -1.0},
                "audio": {"keep_original": True, "clean": "no"}, "secrets": [FAKE_KEY], "verify": {"ocr_fps": 4}}
        runs = []
        for label, blur in (("no blur", None), ("blurred", {"start": 1.5, "end": 6.5, "box": info["box"]})):
            edl = json.loads(json.dumps(base))
            if blur:
                edl["blur"] = [blur]
            path = os.path.join(d, f"{label.replace(' ', '-')}.edl.json")
            with open(path, "w") as f:
                json.dump(edl, f)
            out = os.path.join(d, f"{label.replace(' ', '-')}.mp4")
            render.render(path, out, workers=1, encoder="libx264")
            rep = verify.verify(out, path)
            runs.append((label, rep))
            ocr = next(c for c in rep["checks"] if c["id"] == "ocr")
            note(f"{label}: gate {'passed' if rep['ok'] else 'failed'}; ocr {ocr['status']}: {ocr['detail']}")
        (_, bad), (_, good) = runs
        others = [c for r in (bad, good) for c in r["checks"] if c["id"] != "ocr" and c["status"] == "fail"]
        if others:
            note("Other checks failed: " + "; ".join(f"{c['id']}: {c['detail']}" for c in others))
            return False, lines
        if not shutil.which("tesseract"):
            note("tesseract is not installed, so the planted key was not looked for. Install it (apt install tesseract-ocr, brew install tesseract) and run again to prove the gate.")
            return True, lines
        if bad["ok"]:
            note("FAIL: the gate passed an edit with the key readable on screen.")
            return False, lines
        if not good["ok"]:
            note("FAIL: the gate failed the edit with the key blurred out.")
            return False, lines
        note("The gate failed the edit without the blur and passed the edit with it.")
        return True, lines
    finally:
        if own:
            shutil.rmtree(d, ignore_errors=True)
