# SPDX-License-Identifier: AGPL-3.0-only
"""Joins a film's takes, in order, into one MP4: H.264 video and AAC audio.

    python export_film.py SPEC.json

SPEC is {"out": path, "inputs": [path, ...], "title": str, "comment": str, "voiceover": {...}}. Every take is fitted
to the largest take's size, at the first take's frame rate; a take without sound gets silence, and a film with no sound
at all still gets a silent track, since some players and sites mishandle video with no audio. Prints one JSON line per
take as it goes ({"done": i, "total": n}) and a last line {"ok": true, "seconds": s, "bytes": b}, or {"ok": false,
"error": msg}. Uses PyAV, which ComfyUI already installs, so there is nothing else to download.

A voice-over, {"path": file, "start_seconds": 0, "gain_db": 0, "duck_db": 12}, is mixed over the film's own sound: the
film is turned down by duck_db while the voice speaks (the voice's level sets the envelope: it follows within 30 ms,
starts 50 ms ahead of the first word, and lets go over 300 ms), the voice is padded or cut to the film's length, and the
mix is loudnormed to -14 LUFS and -1 dBTP (voice_clean.normalize). The last line then adds "lufs" and "true_peak".
"""

import json
import os
import sys
from fractions import Fraction

import av
import numpy as np

# `python -I` leaves the script's folder off the path; the loudness code lives next to this file.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voice_clean  # noqa: E402

RATE = 48000
FILM_LUFS = -14.0
FILM_PEAK = -1.0
# AAC moves peaks by a few tenths of a dB, so the mix is set that much under the ceiling before it is encoded.
FILM_MARGIN = 0.4


def say(**kw):
    print(json.dumps(kw), flush=True)


def probe(path):
    with av.open(path) as c:
        v = c.streams.video[0]
        rate = v.average_rate or v.guessed_rate or Fraction(24)
        return v.codec_context.width, v.codec_context.height, Fraction(rate), bool(c.streams.audio)


def main(spec_path):
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    inputs, out = spec["inputs"], spec["out"]
    if not inputs:
        raise ValueError("There are no finished takes to export.")
    probes = [probe(p) for p in inputs]
    fps = probes[0][2]
    # The sharpest take sets the size, so a final take isn't scaled down to match a draft.
    width, height = max(((w, h) for w, h, _, _ in probes), key=lambda wh: wh[0] * wh[1])
    # H.264 in yuv420p wants even sizes.
    width, height = width - width % 2, height - height % 2

    tmp = out + ".part"
    total_frames = 0
    with av.open(tmp, "w", format="mp4", options={"movflags": "+faststart"}) as dst:
        dst.metadata["title"] = spec.get("title", "")
        dst.metadata["comment"] = spec.get("comment", "")
        vs = dst.add_stream("libx264", rate=fps)
        vs.width, vs.height, vs.pix_fmt = width, height, "yuv420p"
        vs.options = {"crf": "18", "preset": "medium"}
        # Frames are numbered in 1/fps; the muxer gives the stream its own time base once it starts writing.
        tb = Fraction(1, 1) / fps
        vs.time_base = tb
        aus = dst.add_stream("aac", rate=RATE, layout="stereo")
        aus.time_base = Fraction(1, RATE)
        voiceover = spec.get("voiceover")
        audio = Audio(dst, aus, collect=[] if voiceover else None)

        for i, path in enumerate(inputs):
            take_frames = 0
            with av.open(path) as src:
                stream = src.streams.video[0]
                src_fps = Fraction(stream.average_rate or stream.guessed_rate or fps)
                for j, frame in enumerate(src.decode(stream)):
                    img = fit(frame, width, height)
                    # Keep each take's own timing: repeat or drop frames when its rate differs from the film's.
                    while take_frames / fps < (j + 1) / src_fps:
                        img.pts = total_frames
                        img.time_base = tb
                        total_frames += 1
                        take_frames += 1
                        for p in vs.encode(img):
                            dst.mux(p)
            # This take's sound, cut or padded with silence to its picture's length, so sound stays in sync.
            want = round(take_frames / fps * RATE)
            got = 0
            with av.open(path) as src:
                if src.streams.audio:
                    rs = av.AudioResampler(format=audio.fmt, layout="stereo", rate=RATE)
                    frames = []
                    for frame in src.decode(src.streams.audio[0]):
                        frames.extend(rs.resample(frame))
                    frames.extend(rs.resample(None))
                    for fr in frames:
                        if got >= want:
                            break
                        n = min(fr.samples, want - got)
                        arr = fr.to_ndarray()[..., :n] if n < fr.samples else fr.to_ndarray()
                        audio.push(arr)
                        got += n
            if got < want:
                audio.silence(want - got)
            say(done=i + 1, total=len(inputs))

        for p in vs.encode():
            dst.mux(p)
        loud = None
        if voiceover:
            say(stage="voice-over")
            loud = audio.mix_voiceover(voiceover)
        audio.close()
    os.replace(tmp, out)
    extra = {"lufs": loud[0], "true_peak": loud[1]} if loud else {}
    say(ok=True, seconds=round(float(total_frames / fps), 3), bytes=os.path.getsize(out), **extra)


