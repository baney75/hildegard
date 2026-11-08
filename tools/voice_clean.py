# SPDX-License-Identifier: AGPL-3.0-only
"""Speech cleanup and loudness, in one place: the recorded-voice chain every Hildegard voice-over goes through.

    python voice_clean.py SPEC.json          clean a recording (voice or video)
    python voice_clean.py --probe FILE       how long it is, and what it holds

SPEC is {"src": path, "out": path, "target_lufs": -16, "peak": -1.5}. `out` ending in .wav is audio only; a video
source with an .mp4 or .webm `out` keeps its picture as it is (copied, not re-encoded) and gets the cleaned sound.
Prints one JSON line per stage ({"stage": name}) and a last line {"ok": true, "lufs": I, "true_peak": dBTP,
"seconds": s, "backend": "pyav"|"ffmpeg"}, or {"ok": false, "error": msg}.

The chain (CHAIN below) is the only copy. Skills point here instead of repeating it, and export_film.py imports
`normalize` from this file for the voice-over mix. It runs through PyAV's filter graph when that build has every
filter in the chain, else through an ffmpeg on PATH, else it says so plainly. HILDEGARD_CLEAN_BACKEND=pyav|ffmpeg
forces one (tests use it).

Chain, in order: two cascaded 80 Hz high-passes (rumble, handling thumps), narrow notches at mains hum (50 and 60 Hz)
and its harmonics, click removal, FFT denoise, level evening, a second lighter denoise for what the evening lifted, a
gentle gate for the gaps between words, a gentle compressor, then two-pass loudnorm to the target with the measured
values and linear=true, so the whole take moves by one gain and keeps its dynamics.
"""

import gc
import json
import os
import re
import shutil
import subprocess
import sys
from fractions import Fraction

import av
import numpy as np

RATE = 48000

DEFAULT_LUFS = -16.0
DEFAULT_PEAK = -1.5
LUFS_RANGE = (-40.0, -5.0)
PEAK_RANGE = (-9.0, 0.0)

HUM_HZ = (50, 60, 100, 120, 150, 180, 240)

# Every step before loudnorm, as (filter, options). One list feeds both backends.
CHAIN = (
    [("highpass", "f=80:poles=2")] * 2
    + [("bandreject", f"f={hz}:width_type=q:w=30") for hz in HUM_HZ]
    + [
        ("adeclick", ""),
        ("afftdn", "nr=14:nf=-40:tn=1"),
        ("dynaudnorm", "f=250:g=15:m=8"),
        ("afftdn", "nr=8:nf=-45:tn=1"),
        ("agate", "threshold=0.06:ratio=2:range=0.4"),
        ("acompressor", "threshold=0.125:ratio=2:attack=20:release=250:makeup=1"),
    ]
)
NEEDED = sorted(
    {name for name, _ in CHAIN} | {"loudnorm", "alimiter", "ebur128", "aformat", "abuffer", "abuffersink"}
)


class CleanError(Exception):
    """A plain one-line reason, shown to the person as it is."""


def say(**kw):
    print(json.dumps(kw), flush=True)


# ── Filters: PyAV's graph, or an ffmpeg on PATH ─────────────────────────────────────────────────────────────────


def pyav_has_filters():
    try:
        have = set(av.filter.filters_available)
    except Exception:
        return False
    return all(n in have for n in NEEDED)


def choose_backend():
    want = os.environ.get("HILDEGARD_CLEAN_BACKEND", "").lower()
    if want == "pyav":
        if not pyav_has_filters():
            raise CleanError("This PyAV build doesn’t have the audio filters the cleanup needs.")
        return Pyav()
    if want == "ffmpeg":
        return Ffmpeg.found()
    if pyav_has_filters():
        return Pyav()
    return Ffmpeg.found()


def layout_of(channels):
    return {1: "mono", 2: "stereo"}.get(channels) or f"{channels}c"


