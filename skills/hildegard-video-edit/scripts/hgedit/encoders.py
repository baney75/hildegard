# SPDX-License-Identifier: AGPL-3.0-only
"""Which H.264 encoder to use: a hardware one when this computer has one that works, else libx264.

Having an encoder compiled in is not having it work (no NVIDIA card, no driver, no VA device), so each hardware encoder
is tried on a few real frames before it is chosen. `HG_EDIT_ENCODER=libx264` (or --encoder) skips the search; tests set it
so they never wake a GPU."""

import os

import av
import numpy as np

HARDWARE = ("h264_nvenc", "h264_videotoolbox", "h264_qsv", "h264_vaapi")
_cache = {}


def options_for(name, bitrate_kbps=None, crf=18, preset="veryfast", gop=60):
    """Codec options for `name`. No B-frames anywhere: every group of frames is encoded on its own and joined by packets
    afterwards, and without B-frames each packet's decode time is its show time, so the joins can't reorder."""
    o = {"bf": "0", "g": str(gop)}
    if name == "libx264":
        o.update(crf=str(crf), preset=preset, x264opts="no-scenecut", pix_fmt="yuv420p")
    elif name == "h264_nvenc":
        o.update(preset="p4", rc="vbr", cq=str(crf + 3), **{"b:v": "0"})
        o["forced-idr"] = "1"
    elif name == "h264_videotoolbox":
        o.update(realtime="0", allow_sw="0")
        if bitrate_kbps:
            o["b:v"] = f"{bitrate_kbps}k"
    elif name == "h264_qsv":
        o.update(preset="medium", global_quality=str(crf + 4))
    elif name == "h264_vaapi":
        o.update(qp=str(crf + 4))
    return o


def _try(name):
    """True when `name` encodes a few frames on this computer."""
    if name not in av.codecs_available:
        return False
    try:
        with av.open(os.devnull, "w", format="null") as c:
            s = c.add_stream(name, rate=24)
            s.width, s.height, s.pix_fmt = 640, 360, "yuv420p"
            s.options = options_for(name, 2000)
            f = av.VideoFrame.from_ndarray(np.full((360, 640, 3), 90, np.uint8), format="rgb24").reformat(format="yuv420p")
            n = 0
            for i in range(6):
                f.pts = i
                n += len(s.encode(f))
            n += len(s.encode())
            return n > 0
    except Exception:
        return False


def choose(preferred=None, probe=_try):
    """(name, why). `preferred` or HG_EDIT_ENCODER wins when it works; 'auto' or nothing searches hardware first."""
    want = preferred or os.environ.get("HG_EDIT_ENCODER") or "auto"
    if want in _cache:
        return _cache[want]
    if want != "auto":
        if want == "libx264" or probe(want):
            res = (want, "chosen")
        else:
            res = ("libx264", f"{want} isn’t available on this computer, so libx264")
    else:
        res = ("libx264", "no hardware encoder worked")
        for name in HARDWARE:
            if probe(name):
                res = (name, "hardware")
                break
    _cache[want] = res
    return res
