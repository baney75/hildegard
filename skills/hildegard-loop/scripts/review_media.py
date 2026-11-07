# SPDX-License-Identifier: AGPL-3.0-only
"""Checks a video, image or sound file for the technical marks of slop, and draws a contact sheet to look at.

    python review_media.py SPEC.json

SPEC is {"path": str, "sheet": str or null, "final": bool, "seconds": number or null, "audio": bool or null,
"film": bool}. Prints one JSON object: {"ok": true, "kind": "video"|"image"|"audio", "info": {...}, "checks": [...]},
where each check is {"id", "status": "pass"|"warn"|"fail", "value", "limit", "detail"}; or {"ok": false, "error": msg}.

These are the checks a machine can make honestly: exposure, frozen and flickering frames, colour pushed past what a
camera records, sound that clips or is far too loud or quiet. They say nothing about whether the work is good; the
contact sheet is for the person or agent who judges that. Uses PyAV, numpy and Pillow, which ComfyUI already installs.
"""

import json
import math
import sys

import av
import numpy as np
from PIL import Image, ImageDraw

SAMPLES = 240  # frames analysed at most, spread evenly
SMALL = 160  # analysis width in pixels
SHEET_COLS, SHEET_ROWS, SHEET_W = 3, 3, 400
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")
AUDIO_EXT = (".wav", ".flac", ".mp3", ".ogg", ".m4a", ".aac", ".opus")


def check(cid, status, value, limit, detail):
    return {"id": cid, "status": status, "value": value, "limit": limit, "detail": detail}


def luma(rgb):
    """Rec. 709 luma of an RGB array in 0..1."""
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def saturation(rgb):
    mx, mn = rgb.max(axis=-1), rgb.min(axis=-1)
    return np.where(mx > 0.02, (mx - mn) / np.maximum(mx, 1e-6), 0.0)


def picture_checks(frames, final):
    """Checks on still pictures: exposure, contrast and colour. `frames` is a list of HxWx3 arrays in 0..1."""
    out = []
    lum = [luma(f) for f in frames]
    blown = float(np.mean([np.mean(l > 0.98) > 0.25 for l in lum]))
    crushed = float(np.mean([np.mean(l < 0.01) > 0.35 for l in lum]))
    spread = float(np.median([np.std(l) for l in lum]))
    sat = np.concatenate([saturation(f).ravel() for f in frames])
    mean_sat, hot = float(np.mean(sat)), float(np.mean(sat > 0.9))

    out.append(
        check("highlights", "fail" if blown > 0.1 else "pass", round(blown, 3), 0.1,
              "Share of frames where a quarter of the picture is pure white. Blown highlights read as cheap; "
              "lower the exposure or the light, or choose another take.")
    )
    out.append(
        check("shadows", "warn" if crushed > 0.1 else "pass", round(crushed, 3), 0.1,
              "Share of frames where over a third is pure black. Fine for a night scene you meant; otherwise detail "
              "is lost.")
    )
    out.append(
        check("contrast", "warn" if spread < 0.06 else "pass", round(spread, 3), 0.06,
              "Spread of brightness. Very low means a flat, washed-out picture with nothing to look at first.")
    )
    pushed = mean_sat > 0.62 or hot > 0.2
    out.append(
        check("colour", ("fail" if final else "warn") if pushed else "pass",
              {"mean": round(mean_sat, 3), "over_90": round(hot, 3)}, {"mean": 0.62, "over_90": 0.2},
              "How hard colour is pushed. Past the limit is the oversaturated, glowing look that marks generated "
              "work; ask for a natural palette or grade it down.")
    )
    return out


def sample_indices(n, k):
    if n <= k:
        return list(range(n))
    return sorted({round(i * (n - 1) / (k - 1)) for i in range(k)})


def read_video(path):
    with av.open(path) as c:
        if not c.streams.video:
            raise ValueError("There is no picture in this file.")
        v = c.streams.video[0]
        rate = float(v.average_rate or v.guessed_rate or 24)
        w, h = v.codec_context.width, v.codec_context.height
        sw = SMALL
        sh = max(2, round(h * SMALL / w / 2) * 2)
        all_small = []
        for frame in c.decode(v):
            # Small and 8-bit, so a long film stays a few hundred megabytes at most.
            all_small.append(frame.to_ndarray(format="rgb24", width=sw, height=sh))
        has_audio = bool(c.streams.audio)
    if not all_small:
        raise ValueError("The video has no frames.")
    return {"rate": rate, "width": w, "height": h, "small": all_small, "audio": has_audio}


