# SPDX-License-Identifier: AGPL-3.0-only
"""What the footage is doing: when someone speaks, when something is typed or clicked, how much moves, where the subject is.

Speech is found from energy in the voice band of the sound, measured against the recording's own noise floor, and it has to
last: a keystroke is loud and short, a fan is steady and low, so neither is speech, and neither hides a pause (a fixed
silence level, like silencedetect, fails both ways). A pause is dead air only when it holds no speech and no typing or
clicking; typing in a pause is something happening, and the pause stays unless asked otherwise.
"""

import itertools

import numpy as np

from . import media

HOP = 0.01  # seconds per analysis frame
SR = 16000  # analysis rate: the sound is averaged down from 48 kHz
MIN_SPEECH = 0.12  # a sound above the floor shorter than this is a click, not a word
BRIDGE = 0.18  # a gap between words shorter than this is not a pause
SPEECH_DB = 10.0  # above the noise floor to count as speech
KEEP_DB = 6.0  # a word's tail is followed down to this


def _mono16(x):
    """(channels, samples) at 48 kHz → mono float at 16 kHz. A 1-D array is taken to be that already."""
    if x.ndim == 1:  # already mono at 16 kHz
        return x.astype(np.float32, copy=False)
    m = x.mean(axis=0)
    n = m.shape[0] // 3 * 3
    return m[:n].reshape(-1, 3).mean(axis=1).astype(np.float32)