class Pyav:
    name = "pyav"

    def run(self, chain, x, capture=None):
        """`x` (channels, samples) float32 at RATE through `chain`, a list of (filter, options). Returns the same shape.

        With `capture`, the text the filters log while they close (loudnorm's and ebur128's reports) is appended."""
        channels = x.shape[0]
        layout = layout_of(channels)
        out = []

        def go():
            g = av.filter.Graph()
            prev = g.add_abuffer(format="fltp", sample_rate=RATE, layout=layout, time_base=Fraction(1, RATE))
            for name, opts in chain:
                node = g.add(name, opts)
                prev.link_to(node)
                prev = node
            fmt = g.add("aformat", f"sample_fmts=fltp:sample_rates={RATE}:channel_layouts={layout}")
            prev.link_to(fmt)
            sink = g.add("abuffersink")
            fmt.link_to(sink)
            g.configure()

            def drain():
                while True:
                    try:
                        out.append(g.pull().to_ndarray())
                    except (av.error.BlockingIOError, av.error.EOFError):
                        return

            step = 4096
            for i in range(0, x.shape[1], step):
                chunk = np.ascontiguousarray(x[:, i : i + step], dtype=np.float32)
                fr = av.AudioFrame.from_ndarray(chunk, format="fltp", layout=layout)
                fr.sample_rate = RATE
                fr.pts = i
                fr.time_base = Fraction(1, RATE)
                g.push(fr)
                drain()
            g.push(None)
            drain()

        level = av.logging.get_level()
        if level is None:
            level = av.logging.WARNING
        with av.logging.Capture(local=False) as logs:
            av.logging.set_level(av.logging.INFO)
            av.logging.set_libav_level(av.logging.INFO)
            # The same report twice in a row (two takes that measure alike) must not be folded into one.
            av.logging.set_skip_repeated(False)
            try:
                go()
                # loudnorm and ebur128 print their reports when the graph closes.
                gc.collect()
            finally:
                av.logging.set_level(level)
                av.logging.set_libav_level(level)
        if capture is not None:
            capture.extend(m for _, _, m in logs)
        if not out:
            return np.zeros((channels, 0), dtype=np.float32)
        return np.concatenate(out, axis=1)


class Ffmpeg:
    name = "ffmpeg"

    def __init__(self, path):
        self.path = path

    @staticmethod
    def found():
        path = shutil.which("ffmpeg")
        if not path:
            raise CleanError(
                "Cleaning needs audio filters and this computer has neither a PyAV with them nor ffmpeg. "
                "Run `hildegard install`, or install ffmpeg and try again."
            )
        return Ffmpeg(path)

    def run(self, chain, x, capture=None):
        channels = x.shape[0]
        graph = ",".join(f"{n}={o}" if o else n for n, o in chain) or "anull"
        cmd = [
            self.path, "-hide_banner", "-nostdin", "-loglevel", "info",
            "-f", "f32le", "-ar", str(RATE), "-ac", str(channels), "-i", "-",
            "-af", graph, "-f", "f32le", "-ar", str(RATE), "-ac", str(channels), "-",
        ]  # fmt: skip
        r = subprocess.run(cmd, input=np.ascontiguousarray(x.T, dtype="<f4").tobytes(), capture_output=True)
        if r.returncode != 0:
            tail = r.stderr.decode("utf-8", "replace").strip().splitlines()[-1:] or ["ffmpeg failed"]
            raise CleanError(f"ffmpeg could not clean this recording: {tail[0]}")
        if capture is not None:
            capture.append(r.stderr.decode("utf-8", "replace"))
        y = np.frombuffer(r.stdout, dtype="<f4")
        return np.ascontiguousarray(y.reshape(-1, channels).T)


# ── Reading and writing ─────────────────────────────────────────────────────────────────────────────────────────


