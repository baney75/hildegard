# SPDX-License-Identifier: Apache-2.0
"""Reading, measuring, joining and writing audio. Mono float32 in [-1, 1] throughout."""
import math

import numpy as np

from .errors import VoiceError

#: What every clip is loudness-matched to: spoken word on a podcast or audiobook sits around here.
TARGET_LUFS = -18.0
#: Never louder than this on any sample.
CEILING_DB = -1.0


def _resample(wav, sr, to):
    if sr == to or not len(wav):
        return wav
    try:
        import librosa

        return librosa.resample(wav, orig_sr=sr, target_sr=to).astype(np.float32)
    except ImportError:  # linear is fine for the checks that run without librosa
        n = int(round(len(wav) * to / sr))
        return np.interp(np.linspace(0, len(wav) - 1, n), np.arange(len(wav)), wav).astype(np.float32)


def _mono(data):
    data = np.asarray(data, dtype=np.float32)
    return data.mean(axis=1) if data.ndim == 2 else data


def read(path, sr=None):
    """Any audio file, or the sound of a video, as (mono samples, rate). Resampled to sr when given."""
    wav, rate = None, None
    try:
        import soundfile as sf

        data, rate = sf.read(path, dtype="float32", always_2d=False)
        wav = _mono(data)
    except Exception:
        wav = None
    if wav is None:
        try:
            wav, rate = _read_av(path)
        except Exception as e:
            raise VoiceError("audio_unreadable", "Hildegard can’t read that file’s sound.", str(e)) from e
    if not len(wav):
        raise VoiceError("audio_unreadable", "That file has no sound in it.")
    wav = np.nan_to_num(wav, nan=0.0, posinf=0.0, neginf=0.0).clip(-1, 1)
    if sr and rate != sr:
        wav, rate = _resample(wav, rate, sr), sr
    return wav.astype(np.float32), int(rate)


def _read_av(path):
    import av

    with av.open(path) as box:
        stream = next((s for s in box.streams if s.type == "audio"), None)
        if stream is None:
            raise VoiceError("audio_unreadable", "That file has no sound in it.")
        rate = stream.rate or stream.codec_context.sample_rate
        resampler = av.AudioResampler(format="flt", layout="mono", rate=rate)
        chunks = []
        for frame in box.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    return (np.concatenate(chunks) if chunks else np.zeros(0, np.float32)), int(rate)


def write(path, wav, sr, title=None, comment=None):
    """A 16-bit WAV. The comment carries Hildegard's provenance line, which survives copying the file as is."""
    import soundfile as sf

    wav = np.asarray(wav, dtype=np.float32).clip(-1, 1)
    with sf.SoundFile(path, "w", samplerate=int(sr), channels=1, subtype="PCM_16", format="WAV") as f:
        f.software = "Hildegard"
        if title:
            f.title = title[:200]
        if comment:
            f.comment = comment[:500]
        f.write(wav)


def db(x):
    return 20 * math.log10(max(float(x), 1e-9))


def silence(seconds, sr):
    return np.zeros(int(round(max(0.0, seconds) * sr)), np.float32)


def join(parts, sr, fade_ms=8):
    """Clips one after another, each faded in and out over a few ms so a cut never clicks."""
    n = int(sr * fade_ms / 1000)
    out = []
    for p in parts:
        p = np.asarray(p, np.float32).copy()
        if n and len(p) > 2 * n:
            ramp = np.linspace(0, 1, n, dtype=np.float32)
            p[:n] *= ramp
            p[-n:] *= ramp[::-1]
        out.append(p)
    return np.concatenate(out) if out else np.zeros(0, np.float32)