def motion_checks(small, rate, film):
    out = []
    n = len(small)
    lum = np.array([float(np.mean(luma(f.astype(np.float32) / 255.0))) for f in small])
    diffs = np.array(
        [float(np.mean(np.abs(small[i].astype(np.int16) - small[i - 1]))) / 255.0 for i in range(1, n)]
    )

    # Black frames, past a half-second fade at either end.
    edge = int(rate * 0.5)
    middle = lum[edge : n - edge] if n > 2 * edge + 1 else lum
    black = float(np.mean(middle < 0.04))
    out.append(
        check("black_frames", "fail" if black > 0.1 else "pass", round(black, 3), 0.1,
              "Share of frames that are black, past the first and last half second. A render that failed or a "
              "shot with nothing in it.")
    )

    # The longest stretch where nothing moves: a still image passed off as video.
    longest = run = 0
    for d in diffs:
        run = run + 1 if d < 0.0025 else 0
        longest = max(longest, run)
    frozen = round(longest / rate, 2)
    seconds = n / rate
    out.append(
        check("frozen", "warn" if seconds >= 3 and frozen > 1.0 else "pass", frozen, 1.0,
              "Longest stretch, in seconds, where no pixel moves. Generated video often stalls; if stillness is the "
              "point, say so in the brief.")
    )

    # Flicker: brightness that jumps back and forth from frame to frame, not a cut or a slow change.
    if n >= 5:
        second = np.abs(lum[1:-1] - (lum[:-2] + lum[2:]) / 2)
        # A film has cuts; each is one spike, so look at a higher percentile for a single shot than for a film.
        flick = float(np.percentile(second, 90 if film else 95))
        out.append(
            check("flicker", "fail" if flick > 0.03 else "warn" if flick > 0.015 else "pass", round(flick, 4),
                  0.015, "How much brightness jumps frame to frame. Flicker is the tell of unstable generation; "
                  "try another seed, fewer steps of motion, or a steadier light in the prompt.")
        )
    return out


def k_weight_power(freqs):
    """|H(f)|^2 of the BS.1770 K-weighting filter (shelf then high-pass) at 48 kHz."""
    z = np.exp(1j * 2 * np.pi * freqs / 48000.0)
    shelf_b, shelf_a = (1.53512485958697, -2.69169618940638, 1.19839281085285), (1.0, -1.69065929318241, 0.73248077421585)
    hp_b, hp_a = (1.0, -2.0, 1.0), (1.0, -1.99004745483398, 0.99007225036621)

    def resp(b, a):
        return (b[0] + b[1] / z + b[2] / z**2) / (a[0] + a[1] / z + a[2] / z**2)

    return np.abs(resp(shelf_b, shelf_a) * resp(hp_b, hp_a)) ** 2


def read_audio(path, limit_seconds=900):
    """Planar float samples at 48 kHz, at most `limit_seconds` of them; None when there is no sound."""
    with av.open(path) as c:
        if not c.streams.audio:
            return None
        s = c.streams.audio[0]
        channels = s.codec_context.channels or 2
        layout = "stereo" if channels >= 2 else "mono"
        res = av.AudioResampler(format="fltp", layout=layout, rate=48000)
        chunks, total = [], 0
        for frame in c.decode(s):
            for f in res.resample(frame):
                a = f.to_ndarray()
                chunks.append(a)
                total += a.shape[1]
            if total > limit_seconds * 48000:
                break
        for f in res.resample(None):
            chunks.append(f.to_ndarray())
    if not chunks:
        return None
    return np.concatenate(chunks, axis=1).astype(np.float64)


def loudness(samples):
    """Integrated loudness in LUFS (BS.1770-4 gating), with K-weighting applied in the frequency domain per 100 ms."""
    step = 4800
    n = samples.shape[1] // step
    if n < 4:
        return None
    blocks = samples[:, : n * step].reshape(samples.shape[0], n, step)
    spec = np.abs(np.fft.rfft(blocks, axis=-1)) ** 2
    weight = k_weight_power(np.fft.rfftfreq(step, 1 / 48000.0))
    # Parseval: mean square of the filtered block from its spectrum.
    power = (spec * weight).sum(axis=-1) * 2 / step**2
    power = power.sum(axis=0)  # channels add (left and right weigh 1)
    gates = np.array([power[i : i + 4].mean() for i in range(n - 3)])  # 400 ms, 75% overlap
    with np.errstate(divide="ignore"):
        lk = -0.691 + 10 * np.log10(np.maximum(gates, 1e-12))
    keep = gates[lk > -70]
    if keep.size == 0:
        return None
    rel = -0.691 + 10 * math.log10(keep.mean()) - 10
    keep2 = gates[(lk > -70) & (lk > rel)]
    if keep2.size == 0:
        return None
    return round(-0.691 + 10 * math.log10(keep2.mean()), 1)