def decode(path, channels=1):
    """The first audio stream of any file, as float32 (channels, samples) at RATE."""
    try:
        with av.open(path) as c:
            if not c.streams.audio:
                raise CleanError("There’s no sound in that recording.")
            rs = av.AudioResampler(format="fltp", layout=layout_of(channels), rate=RATE)
            parts = []
            for frame in c.decode(c.streams.audio[0]):
                for f in rs.resample(frame):
                    parts.append(f.to_ndarray())
            for f in rs.resample(None):
                parts.append(f.to_ndarray())
    except av.error.FFmpegError as e:
        raise CleanError("Hildegard couldn’t read that recording.") from e
    if not parts:
        raise CleanError("There’s no sound in that recording.")
    return np.concatenate(parts, axis=1).astype(np.float32, copy=False)


def write_wav(path, x):
    """A 16-bit PCM WAV of (channels, samples) float32 at RATE."""
    pcm = (np.clip(x, -1.0, 1.0) * 32767.0).round().astype("<i2")
    with av.open(path, "w", format="wav") as c:
        s = c.add_stream("pcm_s16le", rate=RATE, layout=layout_of(x.shape[0]))
        step = 4096
        for i in range(0, pcm.shape[1], step):
            fr = av.AudioFrame.from_ndarray(
                np.ascontiguousarray(pcm[:, i : i + step].T.reshape(1, -1)),
                format="s16",
                layout=layout_of(x.shape[0]),
            )
            fr.sample_rate = RATE
            fr.pts = i
            fr.time_base = Fraction(1, RATE)
            for p in s.encode(fr):
                c.mux(p)
        for p in s.encode():
            c.mux(p)


def probe(path):
    """How long a file is and whether it has sound or picture, from its packets (no decoding)."""
    try:
        with av.open(path) as c:
            end = 0.0
            for p in c.demux():
                if p.pts is None or p.stream.time_base is None:
                    continue
                t = float((p.pts + (p.duration or 0)) * p.stream.time_base)
                end = max(end, t)
            return {"seconds": round(end, 3), "audio": bool(c.streams.audio), "video": bool(c.streams.video)}
    except av.error.FFmpegError as e:
        raise CleanError("Hildegard couldn’t read that recording.") from e


# ── Loudness ────────────────────────────────────────────────────────────────────────────────────────────────────


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if np.isfinite(f) else None


def measure(backend, x):
    """Integrated loudness (LUFS) and true peak (dBTP) of (channels, samples), by EBU R128 (ebur128, 4x oversampled)."""
    logs = []
    backend.run([("ebur128", "peak=true:framelog=quiet")], x, logs)
    text = "\n".join(logs)
    i = re.findall(r"I:\s+(-?[\d.]+|-inf)\s+LUFS", text)
    p = re.findall(r"Peak:\s+(-?[\d.]+|-inf)\s+dBFS", text)
    lufs, tp = (_num(i[-1]) if i else None), (_num(p[-1]) if p else None)
    if lufs is None or tp is None:
        raise CleanError("There’s no speech in that recording.")
    return lufs, tp