def trim(wav, sr, top_db=40, keep_ms=60):
    """Cut leading and trailing silence, keeping a little air."""
    if not len(wav):
        return wav
    frame = max(1, sr // 100)
    n = len(wav) // frame
    if n < 2:
        return wav
    rms = np.sqrt(np.mean(wav[: n * frame].reshape(n, frame) ** 2, axis=1) + 1e-12)
    loud = np.nonzero(20 * np.log10(rms / (rms.max() + 1e-12)) > -top_db)[0]
    if not len(loud):
        return wav[:0]
    keep = int(sr * keep_ms / 1000)
    return wav[max(0, loud[0] * frame - keep) : min(len(wav), (loud[-1] + 1) * frame + keep)]


def loudness(wav, sr):
    """Integrated loudness in LUFS (ITU-R BS.1770); a plain RMS estimate where pyloudnorm isn't installed."""
    if len(wav) < sr // 2:
        return db(np.sqrt(np.mean(wav**2) + 1e-12)) - 0.7
    try:
        import pyloudnorm

        value = pyloudnorm.Meter(sr).integrated_loudness(wav.astype(np.float64))
        return float(value) if math.isfinite(value) else -70.0
    except ImportError:
        return db(np.sqrt(np.mean(wav**2) + 1e-12)) - 0.7


def normalize(wav, sr, target=TARGET_LUFS, ceiling=CEILING_DB):
    """Bring a clip to the target loudness without letting any peak past the ceiling."""
    if not len(wav) or not np.any(wav):
        return wav
    gain = 10 ** ((target - loudness(wav, sr)) / 20)
    peak = float(np.max(np.abs(wav))) * gain
    limit = 10 ** (ceiling / 20)
    if peak > limit:
        gain *= limit / peak
    return (wav * gain).astype(np.float32)


def analyze(wav, sr):
    """What the clone wizard checks on every clip: length, level, noise floor, clipping and how much is speech."""
    seconds = len(wav) / sr
    frame = max(1, sr // 50)
    n = len(wav) // frame
    if n == 0:
        return {"seconds": seconds, "peakDb": -120.0, "rmsDb": -120.0, "noiseDb": -120.0, "snrDb": 0.0,
                "clipping": 0.0, "speech": 0.0}
    frames = wav[: n * frame].reshape(n, frame)
    rms = np.sqrt(np.mean(frames**2, axis=1) + 1e-12)
    rms_db = 20 * np.log10(rms)
    noise = float(np.percentile(rms_db, 10))
    loud = float(np.percentile(rms_db, 90))
    return {
        "seconds": round(seconds, 3),
        "peakDb": round(db(np.max(np.abs(wav))), 2),
        "rmsDb": round(db(np.sqrt(np.mean(wav**2))), 2),
        "noiseDb": round(noise, 2),
        "snrDb": round(loud - noise, 2),
        "clipping": round(float(np.mean(np.abs(wav) >= 0.999)), 5),
        "speech": round(float(np.mean(rms_db > noise + 12)), 3),
    }


def fit(wav, sr, seconds, most=1.35):
    """Make a clip last `seconds`: speed it up (up to `most` times) when it runs long, pad it when it runs short."""
    want = int(round(seconds * sr))
    if want <= 0:
        return wav[:0]
    if len(wav) > want:
        rate = min(most, len(wav) / want)
        if rate > 1.01:
            try:
                import librosa

                wav = librosa.effects.time_stretch(wav, rate=rate).astype(np.float32)
            except ImportError:
                pass
        wav = wav[:want]
        n = min(len(wav), sr // 100)
        if n:
            wav[-n:] *= np.linspace(1, 0, n, dtype=np.float32)
        return wav
    return np.concatenate([wav, np.zeros(want - len(wav), np.float32)])


def mix(bed, sr, voices, duck_db=-14.0, fade_s=0.12):
    """Lay voices over a bed (the original sound), lowering the bed under each voice with short fades."""
    out = bed.astype(np.float32).copy()
    gain = np.ones(len(out), np.float32)
    duck = 10 ** (duck_db / 20)
    f = int(sr * fade_s)
    for start, clip in voices:
        a = int(round(start * sr))
        b = min(len(out), a + len(clip))
        if a >= len(out) or b <= a:
            continue
        gain[a:b] = np.minimum(gain[a:b], duck)
        if f:
            lo = max(0, a - f)
            gain[lo:a] = np.minimum(gain[lo:a], np.linspace(1, duck, a - lo, dtype=np.float32))
            hi = min(len(out), b + f)
            gain[b:hi] = np.minimum(gain[b:hi], np.linspace(duck, 1, hi - b, dtype=np.float32))
    out *= gain
    for start, clip in voices:
        a = int(round(start * sr))
        b = min(len(out), a + len(clip))
        if a < len(out) and b > a:
            out[a:b] += clip[: b - a]
    peak = float(np.max(np.abs(out))) if len(out) else 0.0
    return (out / peak * 0.97).astype(np.float32) if peak > 0.97 else out
