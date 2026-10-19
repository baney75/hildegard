# SPDX-License-Identifier: AGPL-3.0-only
"""Joins a film's takes, in order, into one MP4: H.264 video and, when any take has sound, AAC audio.

    python export_film.py SPEC.json

SPEC is {"out": path, "inputs": [path, ...], "title": str, "comment": str}. Every take is scaled to the first take's
size and frame rate; a take without sound gets silence. Prints one JSON line per take as it goes
({"done": i, "total": n}) and a last line {"ok": true, "seconds": s, "bytes": b}, or {"ok": false, "error": msg}.
Uses PyAV, which ComfyUI already installs, so there is nothing else to download.
"""

import json
import os
import sys
from fractions import Fraction

import av
import numpy as np

RATE = 48000


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
    width, height, fps, _ = probe(inputs[0])
    # H.264 in yuv420p wants even sizes.
    width, height = width - width % 2, height - height % 2
    sound = any(probe(p)[3] for p in inputs)

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
        if sound:
            aus = dst.add_stream("aac", rate=RATE, layout="stereo")
            aus.time_base = Fraction(1, RATE)
            audio = Audio(dst, aus)

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
            if sound:
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
        if sound:
            audio.close()
    os.replace(tmp, out)
    say(ok=True, seconds=round(float(total_frames / fps), 3), bytes=os.path.getsize(out))


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


class Audio:
    """Feeds the AAC encoder whole 1024-sample frames, which is all it takes."""

    def __init__(self, dst, stream):
        self.dst, self.stream = dst, stream
        self.fmt = stream.codec_context.format.name
        self.size = stream.codec_context.frame_size or 1024
        self.fifo = av.AudioFifo()
        self.pts = 0

    def push(self, arr):
        fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(arr), format=self.fmt, layout="stereo")
        fr.sample_rate = RATE
        fr.pts = None
        self.fifo.write(fr)
        self.drain(self.size)

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
