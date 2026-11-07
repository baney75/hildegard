# SPDX-License-Identifier: AGPL-3.0-only
"""Makes one platform's version of a finished film or image: its shape, size, length, loudness, thumbnail and, if asked,
a line of on-screen text kept inside the platform's safe area.

    python export_post.py SPEC.json

SPEC is {"kind": "video" | "image", "input": path, "out": path, "thumbnail": path | null, "title": str,
"comment": str, "fit": "blur" | "crop", "text": str | null, "lufs": -14, "true_peak": -1, "target": {...}}, where
target is the platform's entry from packages/presets/src/post.ts: width, height, maxSeconds (or null), maxBytes,
videoKbps, maxFps, safeArea {top, bottom, left, right}, thumbnail {width, height, maxBytes}.

A picture of another shape is fitted whole over a soft, darkened copy of itself (`blur`, the default) or fills the
frame and loses its edges (`crop`); it is never stretched. Video is H.264 (High, BT.709, yuv420p) with AAC at 48 kHz;
a film with no sound gets a silent track, and one with sound is set to `lufs` and `true_peak` like export_film.py's
mix. A film longer than maxSeconds is cut there. The result stays under maxBytes by lowering the bit rate.

Prints one JSON line per stage and a last line {"ok": true, "width", "height", "seconds", "bytes", "fps", "lufs",
"true_peak", "trimmed", "text_box", "source_seconds"} or {"ok": false, "error": msg}. Uses PyAV, numpy and Pillow,
which ComfyUI already installs.
"""

import json
import math
import os
import sys
from fractions import Fraction

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# `python -I` leaves the script's folder off the path; the loudness code lives next to this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voice_clean  # noqa: E402
from export_film import RATE, Audio  # noqa: E402

AUDIO_KBPS = 192
# AAC moves peaks by a few tenths of a dB, so the mix is set that much under the ceiling before it is encoded.
MARGIN = 0.4
BT709 = 1


def say(**kw):
    print(json.dumps(kw), flush=True)


# ── Fitting a picture to a frame ────────────────────────────────────────────────────────────────────────────────