def fit(frame, width, height):
    """The frame at the film's size. A take of another shape is letterboxed, never stretched."""
    w, h = frame.width, frame.height
    if abs(w / h - width / height) < 0.01:
        return frame.reformat(width=width, height=height, format="yuv420p")
    scale = min(width / w, height / h)
    fw, fh = max(2, round(w * scale) // 2 * 2), max(2, round(h * scale) // 2 * 2)
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    x, y = (width - fw) // 2, (height - fh) // 2
    canvas[y : y + fh, x : x + fw] = frame.reformat(width=fw, height=fh, format="rgb24").to_ndarray()
    return av.VideoFrame.from_ndarray(canvas, format="rgb24").reformat(format="yuv420p")


def duck_envelope(voice, duck_db, hop=RATE // 100):
    """Gain for the film, per sample: 1 away from the voice, down by duck_db while it speaks.

    The voice's level is read every 10 ms. Speaking is anything well above the voice's own quiet (its room noise),
    found from the recording itself, so a clean take and a noisy one duck the same. The film starts to drop 50 ms
    before a word, follows the voice within 30 ms, and comes back over 300 ms, so short pauses between words don't pump."""
    n = voice.shape[1]
    hops = max(1, n // hop)
    level = np.empty(hops)
    for h in range(hops):
        seg = voice[:, h * hop : (h + 1) * hop]
        level[h] = 10 * np.log10(float(np.mean(seg * seg)) + 1e-12)
    heard = level[level > -80]
    active = np.zeros(hops)
    if heard.size:
        ref, floor = np.percentile(heard, 95), np.percentile(heard, 10)
        thr = -60.0 if ref - floor < 6 else max(-60.0, floor + 0.35 * (ref - floor))
        active = (level > thr).astype(float)
    lead = 5  # hops, 50 ms
    active = np.concatenate([active[lead:], np.zeros(min(lead, hops))])
    dt = hop / RATE
    up, down = 1 - np.exp(-dt / 0.03), 1 - np.exp(-dt / 0.3)
    s = np.empty(hops)
    cur = 0.0
    for h in range(hops):
        cur += (active[h] - cur) * (up if active[h] > cur else down)
        s[h] = cur
    gain = 1 - s * (1 - 10 ** (-duck_db / 20))
    centers = (np.arange(hops) + 0.5) * hop
    return np.interp(np.arange(n), centers, gain).astype(np.float32)


class Audio:
    """Feeds the AAC encoder whole 1024-sample frames, which is all it takes.

    With `collect`, the sound is kept instead, until `mix_voiceover` mixes a voice over it and sends it on."""

    def __init__(self, dst, stream, collect=None):
        self.dst, self.stream = dst, stream
        self.fmt = stream.codec_context.format.name
        self.size = stream.codec_context.frame_size or 1024
        self.fifo = av.AudioFifo()
        self.pts = 0
        self.collect = collect

    def push(self, arr):
        if self.collect is not None:
            a = np.asarray(arr, dtype=np.float32)
            self.collect.append(a if self.fmt.endswith("p") else a.reshape(-1, 2).T)
            return
        self.send(arr)

    def send(self, arr):
        fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(arr), format=self.fmt, layout="stereo")
        fr.sample_rate = RATE
        fr.pts = None
        self.fifo.write(fr)
        self.drain(self.size)

    def mix_voiceover(self, vo):
        """Mix the voice over the collected film sound, loudnorm it, and encode it. Returns (lufs, true_peak)."""
        film = np.concatenate(self.collect, axis=1) if self.collect else np.zeros((2, 0), dtype=np.float32)
        self.collect = None
        n = film.shape[1]
        start = round(float(vo.get("start_seconds", 0) or 0) * RATE)
        if start < 0:
            raise ValueError("The voice-over can’t start before the film does.")
        if start >= n:
            raise ValueError("The voice-over starts after the film ends.")
        voice = voice_clean.decode(vo["path"], 2) * np.float32(10 ** (float(vo.get("gain_db", 0) or 0) / 20))
        placed = np.zeros((2, n), dtype=np.float32)
        take = min(voice.shape[1], n - start)
        placed[:, start : start + take] = voice[:, :take]
        duck = float(12 if vo.get("duck_db") is None else vo["duck_db"])
        mix = film * duck_envelope(placed, duck) + placed
        backend = voice_clean.choose_backend()
        mix, lufs, tp = voice_clean.normalize(backend, mix, FILM_LUFS, FILM_PEAK - FILM_MARGIN)
        for i in range(0, mix.shape[1], 4096):
            self.send(mix[:, i : i + 4096])
        return lufs, tp

    def silence(self, n):
        planar = self.fmt.endswith("p")
        while n > 0:
            k = min(n, 4096)
            self.push(np.zeros((2, k) if planar else (1, k * 2), dtype=np.float32))
            n -= k

    def drain(self, at_least):
        while self.fifo.samples >= at_least and self.fifo.samples > 0:
            fr = self.fifo.read(min(self.size, self.fifo.samples))
            fr.pts = self.pts
            fr.time_base = Fraction(1, RATE)
            self.pts += fr.samples
            for p in self.stream.encode(fr):
                self.dst.mux(p)

    def close(self):
        self.drain(1)
        for p in self.stream.encode():
            self.dst.mux(p)


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except Exception as e:  # The server shows this to the person, so keep it to one plain line.
        say(ok=False, error=str(e) or type(e).__name__)
        sys.exit(1)