def loudnorm_stats(backend, x, target, peak):
    """loudnorm's first pass: what the audio measures, as the numbers the second pass wants."""
    logs = []
    backend.run([("loudnorm", f"I={target}:TP={peak}:LRA=11:print_format=json")], x, logs)
    for text in reversed(logs):
        m = re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", text, re.S)
        if m:
            s = json.loads(m.group(0))
            vals = {k: _num(s.get(k)) for k in ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")}
            if all(v is not None for v in vals.values()):
                return vals
    raise CleanError("There’s no speech in that recording.")


def limit(backend, x, ceiling_db):
    """A look-ahead peak limiter at `ceiling_db` (dBFS), for the rare take loudnorm can't reach without one."""
    c = 10 ** (ceiling_db / 20)
    return backend.run([("alimiter", f"limit={c:.5f}:attack=5:release=60:level=disabled")], x)


def normalize(backend, x, target=DEFAULT_LUFS, peak=DEFAULT_PEAK):
    """Two-pass loudnorm of (channels, samples) to `target` LUFS and a true peak at or under `peak`, linear (one gain).

    Returns (audio, lufs, true_peak), the last two measured on the result. Linear mode needs the take's peak to leave
    room for the gain (loudness no more than `peak - target` dB under its peak); speech often doesn't, and loudnorm
    then works dynamically and lands short. When the measured result is off target or over the limit, the gain is
    set to the target and a look-ahead limiter holds the peak, measured again each round."""
    s = loudnorm_stats(backend, x, target, peak)
    opts = (
        f"I={target}:TP={peak}:LRA=11:measured_I={s['input_i']}:measured_TP={s['input_tp']}"
        f":measured_LRA={s['input_lra']}:measured_thresh={s['input_thresh']}:offset={s['target_offset']}"
        ":linear=true:print_format=summary"
    )
    y = backend.run([("loudnorm", opts)], x)
    lufs, tp = measure(backend, y)
    # The meter reads to a tenth of a dB, so the peak stays a tenth under the limit.
    ceiling = peak - 0.4
    for _ in range(5):
        if abs(lufs - target) <= 0.3 and tp <= peak - 0.1:
            break
        y = y * np.float32(10 ** ((target - lufs) / 20))
        y = limit(backend, y, ceiling)
        lufs, tp = measure(backend, y)
        if tp > peak - 0.1:
            ceiling -= tp - (peak - 0.1) + 0.1
    return y, lufs, tp


def check_targets(target, peak):
    if not (LUFS_RANGE[0] <= target <= LUFS_RANGE[1]):
        raise CleanError(f"Choose a loudness between {LUFS_RANGE[0]:g} and {LUFS_RANGE[1]:g} LUFS.")
    if not (PEAK_RANGE[0] <= peak <= PEAK_RANGE[1]):
        raise CleanError(f"Choose a true peak between {PEAK_RANGE[0]:g} and {PEAK_RANGE[1]:g} dBTP.")


def clean_audio(backend, x, target=DEFAULT_LUFS, peak=DEFAULT_PEAK, stage=lambda name: None):
    """(1, samples) float32 speech → cleaned and normalized, with its loudness and true peak."""
    check_targets(target, peak)
    if not np.any(np.abs(x) > 1e-4):
        raise CleanError("There’s no speech in that recording.")
    stage("Cleaning")
    y = backend.run(CHAIN, x)
    stage("Leveling")
    return normalize(backend, y, target, peak)


# ── Files ───────────────────────────────────────────────────────────────────────────────────────────────────────


# AAC and Opus move peaks by a few tenths of a dB. A cleaned video leaves this much room under the ceiling, and its
# result is measured again on the file that was written.
LOSSY_MARGIN = 0.6


def clean_file(src, out, target=DEFAULT_LUFS, peak=DEFAULT_PEAK, stage=lambda name: None):
    backend = choose_backend()
    info = probe(src)
    if not info["audio"]:
        raise CleanError("There’s no sound in that recording.")
    ext = os.path.splitext(out)[1].lower()
    if ext != ".wav" and not info["video"]:
        raise CleanError("A recording with no picture is cleaned to a WAV file.")
    check_targets(target, peak)
    x = decode(src, 1)
    # A sound that comes in after the picture does, or a timeline that starts late, keeps its place.
    begins = 0.0 if ext == ".wav" else audio_start(src)
    margin = 0.0 if ext == ".wav" else LOSSY_MARGIN
    tmp = out + ".part" + ext
    try:
        for attempt in range(2):
            y, lufs, tp = clean_audio(backend, x, target, peak - margin, stage)
            if ext == ".wav":
                write_wav(tmp, y)
                break
            stage("Putting the picture back")
            mux_with_video(src, tmp, y, ext, begins)
            # What the file really says, after the codec.
            lufs, tp = measure(backend, decode(tmp, 1))
            if tp <= peak or attempt:
                break
            margin += tp - peak + 0.3
        os.replace(tmp, out)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"lufs": lufs, "true_peak": tp, "seconds": round(y.shape[1] / RATE, 3), "backend": backend.name}


