# SPDX-License-Identifier: AGPL-3.0-only
"""The output gate: does the finished file prove the edit list?

Every check reads the output file, never the renderer's own account of what it did. The edit list is resolved again here
(the same function the renderer used), so the frame count and the times to compare against come from the edit list alone.

  render     the output is the render of this very edit list: the record the renderer left beside it names this list's
             hash and this file's (a video from an older list, or changed since, fails: render again)
  frames     the output has exactly the frames the edit list resolves to, one every 1/fps
  shape      size and frame rate are what the edit list asked for
  sync       each audio track is as long as the picture, to within a frame or two
  tracks     the audio tracks promised are there
  loudness   integrated loudness and true peak are on the target (EBU R128 through ffmpeg's ebur128, as PyAV carries it,
             streamed). When the list masters the sound, silence or a measurement that can't run fails
  black      no black stretch longer than allowed
  frozen     no frozen stretch longer than allowed
  overlays   every title and caption lies inside the frame
  ocr        with tesseract: OCR of the output finds none of the declared secrets anywhere in the video (sampled through
             the whole of it) and none of the built-in kinds (API keys, e-mail addresses, IPs, host names) in or around
             the hidden regions (4 frames a second there). At most OCR_CAP frames, one at a time, scaled to OCR_WIDTH

Status per check is pass, fail, warn or skip. The gate passes unless a check fails. A skipped OCR check is reported as
unproven: without tesseract nothing proves hidden text is unreadable. A tesseract that runs and fails is unproven too, and
fails the gate under require_ocr.
"""

import collections
import difflib
import gc
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction

import av
import numpy as np
from PIL import Image

from . import edl as edl_mod, media, plan as plan_mod
from .media import RATE

try:
    import sys

    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import voice_clean
except ImportError:  # pragma: no cover
    voice_clean = None


def check(id_, status, detail, **extra):
    return dict(id=id_, status=status, detail=detail, **extra)


def _runs(flags, fps):
    """Longest run of True in flags, as (seconds, start_second)."""
    best, best_at, cur, at = 0, 0.0, 0, 0
    for i, f in enumerate(flags):
        if f:
            if cur == 0:
                at = i
            cur += 1
            if cur > best:
                best, best_at = cur, at
        else:
            cur = 0
    return best / fps, best_at / fps


# ── One pass over the picture ───────────────────────────────────────────────────────────────────────────────────


def scan_picture(path):
    """(frames, pts_ok, black[], still[]) from every frame of the output, on a 64x36 grey copy."""
    n = 0
    prev = None
    black, still = [], []
    pts = []
    with av.open(path) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        v.thread_count = 2
        for f in c.decode(v):
            n += 1
            if f.pts is not None:
                pts.append(float(f.pts * f.time_base))
            g = f.to_ndarray(width=64, height=36, format="gray").astype(np.float32)
            black.append(bool(g.mean() < 15 and g.std() < 6))
            still.append(prev is not None and bool(np.abs(g - prev).mean() < 0.15))
            prev = g
    return n, pts, black, still


def audio_lengths(path):
    """Seconds of each audio stream, counted from its decoded samples as they go by; no sound is kept."""
    out = []
    with av.open(path) as c:
        count = len(c.streams.audio)
    for i in range(count):
        with av.open(path) as c:
            first, seconds = None, 0.0
            for f in c.decode(c.streams.audio[i]):
                if first is None and f.pts is not None:
                    first = float(f.pts * f.time_base)
                if f.sample_rate:
                    seconds += f.samples / f.sample_rate
        out.append(seconds + (first if first and first > 0.001 else 0.0))
    return out


# ── Loudness, streamed ──────────────────────────────────────────────────────────────────────────────────────────


class LoudnessError(Exception):
    """The measurement couldn't run; the message says why."""


# ebur128 reports about -70 LUFS for digital silence.
SILENT_LUFS = -69.0


