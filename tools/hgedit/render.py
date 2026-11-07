# SPDX-License-Identifier: AGPL-3.0-only
"""Render a resolved edit list.

The picture is cut into groups of output frames. Each group is encoded on its own, in its own process (a group is
independent: it starts on a keyframe and has no B-frames), into a file named by a hash of everything that went into it, so a
restart skips the groups that are already done. The groups' packets are then joined, with the sound, in decode order
(dts-interleaved) into one MP4. The sound is built whole: cut the same way, cleaned, mixed with the music bed (ducked
under the voice), mastered to the target loudness, and kept a second time untouched as another audio track.
"""

import concurrent.futures
import hashlib
import heapq
import json
import multiprocessing
import os
import shutil
import subprocess
import sys
import tempfile
from fractions import Fraction

import av
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from . import VERSION, edl as edl_mod, encoders, media, plan as plan_mod, signals, textfx
from .media import RATE

try:  # the loudness chain lives next to the tools; a skill carries a copy beside these files
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import voice_clean
except ImportError:  # pragma: no cover
    voice_clean = None

LOSSY_MARGIN = 0.6  # AAC moves peaks by a few tenths of a dB; the mix is set this far under the ceiling
GROUP_MIN = 120  # frames


class RenderError(Exception):
    """A plain one-line reason, shown to the person as it is."""


def say(**kw):
    print(json.dumps(kw), flush=True)


# ── Decoding: output frame k of a segment → the source frame on screen then ─────────────────────────────────────


def source_frames(path, start_s, count, fps_out):
    """Yields `count` RGB frames, one per output frame, starting at source second `start_s`. The frame shown is the latest
    one at or before each output frame's time, so a source at another frame rate is repeated or dropped, never blended;
    past the last frame, the last one holds."""
    fps_out = Fraction(fps_out)
    with av.open(path) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"
        if start_s > 0.01:
            c.seek(int(max(0.0, start_s - 0.001) / v.time_base), stream=v, backward=True)
        it = (f for f in c.decode(v) if f.pts is not None)
        cur = None
        nxt = next(it, None)
        rgb = None
        for k in range(count):
            target = start_s + float(Fraction(k) / fps_out) + 1e-4
            moved = False
            while nxt is not None and float(nxt.pts * nxt.time_base) <= target:
                cur, nxt = nxt, next(it, None)
                moved = True
            if cur is None:
                cur, nxt, moved = nxt, next(it, None), True
            if cur is None:
                raise RenderError(f"{os.path.basename(path)} has no picture at {start_s:.2f} s.")
            if moved or rgb is None:
                rgb = cur.to_ndarray(format="rgb24")
            yield rgb


# ── Drawing a frame ─────────────────────────────────────────────────────────────────────────────────────────────


def _key_box(entry, t):
    """The hidden region's pixel box at source second t: fixed, or slid between keys."""
    if "keys" not in entry:
        return entry["box"]
    keys = entry["keys"]
    if t <= keys[0][0]:
        return keys[0][1]
    if t >= keys[-1][0]:
        return keys[-1][1]
    for (t0, b0), (t1, b1) in zip(keys, keys[1:]):
        if t0 <= t <= t1:
            u = (t - t0) / max(1e-9, t1 - t0)
            return [int(round(a + (b - a) * u)) for a, b in zip(b0, b1)]
    return keys[-1][1]