def bands(x48):
    """Per 10 ms frame: energy (dB) in the voice band (150 to 3500 Hz) and the click band (3500 to 7500 Hz)."""
    m = _mono16(x48)
    win, hop = 400, 160
    n = max(0, (m.shape[0] - win) // hop + 1)
    if n == 0:
        return np.zeros(0), np.zeros(0)
    w = np.hanning(win).astype(np.float32)
    freqs = np.fft.rfftfreq(win, 1 / SR)
    voice = (freqs >= 150) & (freqs < 3500)
    click = (freqs >= 3500) & (freqs < 7500)
    ev = np.empty(n, dtype=np.float64)
    ec = np.empty(n, dtype=np.float64)
    step = 8000
    for a in range(0, n, step):
        b = min(n, a + step)
        idx = (np.arange(a, b)[:, None] * hop + np.arange(win)[None, :])
        spec = np.abs(np.fft.rfft(m[idx] * w, axis=1)) ** 2
        ev[a:b] = spec[:, voice].sum(axis=1)
        ec[a:b] = spec[:, click].sum(axis=1)
    to_db = lambda p: 10 * np.log10(p / win + 1e-12)  # noqa: E731
    return to_db(ev), to_db(ec)


def _floor(e, seconds=20.0):
    """The noise floor per frame: the 10th percentile of each 20 s block, joined smoothly."""
    n = len(e)
    if n == 0:
        return e
    block = int(seconds / HOP)
    if n <= block:
        return np.full(n, np.percentile(e, 10))
    centers, vals = [], []
    for a in range(0, n, block):
        seg = e[a : a + block]
        if len(seg) < block // 4 and centers:
            break
        centers.append(a + len(seg) / 2)
        vals.append(np.percentile(seg, 10))
    return np.interp(np.arange(n), centers, vals)


def _runs(mask):
    """[(start, end)] frame index pairs where mask is true."""
    if len(mask) == 0:
        return []
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def activity(x48, banded=None):
    """Speech and clicks in a stretch of sound (or in its bands() when `banded` is given).

    Returns {'hop': 0.01, 'speech': [(start_s, end_s)], 'clicks': [time_s], 'floor_db', 'speech_db', 'frames'}."""
    ev, ec = bands(x48) if banded is None else banded
    n = len(ev)
    if n == 0:
        return {"hop": HOP, "speech": [], "clicks": [], "floor_db": None, "speech_db": None, "frames": 0}
    floor = _floor(ev)
    ref = np.percentile(ev, 97)
    spread = max(0.0, ref - np.percentile(floor, 50))
    # A recording with no clear speech (all one level) has no speech: the gate needs real separation from the floor.
    sep = spread >= 12.0
    hi = floor + max(SPEECH_DB, 0.25 * spread)
    lo = floor + KEEP_DB
    above = ev > hi
    # Follow each loud stretch down to its tail with the lower threshold.
    keep = ev > lo
    grown = np.zeros(n, dtype=bool)
    for a, b in _runs(above):
        s, e = a, b
        while s > 0 and keep[s - 1] and a - s < 15:
            s -= 1
        while e < n and keep[e] and e - b < 30:
            e += 1
        grown[s:e] = True
    runs = _runs(grown)
    bridge, minlen = int(BRIDGE / HOP), int(MIN_SPEECH / HOP)
    # A long loud stretch is speech. A short one beside speech is a syllable of it; a short one alone is a click.
    # Clicks near each other do not add up to speech, however close they are.
    is_speech = [(b - a) >= minlen and sep for a, b in runs]
    for _ in range(3):
        for i, (a, b) in enumerate(runs):
            if is_speech[i] or not sep:
                continue
            near = (i > 0 and is_speech[i - 1] and a - runs[i - 1][1] <= bridge) or (
                i + 1 < len(runs) and is_speech[i + 1] and runs[i + 1][0] - b <= bridge
            )
            if near:
                is_speech[i] = True
    merged, clicks = [], []
    for (a, b), sp in zip(runs, is_speech):
        if not sp:
            clicks.append((a + int(np.argmax(ev[a:b]))) * HOP)
        elif merged and a - merged[-1][1] <= bridge:
            merged[-1] = (merged[-1][0], b)
        else:
            merged.append((a, b))
    speech = [(a * HOP, b * HOP) for a, b in merged]
    return {"hop": HOP, "speech": speech, "clicks": clicks, "floor_db": float(np.median(floor)),
            "speech_db": float(ref), "frames": n}


def analyze(path, track=0, start=0.0, end=None):
    """activity() of a file's sound from `start` to `end`, with times in the file's own seconds. The sound streams through
    bands() ten seconds at a time and only its 10 ms energies are kept, so memory stays fixed however long the file."""
    if end is None:
        end = media.probe(path)["seconds"]
    i, n = int(round(start * SR)), int(round((end - start) * SR))
    buf, have, ev, ec = [], 0, [np.zeros(0)], [np.zeros(0)]
    for p, x in itertools.chain(media.audio_blocks(path, track, 1, SR, end + 1.0), [(0, None)]):
        if x is not None:
            buf.append(x[0, max(0, i - p) : max(0, i + n - p)])
            have += len(buf[-1])
        if have >= SR * 10 or (x is None and have):
            m = np.concatenate(buf)
            a, b = bands(m)
            ev.append(a)
            ec.append(b)
            buf, have = [m[len(a) * 160 :]], len(m) - len(a) * 160
    act = activity(None, (np.concatenate(ev), np.concatenate(ec)))
    shift = start - 0.0125  # a frame's time is its middle
    act["speech"] = [(a + shift, b + shift) for a, b in act["speech"]]
    act["clicks"] = [c + shift for c in act["clicks"]]
    return act


def speech_fraction(act, seconds):
    if not seconds:
        return 0.0
    return sum(b - a for a, b in act["speech"]) / seconds


def dead_pauses(act, start, end, max_pause=0.7, keep=0.3, margin=0.12, activity_mode="keep", min_clicks=2):
    """The stretches of [start, end) (seconds, in the time `act` was measured in) to cut so long pauses become short ones.

    Returns (cuts, kept) where cuts is [(a, b)] and kept is [(a, b, why)] for pauses left alone because typing or
    clicking happens in them. A pause longer than `max_pause` between two stretches of speech is cut down to
    max(keep, 2 * margin); the margin stays next to each word, so a word's quiet edges are never clipped."""
    speech = [s for s in act["speech"] if s[1] > start and s[0] < end]
    clicks = act["clicks"]
    resid = max(keep, 2 * margin)
    # Gaps: before the first speech, between, after the last. Each is (a, b, left_is_speech, right_is_speech).
    gaps = []
    prev = start
    prev_speech = False
    for s, e in speech:
        gaps.append((prev, max(prev, s), prev_speech, True))
        prev, prev_speech = min(e, end), True
    gaps.append((prev, end, prev_speech, False))
    cuts, kept = [], []
    for a, b, left, right in gaps:
        length = b - a
        if length <= max_pause:
            continue
        typing = sum(1 for c in clicks if a <= c < b)
        if typing >= min_clicks and activity_mode == "keep":
            kept.append((a, b, "typing or clicking"))
            continue
        # At the edge of the stretch the pause has only one side to protect.
        ca = a + (resid / 2 if left else 0.0)
        cb = b - (resid / 2 if right else 0.0)
        if not left and not right:  # no speech at all in the stretch: leave it to the caller
            continue
        if not left:
            ca = a
        if not right:
            cb = b
        if cb - ca >= 0.1:
            cuts.append((round(ca, 3), round(cb, 3)))
    return cuts, kept


# ── Motion ──────────────────────────────────────────────────────────────────────────────────────────────────────


def motion_series(path, start=0.0, end=None, fps=10.0):
    """[(time, amount)]: how much the picture changed since the last sample, 0 to 255, from a 64x36 grey copy."""
    out = []
    prev = None
    for t, rgb in media.video_frames(path, step=1.0 / fps, start=start, end=end, size=(64, 36)):
        g = rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
        if prev is not None:
            out.append((t, float(np.abs(g - prev).mean())))
        prev = g
    return out


def auto_cuts(path, audio_track=0, mode="both", min_quiet=0.7, margin=0.2, motion_thr=0.6, start=0.0, end=None):
    """A first pass like auto-editor's: cut where it is quiet (no speech, no typing), still, or both. Keeps `margin`
    seconds of each edge so the cut never lands on a word or a movement.

    mode: 'audio' (no speech and no typing), 'motion' (nothing moves), or 'both' (default: neither). Returns
    [(a, b, why)]."""
    info = media.probe(path)
    end = min(end if end is not None else info["seconds"], info["seconds"])
    quiet = np.ones(int((end - start) / HOP) + 1, dtype=bool)
    if mode in ("audio", "both") and info["audio"]:
        act = analyze(path, audio_track, start, end)
        act["speech"] = [(a - start, b - start) for a, b in act["speech"]]
        act["clicks"] = [c - start for c in act["clicks"]]
        mask = np.ones(len(quiet), dtype=bool)
        for s, e in act["speech"]:
            mask[int(s / HOP) : int(e / HOP) + 1] = False
        for c in act["clicks"]:
            mask[max(0, int((c - 0.15) / HOP)) : int((c + 0.25) / HOP) + 1] = False
        quiet &= mask[: len(quiet)] if len(mask) >= len(quiet) else np.pad(mask, (0, len(quiet) - len(mask)), constant_values=True)
    if mode in ("motion", "both") and info["video"]:
        still = np.ones(len(quiet), dtype=bool)
        for t, a in motion_series(path, start, end):
            if a > motion_thr:
                i = int((t - start) / HOP)
                still[max(0, i - 10) : i + 1] = False
        quiet &= still
    cuts = []
    why = {"audio": "no speech", "motion": "nothing moving", "both": "quiet and still"}[mode]
    for a, b in _runs(quiet):
        s, e = start + a * HOP, start + b * HOP
        if e - s >= min_quiet + 2 * margin:
            cuts.append((round(s + margin, 3), round(e - margin, 3), why))
    return cuts


# ── The subject ─────────────────────────────────────────────────────────────────────────────────────────────────


def _haar():
    try:
        import cv2  # noqa: PLC0415

        path = getattr(cv2.data, "haarcascades", "") + "haarcascade_frontalface_default.xml"
        c = cv2.CascadeClassifier(path)
        return (cv2, c) if not c.empty() else None
    except Exception:
        return None


def face_available():
    return _haar() is not None


def subject_track(path, start, end, mode="auto", fixed_x=0.5, step=0.5):
    """Where the subject is across the picture, as [(time, x)] with x from 0 (left) to 1, plus how it was found.

    face: the largest face (needs OpenCV; `auto` uses it when it is installed). motion: the centre of what moves between
    samples. center: the middle. fixed: `fixed_x`. Raw positions are smoothed in smooth_track()."""
    if mode == "fixed":
        return [(start, fixed_x), (end, fixed_x)], "fixed"
    if mode == "center":
        return [(start, 0.5), (end, 0.5)], "center"
    cv = _haar() if mode in ("auto", "face") else None
    if mode == "face" and cv is None:
        raise media.MediaError("Face tracking needs OpenCV 4 (pip install opencv-python-headless==4.*; version 5 dropped the face detector Hildegard uses). Use mode motion or center, or leave mode as auto.")
    pts = []
    prev = None
    used = "motion"
    for t, rgb in media.video_frames(path, step=step, start=start, end=end, size=(320, 180)):
        g = (rgb.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)).astype(np.uint8)
        x = None
        if cv is not None:
            faces = cv[1].detectMultiScale(g, scaleFactor=1.15, minNeighbors=5, minSize=(24, 24))
            if len(faces):
                fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
                x = (fx + fw / 2) / g.shape[1]
                used = "face"
        if x is None and prev is not None:
            d = np.abs(g.astype(np.float32) - prev)
            m = d > 24
            if m.mean() > 0.002:
                cols = m.sum(axis=0).astype(np.float64)
                x = float((cols * np.arange(len(cols))).sum() / cols.sum() / len(cols))
        prev = g.astype(np.float32)
        pts.append((t, x))
    if not any(x is not None for _, x in pts):
        return [(start, 0.5), (end, 0.5)], "center"
    return pts, used