def _ebur128_pyav(path, track):
    def go():
        with av.open(path) as c:
            rs = av.AudioResampler(format="fltp", layout="stereo", rate=RATE)
            g = av.filter.Graph()
            src = g.add_abuffer(format="fltp", sample_rate=RATE, layout="stereo", time_base=Fraction(1, RATE))
            meter = g.add("ebur128", "peak=true:framelog=quiet")
            sink = g.add("abuffersink")
            src.link_to(meter)
            meter.link_to(sink)
            g.configure()
            pos = 0

            def drain():
                while True:
                    try:
                        g.pull()
                    except (av.error.BlockingIOError, av.error.EOFError):
                        return

            def push(fr):
                nonlocal pos
                fr.pts, fr.time_base = pos, Fraction(1, RATE)
                pos += fr.samples
                g.push(fr)
                drain()

            for frame in c.decode(c.streams.audio[track]):
                for f in rs.resample(frame):
                    push(f)
            for f in rs.resample(None):
                push(f)
            g.push(None)
            drain()

    # The summary comes through PyAV's log callback. Put the level back exactly as it was, None included: a callback left
    # on makes every FFmpeg thread take the GIL to log, which deadlocks threaded decoding beside Python threads (the OCR).
    level = av.logging.get_level()
    with av.logging.Capture(local=False) as logs:
        av.logging.set_level(av.logging.INFO)
        av.logging.set_libav_level(av.logging.INFO)
        av.logging.set_skip_repeated(False)
        try:
            go()
            gc.collect()  # ebur128 prints its summary when the graph closes
        finally:
            av.logging.set_level(level)
            av.logging.set_libav_level(av.logging.WARNING if level is None else level)
    return "\n".join(m for _, _, m in logs)