def audio_checks(samples, expect_audio):
    if samples is None:
        if expect_audio:
            return [check("sound", "fail", None, None, "The brief asked for sound and there is none.")]
        return [check("sound", "pass", None, None, "No sound track, and none was asked for.")]
    out = []
    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    clipped = float(np.mean(np.abs(samples) >= 0.999)) if samples.size else 0.0
    peak_db = round(20 * math.log10(peak), 1) if peak > 0 else None
    if peak_db is None or peak_db < -60:
        out.append(check("sound", "fail" if expect_audio else "warn", peak_db, -60,
                         "The sound track is silent. Drop it or put sound in it."))
        return out
    # Lossy codecs round off clipped tops, so a clipped master decodes as a few samples at full scale and peaks past
    # it; a clean master at -1 dBTP has none.
    over = peak > 1.0 or clipped > 0.0001
    out.append(check("clipping", "fail" if over else "pass", {"share": round(clipped, 5), "peak_db": peak_db},
                     {"share": 0.0001, "peak_db": 0.0},
                     "Samples at or past full scale. Clipping crackles; lower the level before the limiter and keep "
                     "peaks under -1 dB."))
    lufs = loudness(samples)
    if lufs is not None:
        status = "fail" if lufs > -9 or lufs < -30 else "warn" if lufs > -12 or lufs < -18 else "pass"
        out.append(check("loudness", status, lufs, [-18, -12],
                         "Integrated loudness in LUFS. About -14 suits the web and phones; much louder is "
                         "squashed and tiring, much quieter gets turned up with its noise."))
    return out


def draw_sheet(path, out, times):
    """A 3x3 grid of frames spread through the video, each marked with its time."""
    want = sample_indices(len(times), SHEET_COLS * SHEET_ROWS) if times else []
    picks = [times[i] for i in want]
    tiles = []
    with av.open(path) as c:
        v = c.streams.video[0]
        targets = list(picks)
        for frame in c.decode(v):
            t = float(frame.time or 0)
            if targets and t + 1e-6 >= targets[0]:
                tiles.append((t, frame.to_image()))
                targets.pop(0)
                if not targets:
                    break
    if not tiles:
        return False
    tw = SHEET_W
    th = round(tiles[0][1].height * tw / tiles[0][1].width)
    gap = 4
    sheet = Image.new("RGB", (SHEET_COLS * (tw + gap) - gap, SHEET_ROWS * (th + gap) - gap), (16, 16, 16))
    draw = ImageDraw.Draw(sheet)
    for i, (t, img) in enumerate(tiles):
        x, y = (i % SHEET_COLS) * (tw + gap), (i // SHEET_COLS) * (th + gap)
        sheet.paste(img.resize((tw, th)), (x, y))
        label = f"{t:0.2f}s"
        draw.rectangle([x + 4, y + 4, x + 8 + 7 * len(label), y + 20], fill=(0, 0, 0))
        draw.text((x + 6, y + 6), label, fill=(240, 240, 240))
    sheet.save(out, "JPEG", quality=85, optimize=True)
    return True


def review(spec):
    path = spec["path"]
    final, film = bool(spec.get("final")), bool(spec.get("film"))
    lower = path.lower()
    if lower.endswith(IMAGE_EXT):
        img = Image.open(path).convert("RGB")
        w, h = img.size
        small = np.asarray(img.resize((SMALL, max(2, round(h * SMALL / w)))), dtype=np.float32) / 255.0
        checks = []
        need = 1024 if final else 512
        checks.append(check("size", "fail" if min(w, h) < need else "pass", min(w, h), need,
                            "The short side in pixels. Smaller looks soft anywhere it is shown large."))
        checks += picture_checks([small], final)
        if spec.get("sheet"):
            img.thumbnail((1200, 1200))
            img.save(spec["sheet"], "JPEG", quality=85)
        return {"ok": True, "kind": "image", "info": {"width": w, "height": h}, "checks": checks}

    if lower.endswith(AUDIO_EXT):
        samples = read_audio(path)
        info = {"seconds": round(samples.shape[1] / 48000, 2) if samples is not None else 0}
        return {"ok": True, "kind": "audio", "info": info, "checks": audio_checks(samples, True)}

    v = read_video(path)
    n, rate = len(v["small"]), v["rate"]
    seconds = round(n / rate, 2)
    checks = []
    need = 720 if final else 320
    short = min(v["width"], v["height"])
    checks.append(check("size", "fail" if short < need else "pass", short, need,
                        "The short side in pixels. Final renders want 720 or more."))
    want = spec.get("seconds")
    if want:
        off = abs(seconds - want) / want
        checks.append(check("length", "warn" if off > 0.15 else "pass", seconds, want,
                            "Length in seconds against what the brief asked for."))
    picks = [v["small"][i].astype(np.float32) / 255.0 for i in sample_indices(n, SAMPLES)]
    checks += picture_checks(picks, final)
    checks += motion_checks(v["small"], rate, film)
    expect = spec.get("audio")
    checks += audio_checks(read_audio(path) if v["audio"] else None, bool(expect))
    info = {"width": v["width"], "height": v["height"], "fps": round(rate, 3), "frames": n, "seconds": seconds,
            "audio": v["audio"]}
    if spec.get("sheet"):
        times = [i / rate for i in range(n)]
        info["sheet"] = draw_sheet(path, spec["sheet"], times)
    return {"ok": True, "kind": "video", "info": info, "checks": checks}


def main(spec_path):
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    try:
        print(json.dumps(review(spec)))
    except Exception as e:  # noqa: BLE001 - every failure becomes one line the caller can show
        print(json.dumps({"ok": False, "error": str(e) or type(e).__name__}))
        sys.exit(1)


if __name__ == "__main__":
    main(sys.argv[1])