def smooth_track(points, crop_frac, smooth=0.8):
    """Raw (time, x|None) → steady crop-centre keyframes [(time, x)].

    Gaps take the last known place; a median of three removes a single bad sample; the crop then holds still until the
    subject drifts outside the middle quarter of it, and moves no faster than a third of the frame a second, so it pans
    like a person would, never jitters. `crop_frac` is the crop's width as a fraction of the frame."""
    if not points:
        return [(0.0, 0.5)]
    last = next((x for _, x in points if x is not None), 0.5)
    filled = []
    for t, x in points:
        last = x if x is not None else last
        filled.append((t, last))
    xs = np.array([x for _, x in filled])
    if len(xs) >= 3:
        med = xs.copy()
        for i in range(1, len(xs) - 1):
            med[i] = np.median(xs[i - 1 : i + 2])
        xs = med
    dead = crop_frac * 0.25 * (0.5 + smooth)
    vmax = 0.33
    cur = float(xs[0])
    out = [(filled[0][0], _clamp(cur, crop_frac))]
    for i in range(1, len(xs)):
        dt = max(1e-3, filled[i][0] - filled[i - 1][0])
        want = float(xs[i])
        if abs(want - cur) > dead:
            target = want - np.sign(want - cur) * dead * 0.5
            step = np.clip(target - cur, -vmax * dt, vmax * dt)
            cur += float(step)
        out.append((filled[i][0], _clamp(cur, crop_frac)))
    return out


def _clamp(x, crop_frac):
    half = crop_frac / 2
    return float(min(1 - half, max(half, x)))