def _ebur128_ffmpeg(ffmpeg, path, track):
    r = subprocess.run([ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "info", "-i", path, "-map", f"0:a:{track}",
                        "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"], capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        raise LoudnessError(f"ffmpeg exited with {r.returncode}")
    return r.stderr


def measure_loudness(path, track=0):
    """(integrated LUFS or None, true peak dBTP or None) of one audio stream, fed through ebur128 a frame at a time so a
    long video is never held in memory. None is what ebur128 gives for silence. Raises LoudnessError."""
    if voice_clean is None:
        raise LoudnessError("voice_clean.py isn’t next to these tools")
    try:
        be = voice_clean.choose_backend()
    except voice_clean.CleanError as e:
        raise LoudnessError(str(e)) from e
    try:
        text = _ebur128_pyav(path, track) if be.name == "pyav" else _ebur128_ffmpeg(be.path, path, track)
    except (av.error.FFmpegError, OSError, ValueError) as e:
        raise LoudnessError(f"the meter couldn’t read the sound ({type(e).__name__})") from e
    i = re.findall(r"I:\s+(-?[\d.]+|-inf)\s+LUFS", text)
    p = re.findall(r"Peak:\s+(-?[\d.]+|-inf)\s+dBFS", text)
    if not i:
        raise LoudnessError("the meter gave no reading")
    return voice_clean._num(i[-1]), (voice_clean._num(p[-1]) if p else None)


# ── Looking for secrets ─────────────────────────────────────────────────────────────────────────────────────────

# OCR confuses these; both sides are folded the same way before comparing.
FOLD = str.maketrans({"0": "o", "1": "l", "i": "l", "|": "l", "5": "s", "$": "s", "8": "b", "2": "z", "_": "-"})
KINDS = {
    "api_key": [
        r"\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}",
        r"\bAKIA[0-9A-Z]{16}\b",
        r"\bgh[pousr]_[A-Za-z0-9]{30,}",
        r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
        r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}",
        r"(?i)\b(?:api|secret|access)[_-]?(?:key|token)\s*[=:]\s*\S{8,}",
        r"\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}\b",
    ],
    "email": [r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"],
    "ip": [r"\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b"],
    "hostname": [r"(?i)\b(?:[a-z0-9][a-z0-9-]*\.)+(?:internal|local|lan|corp|intranet|home|cloud|com|net|org|io|dev|co)\b"],
}
ALL_KINDS = list(KINDS)


def mask(s):
    s = s.strip()
    return s[:4] + "…" + f"({len(s)} characters)" if len(s) > 8 else "…"


class OcrError(Exception):
    """tesseract ran and failed, so nothing was read; the message says why without naming a path."""


def ocr_text(png, psm=11):
    # One thread each: several run side by side, and tesseract's own threads only fight over the cores.
    env = dict(os.environ, OMP_THREAD_LIMIT="1")
    try:
        r = subprocess.run(["tesseract", png, "stdout", "--psm", str(psm), "-l", "eng"], capture_output=True, text=True,
                           timeout=60, env=env, errors="replace")
    except subprocess.TimeoutExpired as e:
        raise OcrError("tesseract took longer than a minute on one frame") from e
    except OSError as e:
        raise OcrError(f"tesseract couldn’t start ({type(e).__name__})") from e
    if r.returncode != 0:
        why = f"tesseract exited with {r.returncode}"
        if re.search(r"traineddata|load any languages|language", r.stderr or "", re.I):
            why += "; its English language data (eng.traineddata) is missing. Install tesseract-ocr-eng (or tesseract-lang)"
        raise OcrError(why)
    return r.stdout


def fuzzy_has(text, secret):
    """Whether `secret` is readable in OCR `text`: exact, or close enough once look-alike characters are folded."""
    flat = re.sub(r"\s+", "", text)
    if secret in text or secret in flat:
        return True
    if len(secret) < 8:
        return False
    s = secret.lower().translate(FOLD)
    best = 0.0
    for chunk in [flat] + [re.sub(r"\s+", "", ln) for ln in text.splitlines() if len(ln) >= 6]:
        t = chunk.lower().translate(FOLD)
        n = len(s)
        for a in range(0, max(1, len(t) - n + 3), 1):
            r = difflib.SequenceMatcher(None, s, t[a : a + n + 2], autojunk=False).quick_ratio()
            if r >= 0.8 and difflib.SequenceMatcher(None, s, t[a : a + n + 2], autojunk=False).ratio() >= 0.78:
                return True
            best = max(best, r)
    return False


TEXT_CAP = 2000  # a pattern meets at most this many characters at a time, so no frame's text can keep it running


def _search(rx, text):
    """re.search over `text` in overlapping pieces of TEXT_CAP characters."""
    return next((m for a in range(0, max(1, len(text)), TEXT_CAP - 200) if (m := re.search(rx, text[a : a + TEXT_CAP]))), None)


class RegexTimeout(Exception):
    """A declared secrets pattern did not finish in time, so what it looks for is unproven."""


REGEX_BUDGET = 3.0  # seconds of waiting on declared patterns in one OCR check, all frames together

# The child's whole program: read one JSON request per line (a pattern, the texts to search, the piece size), answer with
# the first match's text or null. It runs on its own so that a pattern that backtracks for hours costs a kill, not the job.
_JAIL = r"""
import json, re, sys
for line in sys.stdin:
    q = json.loads(line)
    try:
        rx, cap, out = q["rx"], q["cap"], None
        for text in q["texts"]:
            for a in range(0, max(1, len(text)), cap - 200):
                m = re.search(rx, text[a : a + cap])
                if m:
                    out = m.group(0)
                    break
            if out is not None:
                break
        r = {"m": out}
    except Exception as e:
        r = {"err": type(e).__name__}
    sys.stdout.write(json.dumps(r) + "\n")
    sys.stdout.flush()
"""


class RegexJail:
    """Runs declared secrets patterns in a child Python process under a hard deadline. Inspecting a pattern can't promise
    it finishes (a*a*a*a*b, or the same inside an alternative), so the guarantee is a clock: every match is asked of the
    child, the time spent waiting is added up, and when REGEX_BUDGET is used up the child is killed and every later match
    fails the same way (RegexTimeout). Threads take turns; the child starts on first use."""

    def __init__(self, budget=REGEX_BUDGET):
        self.budget, self.spent, self.dead = budget, 0.0, False
        self.proc = None
        self.lock = threading.Lock()
        self.replies = queue.Queue()

    def _start(self):
        self.proc = subprocess.Popen([sys.executable, "-I", "-c", _JAIL], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, encoding="utf-8")
        proc, replies = self.proc, self.replies

        def pump():
            try:
                for line in proc.stdout:
                    replies.put(line)
            except (OSError, ValueError):  # closed by _kill
                pass
            replies.put(None)

        threading.Thread(target=pump, daemon=True).start()

    def _kill(self):
        self.dead = True
        if self.proc is not None:
            try:
                self.proc.kill()
            except OSError:
                pass
            for pipe in (self.proc.stdin, self.proc.stdout):
                try:
                    pipe.close()
                except OSError:
                    pass
            try:
                self.proc.wait(timeout=5)
            except Exception:  # noqa: BLE001
                pass

    def search(self, rx, texts):
        """The first match's text (or None) of `rx` over the pieces of each of `texts`. Raises RegexTimeout."""
        why = RegexTimeout("A secrets regex could not be evaluated in time, so whether that secret is readable is unproven.")
        with self.lock:
            if self.dead:
                raise why
            started = time.monotonic()
            try:
                if self.proc is None:
                    self._start()
                self.proc.stdin.write(json.dumps({"rx": rx, "texts": texts, "cap": TEXT_CAP}) + "\n")
                self.proc.stdin.flush()
                left = self.budget - self.spent
                line = self.replies.get(timeout=max(0.01, left)) if left > 0 else None
            except (queue.Empty, OSError, ValueError):
                line = None
            self.spent += time.monotonic() - started
            if not line:
                self._kill()
                raise why
            r = json.loads(line)
            if "err" in r:
                raise RegexTimeout(f"A secrets regex could not be evaluated ({r['err']}), so whether that secret is readable is unproven.")
            return r["m"]

    def close(self):
        with self.lock:
            if self.proc is not None and not self.dead:
                self._kill()


def _kind_hits(text, kinds):
    hits = []
    flat = re.sub(r"[ \t]+", "", text)
    for kind in kinds:
        for rx in KINDS[kind]:
            m = _search(rx, text) or _search(rx, flat)
            if m:
                hits.append((kind, mask(m.group(0))))
                break
    return hits


def find_leaks(full_text, crop_text, secrets, kinds, full_kinds=(), jail=None):
    """[(label, masked text)] for what OCR read: declared secrets (strings, patterns and the kinds in `full_kinds`)
    anywhere on the frame, and `kinds` in the hidden region's crop. Declared patterns run in `jail` (one of the caller's,
    or a short-lived one); RegexTimeout is raised when one does not finish in time."""
    own = jail is None and any(isinstance(x, dict) and "regex" in x for x in secrets)
    jail = RegexJail() if own else jail
    try:
        return _find_leaks(full_text, crop_text, secrets, kinds, full_kinds, jail)
    finally:
        if own:
            jail.close()


def _find_leaks(full_text, crop_text, secrets, kinds, full_kinds, jail):
    hits = []
    both = full_text + "\n" + crop_text
    for sec in secrets:
        if isinstance(sec, str):
            if fuzzy_has(both, sec):
                hits.append(("declared secret", mask(sec)))
        elif "text" in sec:
            if fuzzy_has(both, sec["text"]):
                hits.append(("declared secret", mask(sec["text"])))
        elif "regex" in sec:
            m = jail.search(sec["regex"], [both, re.sub(r"\s+", "", both)])
            if m:
                hits.append(("declared pattern", mask(m)))
    if full_kinds and full_text.strip():
        hits += _kind_hits(full_text, full_kinds)
    if crop_text.strip():
        seen = {k for k, _ in hits}
        hits += [h for h in _kind_hits(crop_text, kinds) if h[0] not in seen]
    return hits


def secret_kinds(plan):
    v = plan["verify"]
    kinds = list(v.get("ocr_kinds", ALL_KINDS))
    for sec in plan["secrets"]:
        if isinstance(sec, dict) and "kind" in sec and sec["kind"] not in kinds:
            kinds.append(sec["kind"])
    return kinds


# OCR reads at most this many frames in one verify, however long the video; a frame wider than OCR_WIDTH is scaled down
# before tesseract sees it, and only OCR_AHEAD frames per reader wait their turn (as PNG files, not pixels), so memory
# stays the same for an hour of 4K as for a minute of 720p.
OCR_CAP = 900
OCR_WIDTH = 1920
OCR_AHEAD = 2


def _merge(windows):
    merged = []
    for a, b in sorted(windows):
        if merged and a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
        else:
            merged.append((a, b))
    return merged


class _Sampler:
    """Which frames OCR reads, asked in time order: one every `step_all` seconds through the whole video (None: not the
    whole video), and one every `step_near` seconds inside `near`. A frame read for either counts for both."""

    def __init__(self, near, step_near, step_all):
        self.near, self.step_near, self.step_all = near, step_near, step_all
        self.next_near = self.next_all = float("-inf")

    def __call__(self, t):
        inside = any(a <= t <= b for a, b in self.near)
        if not ((self.step_all is not None and t + 1e-6 >= self.next_all) or (inside and t + 1e-6 >= self.next_near)):
            return False
        if self.step_all is not None:
            self.next_all = t + self.step_all
        if inside:
            self.next_near = t + self.step_near
        return True


def ocr_check(out_path, plan):
    v = plan["verify"]
    secrets = plan["secrets"]
    wants = bool(plan["blur"] or secrets)
    if not wants:
        return check("ocr", "skip", "Nothing was hidden and no secrets were declared, so there is nothing to look for.")
    if not shutil.which("tesseract"):
        status = "fail" if v.get("require_ocr") else "skip"
        return check("ocr", status, "tesseract isn’t installed, so nothing proves the hidden text is unreadable in the output (unproven). "
                     "Install it (apt install tesseract-ocr, brew install tesseract, or the UB Mannheim build on Windows) and verify again.", unproven=True)
    step = 1.0 / float(v.get("ocr_fps", 4))
    total = plan["out_seconds"]
    near = _merge([(max(0.0, a - 1.0), min(total, z + 1.0)) for b in plan["blur"] for a, z in b["out"]])
    # Declared secrets are looked for through the whole video, blur or not: a key blurred at 10 s can still be readable at
    # 40 s. The built-in kinds are looked for in the hidden regions, and on the whole frame from 1 s before each to 1 s after.
    whole = v.get("ocr_scan") == "all" or not plan["blur"] or bool(secrets)
    near_len = sum(b - a for a, b in near)
    budget = OCR_CAP // 2 if (whole and near) else OCR_CAP
    step_near = max(step, near_len / budget) if near else step
    step_all = max(step, total / budget) if whole else None
    sampler = _Sampler(near, step_near, step_all)
    ranges = [(0.0, total)] if whole else near
    full_kinds = [k for k in ALL_KINDS if any(isinstance(s, dict) and s.get("kind") == k for s in secrets)]
    scan_all = v.get("ocr_scan") == "all"
    kinds = secret_kinds(plan) if (plan["blur"] or scan_all) else []
    d = tempfile.mkdtemp(prefix="hg-ocr-")
    jail = RegexJail()

    def prepare(i, t, rgb):
        """The frame as PNG files for tesseract (the whole frame, no wider than OCR_WIDTH, and each hidden region's crop),
        so the pixels can go at once."""
        h, w = rgb.shape[:2]
        im = Image.fromarray(rgb)
        crops = []
        regions = [bx for b in plan["blur"] for a, z in b["out"] if a - 0.05 <= t <= z + 0.05 for bx in [_region_at(plan, b, t, a)] if bx]
        for j, (x0, y0, x1, y1) in enumerate(regions):
            padx, pady = int((x1 - x0) * 0.1) + 8, int((y1 - y0) * 0.5) + 8
            cr = im.crop((max(0, x0 - padx), max(0, y0 - pady), min(w, x1 + padx), min(h, y1 + pady)))
            k = min(3.0, OCR_WIDTH * 1.5 / max(1, cr.width))
            cr = cr.resize((max(1, round(cr.width * k)), max(1, round(cr.height * k))), Image.LANCZOS)
            cp = os.path.join(d, f"c{i}-{j}.png")
            cr.save(cp)
            crops.append(cp)
        k = 2.0 if w < 1400 else min(1.0, OCR_WIDTH / w)
        if k != 1.0:
            im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
        p = os.path.join(d, f"f{i}.png")
        im.save(p)
        return t, p, crops

    def read(item):
        t, p, crops = item
        try:
            full = ocr_text(p, 11)
            crop_txt = "".join("\n" + ocr_text(cp, 6) for cp in crops)
        finally:
            for f in [p, *crops]:
                try:
                    os.remove(f)
                except OSError:
                    pass
        fk = full_kinds + [k for k in kinds if k not in full_kinds] if scan_all or any(a <= t <= b for a, b in near) else full_kinds
        return t, find_leaks(full, crop_txt, secrets, kinds, fk, jail)

    workers = max(1, min(4, os.cpu_count() or 1))
    # Decoding runs beside the reader threads: with PyAV's log callback on (voice_clean leaves it on after a measure), an
    # FFmpeg thread that logs waits for the GIL and the decode deadlocks. Off for the scan, as it was after.
    log_level = av.logging.get_level()
    av.logging.set_level(None)
    ex = ThreadPoolExecutor(max_workers=workers)
    pending = collections.deque()
    results = []
    count = 0
    try:
        for a, b in ranges:
            for t, rgb in media.video_frames(out_path, start=a, end=b, pick=sampler):
                item = prepare(count, t, rgb)
                del rgb
                count += 1
                pending.append(ex.submit(read, item))
                while len(pending) >= workers * OCR_AHEAD:
                    results.append(pending.popleft().result())
        while pending:
            results.append(pending.popleft().result())
    except OcrError as e:
        status = "fail" if v.get("require_ocr") else "warn"
        return check("ocr", status, f"OCR couldn’t run: {e}. Nothing was read, so nothing proves the hidden text is unreadable in the output (unproven). "
                     "Fix tesseract and verify again.", unproven=True)
    except RegexTimeout as e:
        status = "fail" if v.get("require_ocr") else "warn"
        return check("ocr", status, f"{e} Nothing proves the declared secrets are unreadable in the output (unproven). Simplify the pattern "
                     f"(or use text instead) and verify again.", unproven=True)
    finally:
        ex.shutdown(wait=True, cancel_futures=True)
        jail.close()
        shutil.rmtree(d, ignore_errors=True)
        av.logging.set_level(log_level)
    if not count:
        return check("ocr", "warn", "No frames fell in the hidden stretches to read.")
    leaks = [(t, label, text) for t, hits in results for label, text in hits]
    parts = []
    if whole:
        parts.append(f"the whole video at about {1 / step_all:.1f} frames a second")
    if near:
        parts.append(f"the hidden stretches ({', '.join(f'{a:.1f} to {b:.1f} s' for a, b in near[:4])}{'…' if len(near) > 4 else ''}) at about {1 / step_near:.1f}")
    span = f"{count} frames: {' and '.join(parts)}"
    if leaks:
        first = {}
        for t, label, text in leaks:
            first.setdefault((label, text), []).append(t)
        shown = "; ".join(f"{label} {text} readable at {', '.join(f'{x:.1f}' for x in ts[:3])} s" for (label, text), ts in list(first.items())[:4])
        return check("ocr", "fail", f"OCR of the finished video found what should be hidden. {shown}. Add or widen a blur (style solid for a secret) over it, render and verify again.",
                     frames=count, leaks=[{"t": round(t, 2), "kind": label} for t, label, _ in leaks[:20]])
    if whole and step_all > 2.0:
        status = "fail" if v.get("require_ocr") else "warn"
        return check("ocr", status, f"OCR read {span} and found nothing, but it could reach only one frame every {step_all:.0f} s, so a secret shown for "
                     f"less can fall between them (unproven). Only a video up to {budget * 2 // 60} minutes long is read every 2 s.", frames=count, unproven=True)
    looked = f"none of the {len(secrets)} declared secrets in what it read"
    if kinds:
        looked += f", and none of the built-in kinds ({', '.join(kinds)}) in or around the hidden regions"
    return check("ocr", "pass", f"OCR read {span}, and found {looked}.", frames=count)


def _region_at(plan, b, t_out, win_start):
    """The hidden region in output pixels at output second t_out, for blur entry b."""
    fps = float(plan.fps)
    # Find the source time shown at t_out.
    f = int(t_out * fps)
    for s in plan["segments"]:
        if s["out_frame"] <= f < s["out_frame"] + s["frames"] and s["source"] == b["source"]:
            t_src = (s["src_frame"] + f - s["out_frame"]) / fps
            from .render import _key_box  # noqa: PLC0415

            return plan_mod.to_output(plan, b["source"], t_src, _key_box(b, t_src))
    return None


# ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────


def _inputs_changed(was, plan):
    """None when the footage and music are the files the video was rendered from; otherwise what to tell the person."""
    now = edl_mod.input_identities(plan)
    if not isinstance(was, dict):
        return "The render left no record of the footage it used, so nothing proves it is still the same. Render again, then verify."
    if was.get("sources") != now["sources"] or was.get("music") != now.get("music"):
        changed = [sid for sid, i in now["sources"].items() if (was.get("sources") or {}).get(sid) != i]
        if was.get("music") != now.get("music"):
            changed.append("music")
        return f"Source changed since render ({', '.join(changed) or 'the set of sources'}): its file is not the one this video was made from. Re-render, then verify."
    return None


def verify(out_path, edl_path, base_dir=None):
    """Check the file at `out_path` against the edit list at `edl_path`. Returns {ok, checks, unproven, ...}."""
    edl = edl_mod.load(edl_path)
    base = base_dir or os.path.dirname(os.path.abspath(edl_path))
    plan = plan_mod.resolve(edl, base, track=False)
    v = plan["verify"]
    checks = []
    fps = float(plan.fps)
    if not os.path.isfile(out_path):
        return {"ok": False, "checks": [check("frames", "fail", f"There is no output file at {out_path}.")], "unproven": []}
    try:
        info = media.probe(out_path)
    except media.MediaError as e:
        return {"ok": False, "checks": [check("frames", "fail", str(e))], "unproven": []}

    # The renderer left a record beside the file: the hash of the edit list it rendered and of the file it wrote. Only a
    # video rendered from this very list, unchanged since, can prove it.
    was = None
    try:
        with open(out_path + ".plan.json", encoding="utf-8") as f:
            was = json.load(f)
    except (OSError, ValueError):
        pass
    if not isinstance(was, dict) or not was.get("edl_sha256"):
        checks.append(check("render", "fail", "There is no record of which edit list made this video. Render it from this edit list, then verify."))
    elif was["edl_sha256"] != edl_mod.render_key(edl, base):
        checks.append(check("render", "fail", "This video was rendered from a different edit list. Render again, then verify."))
    elif was.get("out_sha256") != media.file_sha256(out_path):
        checks.append(check("render", "fail", "This video changed after it was rendered. Render again, then verify."))
    elif (changed := _inputs_changed(was.get("inputs"), plan)) is not None:
        checks.append(check("render", "fail", changed))
    else:
        checks.append(check("render", "pass", "This video is the render of this edit list, unchanged since."))
        # Where the renderer put the crop is the one thing resolve() can't know without searching the footage again.
        if plan["reframe"]["mode"] and isinstance(was.get("reframe"), dict) and "tracks" in was["reframe"]:
            plan["reframe"]["tracks"] = was["reframe"]["tracks"]

    n, pts, black, still = scan_picture(out_path)
    want = plan["out_frames"]
    gaps = None
    if len(pts) > 1:
        d = np.diff(np.array(pts))
        gaps = float(np.abs(d - 1 / fps).max())
    ok_frames = n == want and (gaps is None or gaps < 0.5 / fps)
    checks.append(check("frames", "pass" if ok_frames else "fail",
                        f"{n} frames, the edit list resolves to {want}" + ("" if ok_frames else (f"; spacing off by {gaps * 1000:.0f} ms" if n == want else "")),
                        got=n, want=want))
    o = plan["output"]
    size_ok = (info["width"], info["height"]) == (o["width"], o["height"]) and abs((info["fps"] or 0) - fps) < 0.02
    checks.append(check("shape", "pass" if size_ok else "fail",
                        f"{info['width']}x{info['height']} at {info['fps']:.3f} fps; wanted {o['width']}x{o['height']} at {fps:.3f}"))

    vsec = n / fps
    tracks = audio_lengths(out_path)
    want_tracks = 1 if (plan["audio"]["mute"] or not plan["audio"]["keep_original"]) else 2
    checks.append(check("tracks", "pass" if len(tracks) == want_tracks else "fail",
                        f"{len(tracks)} audio track{'s' if len(tracks) != 1 else ''}; the edit list asks for {want_tracks}"))
    tol = max(0.06, 2 / fps)
    off = [(i, s) for i, s in enumerate(tracks) if abs(s - vsec) > tol]
    if tracks:
        checks.append(check("sync", "fail" if off else "pass",
                            "; ".join(f"track {i} is {s:.3f} s, the picture {vsec:.3f} s" for i, s in off) if off
                            else f"audio {', '.join(f'{s:.3f}' for s in tracks)} s against picture {vsec:.3f} s (within {tol * 1000:.0f} ms)"))
    else:
        checks.append(check("sync", "skip", "There is no sound."))

    t = plan["target"]
    if plan["audio"]["mute"] or not plan["audio"]["master"]:
        checks.append(check("loudness", "skip", "The edit list is silent or leaves the sound unmastered, so there is no target to measure."))
    elif not tracks:
        checks.append(check("loudness", "fail", "The edit list masters the sound, and the video has none."))
    else:
        # The list masters the sound: only a measurement on the target passes. One that can't run proves nothing.
        try:
            lufs, tp = measure_loudness(out_path, 0)
        except LoudnessError as e:
            lufs = tp = None
            checks.append(check("loudness", "fail", f"Couldn’t measure the loudness ({e}), so nothing proves it is on the target (unproven).", unproven=True))
        else:
            tl = v.get("lufs_tolerance", 1.0)
            if lufs is None or lufs <= SILENT_LUFS or tp is None:
                checks.append(check("loudness", "fail", "The sound is silent, and the edit list masters it. Check that the source has sound, or set audio.mute to true for a silent video."))
            else:
                good = abs(lufs - t["lufs"]) <= tl and tp <= t["peak"] + 0.1
                checks.append(check("loudness", "pass" if good else "fail",
                                    f"{lufs:.1f} LUFS and {tp:.1f} dBTP; target {t['lufs']:g} ±{tl:g} LUFS, peak at most {t['peak']:g} dBTP",
                                    lufs=lufs, true_peak=tp))

    allowed = [tuple(x) for x in v.get("allow_black", [])]
    flags = [b and not any(a <= i / fps <= z for a, z in allowed) for i, b in enumerate(black)]
    mb, at = _runs(flags, fps)
    lim = v.get("max_black", 0.5)
    checks.append(check("black", "fail" if mb > lim else "pass",
                        f"Black for {mb:.2f} s starting at {at:.1f} s (allowed {lim:g} s)" if mb > lim else f"The longest black stretch is {mb:.2f} s (allowed {lim:g} s)"))
    ms, at = _runs(still, fps)
    lim = v.get("max_frozen", 6.0)
    checks.append(check("frozen", "fail" if ms > lim else "pass",
                        f"Nothing changes for {ms:.1f} s starting at {at:.1f} s (allowed {lim:g} s)" if ms > lim else f"The longest still stretch is {ms:.1f} s (allowed {lim:g} s)"))

    outside = []
    near = []
    for kind, a, z, box in plan_mod.overlay_boxes(plan):
        from . import textfx  # noqa: PLC0415

        if not textfx.inside(box, o["width"], o["height"]):
            outside.append(f"{kind} at {a:.1f} s")
        elif not textfx.inside(box, o["width"], o["height"], 0.02):
            near.append(f"{kind} at {a:.1f} s")
    nover = len(plan["cues"]) + len(plan["titles"])
    if outside:
        checks.append(check("overlays", "fail", f"These run outside the frame: {', '.join(outside[:5])}."))
    elif near:
        checks.append(check("overlays", "warn", f"These sit within 2% of the frame edge: {', '.join(near[:5])}."))
    else:
        checks.append(check("overlays", "pass" if nover else "skip", f"All {nover} titles and captions are inside the frame." if nover else "No titles or captions."))

    if t.get("max_seconds") and vsec > t["max_seconds"] + 0.05:
        checks.append(check("length", "warn", f"{vsec:.1f} s is longer than {t['name']} likes ({t['max_seconds']:g} s)."))

    checks.append(ocr_check(out_path, plan))
    unproven = [c["id"] for c in checks if c.get("unproven")]
    return {"ok": not any(c["status"] == "fail" for c in checks), "checks": checks, "unproven": unproven,
            "seconds": round(vsec, 3), "frames": n}
