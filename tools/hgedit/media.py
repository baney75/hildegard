# SPDX-License-Identifier: AGPL-3.0-only
"""Reading media with PyAV: what a file holds, and its sound as float samples."""

import hashlib
import os
from fractions import Fraction

import av
import numpy as np

RATE = 48000


class MediaError(Exception):
    """A plain one-line reason, shown to the person as it is."""


def probe(path):
    """{path, seconds, fps, width, height, audio, audio_tracks, rotation} for a media file. Raises MediaError."""
    if not os.path.isfile(path):
        raise MediaError(f"There is no file at {path}.")
    try:
        with av.open(path) as c:
            v = c.streams.video[0] if c.streams.video else None
            seconds = 0.0
            if c.duration:
                seconds = c.duration / av.time_base
            elif v is not None and v.duration:
                seconds = float(v.duration * v.time_base)
            fps = None
            width = height = 0
            if v is not None:
                rate = v.average_rate or v.guessed_rate or v.base_rate
                fps = float(rate) if rate else 30.0
                width, height = v.codec_context.width, v.codec_context.height
            if not seconds:
                # Some containers carry no duration; the last packet's end is the length.
                for p in c.demux():
                    if p.pts is None or p.stream.time_base is None:
                        continue
                    seconds = max(seconds, float((p.pts + (p.duration or 0)) * p.stream.time_base))
            return {
                "path": path,
                "seconds": round(seconds, 3),
                "fps": fps,
                "width": width,
                "height": height,
                "video": v is not None,
                "audio": bool(c.streams.audio),
                "audio_tracks": len(c.streams.audio),
            }
    except av.error.FFmpegError as e:
        raise MediaError(f"Hildegard couldn’t read {os.path.basename(path)} as video or sound.") from e


def layout_of(channels):
    return {1: "mono", 2: "stereo"}.get(channels) or f"{channels}c"


def read_audio(path, ranges=None, track=0, channels=2, rate=RATE):
    """The sound of `path` (audio stream `track`) as float32 (channels, samples) at `rate` (48 kHz unless told).

    `ranges` is a list of (start_seconds, end_seconds); the result is those stretches joined in the order given, each
    exactly round((end - start) * rate) samples long (padded with silence where the file has less). Without
    `ranges`, the whole stream. The file is read once, whatever the ranges."""
    with av.open(path) as c:
        if len(c.streams.audio) <= track:
            if ranges is None:
                return np.zeros((channels, 0), dtype=np.float32)
            n = sum(round((b - a) * rate) for a, b in ranges)
            return np.zeros((channels, n), dtype=np.float32)
        s = c.streams.audio[track]
        rs = av.AudioResampler(format="fltp", layout=layout_of(channels), rate=rate)
        pieces = []  # (start_sample_in_file, array)
        pos = 0
        want_end = None if ranges is None else max(b for _, b in ranges) + 1.0
        first = None

        def take(frame):
            nonlocal pos, first
            if frame.pts is not None and first is None:
                first = float(frame.pts * frame.time_base)
            for f in rs.resample(frame):
                a = f.to_ndarray()
                pieces.append((pos, a))
                pos += a.shape[1]

        for frame in c.decode(s):
            take(frame)
            if want_end is not None and pos / rate > want_end:
                break
        for f in rs.resample(None):
            a = f.to_ndarray()
            pieces.append((pos, a))
            pos += a.shape[1]
    # A stream that starts after zero (a late first packet) is padded so file time stays file time.
    lead = int(round((first or 0.0) * rate)) if first and first > 0.001 else 0
    whole = np.concatenate([p[1] for p in pieces], axis=1) if pieces else np.zeros((channels, 0), dtype=np.float32)
    if lead:
        whole = np.concatenate([np.zeros((channels, lead), dtype=np.float32), whole], axis=1)
    whole = whole.astype(np.float32, copy=False)
    if ranges is None:
        return whole
    out = []
    for a, b in ranges:
        i, n = int(round(a * rate)), int(round((b - a) * rate))
        seg = whole[:, i : i + n]
        if seg.shape[1] < n:
            seg = np.concatenate([seg, np.zeros((channels, n - seg.shape[1]), dtype=np.float32)], axis=1)
        out.append(seg)
    return np.concatenate(out, axis=1) if out else np.zeros((channels, 0), dtype=np.float32)


def file_sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def video_frames(path, step=None, start=0.0, end=None, size=None, pick=None):
    """Yields (time_seconds, rgb ndarray) for a file's picture. With `step`, about one frame every `step` seconds; with
    `pick`, only the frames whose time it returns True for (asked in order, before a frame is converted)."""
    with av.open(path) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        if start > 0.05:
            c.seek(int(start / v.time_base), stream=v, backward=True)
        nxt = start
        for frame in c.decode(v):
            if frame.pts is None:
                continue
            t = float(frame.pts * v.time_base)
            if t + 1e-6 < start:
                continue
            if end is not None and t > end:
                return
            if step is not None and t + 1e-6 < nxt:
                continue
            if step is not None:
                nxt = max(nxt + step, t + step * 0.5)
            if pick is not None and not pick(t):
                continue
            kw = {"format": "rgb24"}
            if size:
                kw.update(width=size[0], height=size[1])
            yield t, frame.to_ndarray(**kw)


def frac(x):
    return Fraction(x).limit_denominator(100000)