def fitted_size(w, h, W, H):
    """The size of w×h scaled to sit inside W×H, even in both directions."""
    scale = min(W / w, H / h)
    return max(2, round(w * scale) // 2 * 2), max(2, round(h * scale) // 2 * 2)


def compose(frame, W, H, fit):
    """A VideoFrame as (H, W, 3) uint8 RGB in the target's shape. The same aspect is only scaled."""
    w, h = frame.width, frame.height
    if abs(w / h - W / H) < 0.01:
        return frame.reformat(width=W, height=H, format="rgb24").to_ndarray()
    if fit == "crop":
        scale = max(W / w, H / h)
        sw, sh = math.ceil(w * scale), math.ceil(h * scale)
        big = frame.reformat(width=sw, height=sh, format="rgb24").to_ndarray()
        x, y = (sw - W) // 2, (sh - H) // 2
        return np.ascontiguousarray(big[y : y + H, x : x + W])
    fw, fh = fitted_size(w, h, W, H)
    fg = frame.reformat(width=fw, height=fh, format="rgb24").to_ndarray()
    # The backdrop: the picture shrunk to a few dozen pixels and stretched back, which softens it past recognition.
    small = frame.reformat(width=max(2, W // 32), height=max(2, H // 32), format="rgb24").to_ndarray() >> 1
    bg = av.VideoFrame.from_ndarray(np.ascontiguousarray(small), format="rgb24")
    canvas = bg.reformat(width=W, height=H, format="rgb24").to_ndarray()
    x, y = (W - fw) // 2, (H - fh) // 2
    canvas[y : y + fh, x : x + fw] = fg
    return canvas


def to_yuv(rgb):
    """RGB to the frame the encoder takes, with the BT.709 matrix that HD players assume."""
    f = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
    return f.reformat(format="yuv420p", dst_colorspace=av.video.reformatter.Colorspace.ITU709)


# ── On-screen text inside the safe area ─────────────────────────────────────────────────────────────────────────


def wrap(draw, words, font, width):
    lines, cur = [], ""
    for word in words:
        trial = f"{cur} {word}".strip()
        if draw.textlength(trial, font=font) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def make_text(text, W, H, safe):
    """(rgba patch, x, y) for a line of text in a dark plate at the bottom of the safe area, or None.

    The plate, padding included, lies inside the safe area. The type shrinks, then the words are cut, until it fits."""
    left, right, top, bottom = safe["left"], safe["right"], safe["top"], safe["bottom"]
    area_w, area_h = W - left - right, H - top - bottom
    if area_w < 100 or area_h < 60 or not text.strip():
        return None
    draw = ImageDraw.Draw(Image.new("RGBA", (4, 4)))
    words = text.split()
    size = max(18, round(W * 0.05))
    pad = max(10, size // 2)
    while True:
        font = ImageFont.load_default(size=size)
        lines = wrap(draw, words, font, area_w - 2 * pad)
        line_h = round(size * 1.25)
        height = len(lines) * line_h + 2 * pad
        if height <= area_h or size <= 18:
            break
        size = max(18, round(size * 0.9))
    # Still too tall at the smallest type: keep the lines that fit and end the last with an ellipsis.
    room = max(1, (area_h - 2 * pad) // line_h)
    if len(lines) > room:
        lines = lines[:room]
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > area_w - 2 * pad:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
        height = len(lines) * line_h + 2 * pad
    widest = max(draw.textlength(line, font=font) for line in lines)
    width = min(area_w, math.ceil(widest) + 2 * pad)
    patch = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(patch)
    d.rounded_rectangle((0, 0, width - 1, height - 1), radius=pad, fill=(0, 0, 0, 150))
    for i, line in enumerate(lines):
        tw = d.textlength(line, font=font)
        d.text(((width - tw) / 2, pad + i * line_h + (line_h - size) / 2), line, font=font, fill=(255, 255, 255, 255))
    x = left + (area_w - width) // 2
    y = H - bottom - height
    return np.asarray(patch), x, y


def burn(rgb, text_patch):
    if text_patch is None:
        return rgb
    patch, x, y = text_patch
    h, w = patch.shape[:2]
    a = patch[..., 3:4].astype(np.float32) / 255.0
    region = rgb[y : y + h, x : x + w].astype(np.float32)
    rgb[y : y + h, x : x + w] = (region * (1 - a) + patch[..., :3].astype(np.float32) * a).astype(np.uint8)
    return rgb


def save_jpeg(rgb, path, size, max_bytes, comment=""):
    """The picture as a JPEG at `size` (w, h), as sharp as the byte limit allows."""
    img = Image.fromarray(rgb)
    if img.size != size:
        img = img.resize(size, Image.LANCZOS)
    exif = Image.Exif()
    if comment:
        exif[0x010E] = comment
    for q in (92, 88, 84, 78, 70, 60, 50, 40):
        img.save(path, "JPEG", quality=q, optimize=True, progressive=True, exif=exif)
        if os.path.getsize(path) <= max_bytes:
            return os.path.getsize(path)
    raise ValueError("The thumbnail won’t fit in the platform’s size limit.")


# ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────────────


def export_image(spec):
    t = spec["target"]
    W, H = t["width"], t["height"]
    img = Image.open(spec["input"])
    img.load()
    rgb = np.asarray(img.convert("RGB"))
    frame = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24")
    out = compose(frame, W, H, spec.get("fit", "blur"))
    text = make_text(spec["text"], W, H, t["safeArea"]) if spec.get("text") else None
    out = burn(out, text)
    size = save_jpeg(out, spec["out"], (W, H), t["maxBytes"], spec.get("comment", ""))
    say(
        ok=True, width=W, height=H, seconds=None, bytes=size, fps=None, lufs=None, true_peak=None, trimmed=False,
        text_box=box_of(text), source_seconds=None,
    )


def box_of(text):
    if text is None:
        return None
    patch, x, y = text
    return [x, y, x + patch.shape[1], y + patch.shape[0]]


# ── Film ────────────────────────────────────────────────────────────────────────────────────────────────────────


def probe(path):
    with av.open(path) as c:
        v = c.streams.video[0]
        rate = Fraction(v.average_rate or v.guessed_rate or 24)
        if c.duration:
            seconds = c.duration / 1_000_000
        elif v.duration and v.time_base:
            seconds = float(v.duration * v.time_base)
        else:
            seconds = (v.frames or 0) / float(rate)
        return v.codec_context.width, v.codec_context.height, rate, seconds, bool(c.streams.audio)


def source_audio(path, seconds, lufs, peak):
    """The film's sound as (2, samples) at RATE, cut or padded to `seconds` and leveled; (sound, lufs, true_peak).

    A film with no sound, or none above the noise floor, gets silence and no loudness."""
    n = round(seconds * RATE)
    silent = np.zeros((2, n), dtype=np.float32)
    try:
        x = voice_clean.decode(path, 2)
    except voice_clean.CleanError:
        return silent, None, None
    x = x[:, :n]
    if x.shape[1] < n:
        x = np.concatenate([x, np.zeros((2, n - x.shape[1]), dtype=np.float32)], axis=1)
    if not np.any(np.abs(x) > 1e-4):
        return silent, None, None
    try:
        y, got, tp = voice_clean.normalize(voice_clean.choose_backend(), x, lufs, peak - MARGIN)
    except voice_clean.CleanError:
        return silent, None, None
    return y.astype(np.float32, copy=False), got, tp


def export_video(spec):
    t = spec["target"]
    w, h, src_fps, duration, _ = probe(spec["input"])
    fps = src_fps if src_fps <= t["maxFps"] else Fraction(t["maxFps"])
    limit = t.get("maxSeconds")
    cap = min(duration, limit) if limit else duration
    max_frames = max(1, int(cap * fps + 1e-6))
    # The video bit rate: the target's, or less when the file would pass its size limit. The encoder overshoots a
    # little on short films, so a file that still comes out over is made again at a lower rate.
    seconds_est = max(0.5, max_frames / float(fps))
    kbps = int(max(150, min(t["videoKbps"], (t["maxBytes"] * 8 * 0.9) / seconds_est / 1000 - AUDIO_KBPS)))
    for attempt in range(4):
        made = encode_video(spec, kbps, fps, max_frames, duration, limit)
        if made["bytes"] <= t["maxBytes"]:
            say(ok=True, **made)
            return
        kbps = max(100, int(kbps * t["maxBytes"] / made["bytes"] * 0.8))
        say(stage="again")
    os.remove(spec["out"])
    raise ValueError("The film is too large for this platform even at the lowest quality Hildegard uses.")


def encode_video(spec, kbps, fps, max_frames, duration, limit):
    t = spec["target"]
    W, H = t["width"], t["height"]
    fit = spec.get("fit", "blur")
    src, out = spec["input"], spec["out"]
    trimmed = bool(limit) and duration > limit + 0.05
    text = make_text(spec["text"], W, H, t["safeArea"]) if spec.get("text") else None

    tmp = out + ".part"
    total = 0
    still = None
    still_at = max(0, int(max_frames * 0.25))
    tb = Fraction(1, 1) / fps
    src_fps = probe(src)[2]
    with av.open(tmp, "w", format="mp4", options={"movflags": "+faststart"}) as dst:
        dst.metadata["title"] = spec.get("title", "")
        dst.metadata["comment"] = spec.get("comment", "")
        vs = dst.add_stream("libx264", rate=fps)
        vs.width, vs.height, vs.pix_fmt = W, H, "yuv420p"
        vs.time_base = tb
        vs.options = {
            "crf": "20",
            "preset": "medium",
            "profile": "high",
            "maxrate": f"{kbps}k",
            "bufsize": f"{kbps}k",
            "g": str(max(12, round(float(fps) * 2))),
            "colorspace": "bt709",
            "color_primaries": "bt709",
            "color_trc": "bt709",
        }
        aus = dst.add_stream("aac", rate=RATE, layout="stereo")
        aus.time_base = Fraction(1, RATE)
        aus.bit_rate = AUDIO_KBPS * 1000

        say(stage="video")
        done = False
        with av.open(src) as c:
            stream = c.streams.video[0]
            take = 0
            for j, frame in enumerate(c.decode(stream)):
                while take / fps < (j + 1) / src_fps:
                    if total >= max_frames:
                        done = True
                        break
                    rgb = compose(frame, W, H, fit)
                    if still is None and total >= still_at:
                        still = rgb.copy()
                    img = to_yuv(burn(rgb, text))
                    img.pts = total
                    img.time_base = tb
                    total += 1
                    take += 1
                    for p in vs.encode(img):
                        dst.mux(p)
                if done:
                    break
        for p in vs.encode():
            dst.mux(p)

        seconds = total / float(fps)
        say(stage="sound")
        sound, lufs, tp = source_audio(src, seconds, spec.get("lufs", -14.0), spec.get("true_peak", -1.0))
        audio = Audio(dst, aus)
        for i in range(0, sound.shape[1], 4096):
            audio.send(sound[:, i : i + 4096])
        audio.close()
    os.replace(tmp, out)
    if total == 0:
        raise ValueError("The film has no frames.")

    thumb = spec.get("thumbnail")
    if thumb and still is not None:
        # The thumbnail is the picture without any text over it, at the size the platform asks for.
        tt = t["thumbnail"]
        save_jpeg(still, thumb, (tt["width"], tt["height"]), tt["maxBytes"], spec.get("comment", ""))
    return dict(
        width=W, height=H, seconds=round(seconds, 3), bytes=os.path.getsize(out), fps=float(fps), lufs=lufs,
        true_peak=tp, trimmed=trimmed, text_box=box_of(text), source_seconds=round(duration, 3),
    )


def main(spec_path):
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    if spec["target"]["width"] % 2 or spec["target"]["height"] % 2:
        raise ValueError("The size has to be even.")
    if spec["kind"] == "image":
        export_image(spec)
    else:
        export_video(spec)


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as e:  # The server shows this to the person, so keep it to one plain line.
        say(ok=False, error=str(e) or type(e).__name__)
        sys.exit(1)