def hide(img, box, style):
    """Hide a region of an (H, W, 3) uint8 frame in place. Blur averages the region down to a few cells before blurring, so
    no text in it can be recovered from what is left."""
    x0, y0, x1, y1 = box
    if x1 <= x0 or y1 <= y0:
        return
    reg = img[y0:y1, x0:x1]
    h, w = reg.shape[:2]
    if style == "solid":
        reg[:] = (24, 24, 28)
        return
    im = Image.fromarray(reg)
    if style == "pixelate":
        cell = max(8, h // 3)
        small = im.resize((max(1, w // cell), max(1, h // cell)), Image.BOX)
        img[y0:y1, x0:x1] = np.asarray(small.resize((w, h), Image.NEAREST))
        return
    small = im.resize((max(1, w // 12), max(1, h // 12)), Image.BOX)
    big = small.resize((w, h), Image.BILINEAR).filter(ImageFilter.GaussianBlur(max(6, h * 0.35)))
    img[y0:y1, x0:x1] = np.asarray(big)


def outline(img, box, color, width, fill):
    x0, y0, x1, y1 = box
    c = np.array([int(color[i : i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)
    if fill > 0:
        reg = img[y0:y1, x0:x1].astype(np.float32)
        img[y0:y1, x0:x1] = (reg * (1 - fill) + c * fill).astype(np.uint8)
    im = Image.fromarray(img)
    ImageDraw.Draw(im).rectangle((x0, y0, x1 - 1, y1 - 1), outline=tuple(int(v) for v in c), width=max(1, width))
    img[:] = np.asarray(im)


class Composer:
    """Everything that happens to a frame between the source and the encoder."""

    def __init__(self, plan):
        self.p = plan
        self.fps = float(Fraction(plan["fps_num"], plan["fps_den"]))
        o = plan["output"]
        self.W, self.H = o["width"], o["height"]
        self.aspect = o["aspect"]
        self.fit = o["fit"]
        st = plan.get("caption_style", {})
        self.titles = [(t, textfx.layout_title(t["text"], t.get("subtitle"), t["kind"], self.W, self.H)) for t in plan["titles"]]
        self.cues = [(c, textfx.layout_caption(c["lines"], self.W, self.H, st.get("size"), st.get("position", "bottom"))) for c in plan["cues"]]

    def frame(self, rgb, seg, k, out_idx):
        sid = seg["source"]
        src = self.p["sources"][sid]
        sw, sh = src["width"], src["height"]
        t = (seg["src_frame"] + k) / self.fps
        frame_end = t + 1.0 / self.fps
        img = np.ascontiguousarray(rgb).copy()
        # Hidden first, on the source's own pixels, so a crop or scale can't undo it.
        for b in self.p["blur"]:
            if b["source"] == sid and t < b["end"] and frame_end > b["start"]:
                hide(img, _key_box(b, t), b["style"])
        for b in self.p["boxes"]:
            if b["source"] == sid and t < b["end"] and frame_end > b["start"]:
                scale = max(1.0, sh / 1080)
                outline(img, b["box"], b["color"], int(round(b["width"] * scale)), b["fill"])
        out = self.shape(img, sid, t, sw, sh)
        t_out = out_idx / self.fps
        for ti, ov in self.titles:
            if ti["start"] <= t_out < ti["end"]:
                textfx.blend(out, ov, textfx.fade(t_out, ti["start"], ti["end"]))
        for c, ov in self.cues:
            if c["start"] <= t_out < c["end"]:
                textfx.blend(out, ov, 1.0)
        return out

    def shape(self, img, sid, t, sw, sh):
        W, H = self.W, self.H
        if self.fit == "none" or (sw, sh) == (W, H) and self.fit != "pad":
            if (sw, sh) == (W, H):
                return img
            return np.asarray(Image.fromarray(img).resize((W, H), Image.LANCZOS if sw > W else Image.BICUBIC))
        sa = sw / sh
        if self.fit == "pad":
            im = Image.fromarray(img)
            bg = im.resize((max(2, W // 8), max(2, H // 8)), Image.BOX).resize((W, H), Image.BILINEAR).filter(ImageFilter.GaussianBlur(20))
            scale = min(W / sw, H / sh)
            fw, fh = max(2, round(sw * scale)), max(2, round(sh * scale))
            bg.paste(im.resize((fw, fh), Image.LANCZOS), ((W - fw) // 2, (H - fh) // 2))
            return np.asarray(bg)
        _, x0, y0, cw, ch = plan_mod.crop_geometry(self.p, sid, t)
        crop = Image.fromarray(img[y0 : y0 + ch, x0 : x0 + cw])
        return np.asarray(crop.resize((W, H), Image.LANCZOS if cw > W else Image.BICUBIC))


# ── One group of frames ─────────────────────────────────────────────────────────────────────────────────────────


def _colorspace_for(height):
    return "ITU709" if height >= 720 else "ITU601"


def render_group(job):
    """Encode output frames [f0, f1) to job['out'] (video only). Run in a worker process; returns job['out']."""
    plan = plan_mod.Plan(job["plan"])
    f0, f1 = job["f0"], job["f1"]
    comp = Composer(plan)
    fps = plan.fps
    name = job["encoder"]
    tmp = job["out"] + ".part"
    with av.open(tmp, "w", format="mp4") as dst:
        vs = dst.add_stream(name, rate=fps)
        vs.width, vs.height, vs.pix_fmt = comp.W, comp.H, "yuv420p"
        tb = Fraction(1, 1) / fps  # frames are numbered in 1/fps; the stream's own time base is not reliable until it is open
        vs.time_base = tb
        vs.options = encoders.options_for(name, plan["target"].get("bitrate_kbps"), job.get("crf", 18), job.get("preset", "veryfast"), max(1, round(float(fps) * 2)))
        cs = _colorspace_for(comp.H)
        for seg in plan["segments"]:
            a, b = seg["out_frame"], seg["out_frame"] + seg["frames"]
            lo, hi = max(a, f0), min(b, f1)
            if hi <= lo:
                continue
            k0 = lo - a
            src = plan["sources"][seg["source"]]
            gen = source_frames(src["path"], (seg["src_frame"] + k0) / float(fps), hi - lo, fps)
            for j, rgb in enumerate(gen):
                out = comp.frame(rgb, seg, k0 + j, lo + j)
                vf = av.VideoFrame.from_ndarray(out, format="rgb24").reformat(format="yuv420p", dst_colorspace=cs)
                vf.pts = lo + j - f0
                vf.time_base = tb
                for p in vs.encode(vf):
                    dst.mux(p)
        for p in vs.encode():
            dst.mux(p)
    os.replace(tmp, job["out"])
    with open(job["out"] + ".ok", "w") as f:
        f.write("ok")
    return job["out"]


def _group_key(plan, f0, f1, encoder, opts):
    """A hash of everything that goes into the frames [f0, f1), so a leftover file is reused only if it would be the same."""
    segs = [s for s in plan["segments"] if s["out_frame"] < f1 and s["out_frame"] + s["frames"] > f0]
    srcs = {}
    for s in segs:
        p = plan["sources"][s["source"]]["path"]
        st = os.stat(p)
        srcs[s["source"]] = [p, st.st_size, int(st.st_mtime)]
    blob = json.dumps({
        "v": VERSION, "f": [f0, f1], "segs": segs, "srcs": srcs, "enc": encoder, "opts": opts, "fps": [plan["fps_num"], plan["fps_den"]],
        "out": plan["output"], "reframe": plan["reframe"], "blur": plan["blur"], "boxes": plan["boxes"], "titles": plan["titles"],
        "cues": plan["cues"], "cs": plan.get("caption_style"),
    }, sort_keys=True, default=str)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


# ── The sound ───────────────────────────────────────────────────────────────────────────────────────────────────


def _speech_segments(voice, gap=0.6):
    """[(start, end)] seconds where the voice speaks, with gaps under `gap` closed, from the energy gate."""
    act = signals.activity(voice)
    segs = []
    for a, b in act["speech"]:
        if segs and a - segs[-1][1] < gap:
            segs[-1] = (segs[-1][0], b)
        else:
            segs.append((a, b))
    return segs, act


def duck_curve(n, segs, duck_db, rate=RATE):
    """Music gain per sample: 1, down by `duck_db` while the voice speaks. The sound skill's recipe: the music starts to
    drop 0.3 s before each stretch of speech and comes back over 0.5 s after it."""
    ctrl = 100
    t = (np.arange(int(n / rate * ctrl) + 2)) / ctrl
    g = 10 ** (-duck_db / 20)
    s = np.zeros_like(t)
    for a, b in segs:
        up = np.clip((t - (a - 0.3)) / 0.3, 0, 1)
        down = np.clip(((b + 0.5) - t) / 0.5, 0, 1)
        s += up * down
    gain = 1 - (1 - g) * np.minimum(1, s)
    return np.interp(np.arange(n) / rate, t, gain).astype(np.float32)


def fade_edges(x, n):
    if n <= 0 or x.shape[1] < 2 * n:
        return x
    ramp = np.linspace(0, 1, n, dtype=np.float32)
    x[:, :n] *= ramp
    x[:, -n:] *= ramp[::-1]
    return x


def cut_sound(plan, track=None):
    """The edit's sound, cut as the picture is: (2, audio_samples) float32 at 48 kHz, a short fade at every join."""
    fps = float(plan.fps)
    n_total = plan["audio_samples"]
    bounds = [round(s["out_frame"] / fps * RATE) for s in plan["segments"]] + [n_total]
    out = np.zeros((2, n_total), dtype=np.float32)
    fade = int(plan["audio"]["fade_ms"] / 1000 * RATE)
    by_src = {}
    for i, s in enumerate(plan["segments"]):
        by_src.setdefault(s["source"], []).append(i)
    for sid, idxs in by_src.items():
        info = plan["sources"][sid]
        if not info["audio"]:
            continue
        ranges = []
        for i in idxs:
            a = plan["segments"][i]["src_frame"] / fps
            ranges.append((a, a + (bounds[i + 1] - bounds[i]) / RATE))
        x = media.read_audio(info["path"], ranges, track=info["audio_track"], channels=2)
        pos = 0
        for i in idxs:
            n = bounds[i + 1] - bounds[i]
            out[:, bounds[i] : bounds[i + 1]] = fade_edges(x[:, pos : pos + n].copy(), fade)
            pos += n
    return out


def _backend():
    if voice_clean is None:
        raise RenderError("Mastering the sound needs voice_clean.py next to these tools.")
    try:
        return voice_clean.choose_backend()
    except voice_clean.CleanError as e:
        raise RenderError(str(e))


def build_audio(plan, stage=lambda s: None):
    """(master, original, info). master: (2, N) cleaned, mixed with the music and mastered; original: the cut sound untouched
    (or None); info: what was done and measured."""
    info = {"cleaned": False, "music": None, "lufs": None, "true_peak": None}
    n = plan["audio_samples"]
    if plan["audio"]["mute"]:
        return np.zeros((2, n), dtype=np.float32), None, dict(info, silent=True)
    stage("Cutting the sound")
    orig = cut_sound(plan)
    has_voice = bool(np.any(np.abs(orig) > 1e-4))
    voice = orig.copy()
    segs = []
    if has_voice:
        segs, act = _speech_segments(voice)
        frac = signals.speech_fraction(act, n / RATE)
        want = plan["audio"]["clean"]
        if want == "yes" or (want == "auto" and frac >= 0.15):
            stage("Cleaning the voice")
            be = _backend()
            voice = be.run(voice_clean.CHAIN, voice)
            info["cleaned"] = True
    mix = voice
    mu = plan.get("music")
    if mu:
        stage("Mixing the music")
        be = _backend()
        raw = media.read_audio(mu["path"], None, 0, 2)
        if raw.shape[1] < RATE:
            raise RenderError("The music file is empty.")
        a = int(round(mu.get("start", 0.0) * RATE))
        b = min(n, int(round(mu["end"] * RATE)) if "end" in mu else n)
        if b <= a:
            raise RenderError("The music starts after the video ends.")
        length = b - a
        reps = -(-length // raw.shape[1])
        bed = np.tile(raw, (1, reps))[:, :length].copy()
        fi, fo = int(mu.get("fade_in", 1.0) * RATE), int(mu.get("fade_out", 1.5) * RATE)
        if fi:
            bed[:, : min(fi, length)] *= np.linspace(0, 1, min(fi, length), dtype=np.float32)
        if fo:
            bed[:, -min(fo, length):] *= np.linspace(1, 0, min(fo, length), dtype=np.float32)
        duck = mu.get("duck_db", 16.0)
        under = mu.get("under_db", -8.0)
        if has_voice:
            vl, _ = voice_clean.measure(be, voice) if np.any(np.abs(voice) > 1e-3) else (-23.0, 0)
            ml, _ = voice_clean.measure(be, bed)
            gain_db = vl + under - ml
            curve = duck_curve(n, segs, duck)[a:b]
            bed *= np.float32(10 ** (gain_db / 20)) * curve
            info["music"] = {"duck_db": duck, "under_db": under, "speech_stretches": len(segs), "gain_db": round(gain_db, 2)}
        else:
            ml, _ = voice_clean.measure(be, bed)
            bed *= np.float32(10 ** ((-16.0 - ml) / 20))
            info["music"] = {"duck_db": 0, "speech_stretches": 0}
        mix = voice.copy()
        mix[:, a:b] += bed
    info["segments_of_speech"] = segs
    if plan["audio"]["master"] and np.any(np.abs(mix) > 1e-4):
        stage("Mastering")
        be = _backend()
        mix, lufs, tp = voice_clean.normalize(be, mix, plan["target"]["lufs"], plan["target"]["peak"] - LOSSY_MARGIN)
        info["lufs"], info["true_peak"] = lufs, tp
    return mix.astype(np.float32), orig if plan["audio"]["keep_original"] else None, info


def encode_aac(path, x, bitrate=192_000):
    """Write (2, N) float32 as AAC in an MP4 file."""
    with av.open(path, "w", format="mp4") as c:
        s = c.add_stream("aac", rate=RATE, layout="stereo")
        s.bit_rate = bitrate
        s.time_base = Fraction(1, RATE)
        size = s.codec_context.frame_size or 1024
        pts = 0
        n = x.shape[1]
        pad = (-n) % size  # whole frames only; the muxer trims the tail
        data = np.concatenate([x, np.zeros((2, pad), dtype=np.float32)], axis=1) if pad else x
        for i in range(0, data.shape[1], size):
            fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(data[:, i : i + size]), format="fltp", layout="stereo")
            fr.sample_rate = RATE
            fr.pts = pts
            fr.time_base = Fraction(1, RATE)
            pts += fr.samples
            for p in s.encode(fr):
                c.mux(p)
        for p in s.encode():
            c.mux(p)


# ── Joining ─────────────────────────────────────────────────────────────────────────────────────────────────────


def _video_packets(group_files, group_starts, fps):
    """Packets of every group, in order, timed on the whole video's clock in frames."""
    tb = Fraction(1, 1) / fps
    for path, f0 in zip(group_files, group_starts):
        with av.open(path) as c:
            vs = c.streams.video[0]
            for p in c.demux(vs):
                if p.pts is None or p.size == 0:
                    continue
                frames = int(round(float(p.pts * p.time_base) * float(fps)))
                p.time_base = tb
                p.pts = p.dts = f0 + frames
                p.duration = 1
                yield (float((f0 + frames) * tb), 0, p)


def _audio_packets(path, index):
    with av.open(path) as c:
        s = c.streams.audio[0]
        for p in c.demux(s):
            if p.pts is None or p.size == 0:
                continue
            yield (float(p.dts * p.time_base) if p.dts is not None else float(p.pts * p.time_base), index, p)


def join(out_path, group_files, group_starts, plan, audio_files, meta):
    """Mux video groups and audio tracks into out_path in dts order, faststart."""
    fps = plan.fps
    tmp = out_path + ".part"
    with av.open(group_files[0]) as g0:
        vtemplate = g0.streams.video[0]
        with av.open(tmp, "w", format="mp4", options={"movflags": "+faststart"}) as dst:
            for k, v in meta.items():
                dst.metadata[k] = v
            vout = dst.add_stream_from_template(vtemplate)
            vout.time_base = Fraction(1, 1) / fps
            try:
                cs = _colorspace_for(plan["output"]["height"])
                vout.codec_context.colorspace = 1 if cs == "ITU709" else 5
                vout.codec_context.color_primaries = 1 if cs == "ITU709" else 5
                vout.codec_context.color_trc = 1 if cs == "ITU709" else 6
            except Exception:
                pass
            aouts, handles = [], []
            for path in audio_files:
                h = av.open(path)
                handles.append(h)
                aouts.append(dst.add_stream_from_template(h.streams.audio[0]))
            streams = [vout] + aouts
            gens = [_video_packets(group_files, group_starts, fps)] + [_audio_packets(p, i + 1) for i, p in enumerate(audio_files)]
            for _, idx, p in heapq.merge(*gens, key=lambda t: (t[0], t[1])):
                p.stream = streams[idx]
                dst.mux(p)
            for h in handles:
                h.close()
    os.replace(tmp, out_path)


def embed_chapters(path, chapters, seconds):
    """Chapter marks into the MP4, when an ffmpeg is on PATH. Returns True when it did; the chapters.txt beside the file is
    written either way."""
    ff = shutil.which("ffmpeg")
    if not ff or not chapters:
        return False
    meta = [";FFMETADATA1"]
    for i, c in enumerate(chapters):
        end = chapters[i + 1]["at"] if i + 1 < len(chapters) else seconds
        title = c["title"].replace("\\", "\\\\").replace("=", "\\=").replace(";", "\\;").replace("#", "\\#").replace("\n", " ")
        meta += ["[CHAPTER]", "TIMEBASE=1/1000", f"START={int(c['at'] * 1000)}", f"END={max(int(end * 1000), int(c['at'] * 1000) + 1)}", f"title={title}"]
    d = tempfile.mkdtemp(prefix="hg-chap-")
    try:
        mf, tmp = os.path.join(d, "m.txt"), path + ".chap.mp4"
        with open(mf, "w", encoding="utf-8") as f:
            f.write("\n".join(meta) + "\n")
        r = subprocess.run([ff, "-hide_banner", "-loglevel", "error", "-y", "-i", path, "-i", mf, "-map", "0", "-map_metadata", "1", "-map_chapters", "1", "-c", "copy", "-movflags", "+faststart", tmp],
                           capture_output=True, text=True, timeout=300)
        if r.returncode == 0 and os.path.exists(tmp):
            os.replace(tmp, path)
            return True
        if os.path.exists(tmp):
            os.remove(tmp)
        return False
    finally:
        shutil.rmtree(d, ignore_errors=True)


def chapters_text(chapters):
    def stamp(t):
        t = int(t)
        return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60}:{t % 60:02d}"

    return "\n".join(f"{stamp(c['at'])} {c['title']}" for c in chapters) + "\n"


# ── The whole job ───────────────────────────────────────────────────────────────────────────────────────────────


def render(edl_path, out_path, workers=None, encoder=None, crf=18, keep_work=False, stage=lambda s: None, progress=lambda done, total: None):
    """Render the edit list at `edl_path` to `out_path`. Returns a result dict; raises RenderError or EdlError."""
    edl = edl_mod.load(edl_path)
    base = os.path.dirname(os.path.abspath(edl_path))
    stage("Reading the edit list")
    plan = plan_mod.resolve(edl, base)
    out_path = os.path.abspath(out_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    work = out_path + ".work"
    os.makedirs(work, exist_ok=True)
    name, why = encoders.choose(encoder)
    total = plan["out_frames"]
    workers = max(1, workers or min(os.cpu_count() or 1, 8))
    size = max(GROUP_MIN, -(-total // (workers * 3)))
    spans = [(a, min(total, a + size)) for a in range(0, total, size)]
    opts = encoders.options_for(name, plan["target"].get("bitrate_kbps"), crf)
    jobs, files, reused = [], [], 0
    for i, (a, b) in enumerate(spans):
        key = _group_key(plan, a, b, name, opts)
        f = os.path.join(work, f"g{i:04d}-{key}.mp4")
        files.append(f)
        if os.path.exists(f) and os.path.exists(f + ".ok"):
            reused += 1
            continue
        for stale in os.listdir(work):
            if stale.startswith(f"g{i:04d}-") and not stale.startswith(os.path.basename(f)):
                os.remove(os.path.join(work, stale))
        jobs.append({"plan": dict(plan), "f0": a, "f1": b, "out": f, "encoder": name, "crf": crf})
    stage(f"Encoding {len(jobs)} of {len(spans)} groups with {name}" if jobs else "Every group is already encoded")
    done = reused
    progress(done, len(spans))
    try:
        if len(jobs) <= 1 or workers == 1:
            for j in jobs:
                render_group(j)
                done += 1
                progress(done, len(spans))
        else:
            ctx = multiprocessing.get_context("spawn")
            with concurrent.futures.ProcessPoolExecutor(max_workers=min(workers, len(jobs)), mp_context=ctx) as ex:
                for _ in ex.map(render_group, jobs):
                    done += 1
                    progress(done, len(spans))
    except av.error.FFmpegError as e:
        raise RenderError(f"Encoding with {name} failed: {e}. Try --encoder libx264.") from e
    stage("Building the sound")
    master, orig, info = build_audio(plan, stage)
    margin = LOSSY_MARGIN
    a_files = []
    ceiling = plan["target"]["peak"]
    for attempt in range(2):
        m_path = os.path.join(work, "master.m4a")
        encode_aac(m_path, master)
        if not (plan["audio"]["master"] and info.get("lufs") is not None) or attempt:
            break
        be = _backend()
        lufs, tp = voice_clean.measure(be, media.read_audio(m_path, None, 0, 2))
        info["lufs"], info["true_peak"] = lufs, tp
        if tp <= ceiling + 0.05:
            break
        master, _l, _t = voice_clean.normalize(be, master, plan["target"]["lufs"], ceiling - margin - (tp - ceiling) - 0.3)
    a_files.append(m_path)
    if orig is not None:
        o_path = os.path.join(work, "original.m4a")
        encode_aac(o_path, orig)
        a_files.append(o_path)
    stage("Joining")
    starts = [a for a, _ in spans]
    meta = {"title": plan.get("title") or "", "comment": "Edited with Hildegard"}
    join(out_path, files, starts, plan, a_files, meta)
    chapters_in = False
    if plan["chapters"]:
        with open(os.path.splitext(out_path)[0] + ".chapters.txt", "w", encoding="utf-8") as f:
            f.write(chapters_text(plan["chapters"]))
        chapters_in = embed_chapters(out_path, plan["chapters"], plan["out_seconds"])
    sidecar = out_path + ".plan.json"
    with open(sidecar, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=1, default=str)
    if not keep_work:
        shutil.rmtree(work, ignore_errors=True)
    return {
        "ok": True, "out": out_path, "frames": total, "seconds": plan["out_seconds"], "width": plan["output"]["width"],
        "height": plan["output"]["height"], "fps": float(plan.fps), "encoder": name, "encoder_note": why,
        "groups": len(spans), "reused_groups": reused, "audio_tracks": len(a_files), "lufs": info.get("lufs"),
        "true_peak": info.get("true_peak"), "cleaned": info.get("cleaned"), "music": info.get("music"),
        "chapters_embedded": chapters_in, "plan": sidecar, "warnings": plan["warnings"],
    }