def audio_start(src):
    """Seconds into the file at which its first audio packet begins (0 when it starts with the picture)."""
    with av.open(src) as c:
        if not c.streams.audio:
            return 0.0
        for pkt in c.demux(c.streams.audio[0]):
            if pkt.pts is not None and pkt.size and pkt.stream.time_base is not None:
                return max(0.0, float(pkt.pts * pkt.time_base))
    return 0.0


def encode_sound(stream, y, start=0.0):
    """`y` (channels, samples) float32, encoded with `stream` into packets, its first sample `start` seconds in."""
    layout = layout_of(y.shape[0])
    stream.time_base = Fraction(1, RATE)
    packets = []
    fifo = av.AudioFifo()
    size = stream.codec_context.frame_size or 1024
    # A lossy codec starts its packets this many samples ahead of the first real one, and a container reports the
    # packets' time, so a sound written to start at `start` is read back that much early unless it is added here.
    stream.codec_context.open(strict=False)
    pts = round(start * RATE) + (stream.codec_context.initial_padding if start else 0)

    def flush(at_least):
        nonlocal pts
        while fifo.samples >= at_least and fifo.samples > 0:
            fr = fifo.read(min(size, fifo.samples))
            fr.pts = pts
            fr.time_base = Fraction(1, RATE)
            pts += fr.samples
            packets.extend(stream.encode(fr))

    step = 4096
    for i in range(0, y.shape[1], step):
        fr = av.AudioFrame.from_ndarray(
            np.ascontiguousarray(y[:, i : i + step], dtype=np.float32), format="fltp", layout=layout
        )
        fr.sample_rate = RATE
        fifo.write(fr)
        flush(size)
    flush(1)
    packets.extend(stream.encode())
    return packets


def write_interleaved(dst, inp, vin, vout, sound):
    """The picture's packets from `inp`, copied as they are, with the encoded `sound` between them in time order.

    A muxer holds a stream back only so long (10 s by default); all the picture before any of the sound would leave
    the sound far behind it."""

    def at(pkt):
        return float(pkt.dts * pkt.time_base)

    nxt = 0
    for pkt in inp.demux(vin):
        if pkt.dts is None:
            continue
        while nxt < len(sound) and at(sound[nxt]) <= at(pkt):
            dst.mux(sound[nxt])
            nxt += 1
        pkt.stream = vout
        dst.mux(pkt)
    for p in sound[nxt:]:
        dst.mux(p)


def mux_with_video(src, out, y, ext, start=0.0):
    """The source's picture, copied as it is, with `y` (1, samples) as its sound, `start` seconds in as it was."""
    fmt = "webm" if ext == ".webm" else "mp4"
    codec = "libopus" if fmt == "webm" else "aac"
    with av.open(src) as inp, av.open(out, "w", format=fmt) as dst:
        vin = inp.streams.video[0]
        vout = dst.add_stream_from_template(vin)
        ain = dst.add_stream(codec, rate=RATE, layout="mono")
        ain.bit_rate = 96000
        # The sound is encoded first, so the two can be written in time order.
        write_interleaved(dst, inp, vin, vout, encode_sound(ain, y, start))


def main(argv):
    if len(argv) == 3 and argv[1] == "--probe":
        say(ok=True, **probe(argv[2]))
        return
    with open(argv[1], encoding="utf-8") as f:
        spec = json.load(f)
    r = clean_file(
        spec["src"],
        spec["out"],
        float(spec.get("target_lufs", DEFAULT_LUFS)),
        float(spec.get("peak", DEFAULT_PEAK)),
        stage=lambda name: say(stage=name),
    )
    say(ok=True, **r)


if __name__ == "__main__":
    try:
        main(sys.argv)
    except CleanError as e:
        say(ok=False, error=str(e))
        sys.exit(1)
    except Exception as e:  # The server shows this to the person, so keep it to one plain line.
        say(ok=False, error=str(e) or type(e).__name__)
        sys.exit(1)
