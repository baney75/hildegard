# SPDX-License-Identifier: AGPL-3.0-only
"""Shared audio helpers for the creative eval: decode through ffmpeg, write 16-bit WAVs, find pauses, a Welch PSD."""
import subprocess, wave
import numpy as np

SR = 44100


def read_audio(path, sr=SR, channels=1):
    """Decode any audio file ffmpeg can read to float32 in [-1, 1]; shape (n,) for mono, (n, c) otherwise. channels=None keeps
    the file's own channels (used to count clipped samples without an up- or down-mix changing the level)."""
    if channels is None:
        channels = int(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0',
                                       str(path)], capture_output=True, text=True).stdout.strip() or 1)
    af = []
    if channels == 1:  # average the channels; ffmpeg's own downmix sums them at 0.707 each, which can exceed full scale
        n = int(subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'csv=p=0',
                                str(path)], capture_output=True, text=True).stdout.strip() or 1)
        if n > 1:
            af = ['-af', 'pan=mono|c0=' + '+'.join(f'{1 / n:.6f}*c{i}' for i in range(n))]
    r = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vn', *af, '-f', 'f32le', '-ac', str(channels), '-ar', str(sr), '-'],
                       capture_output=True)
    if r.returncode or not r.stdout:
        raise ValueError(f'ffmpeg could not decode {path}: {r.stderr.decode()[:200]}')
    x = np.frombuffer(r.stdout, dtype='<f4').astype(np.float32)
    return x if channels == 1 else x.reshape(-1, channels)


def write_wav(path, x, sr=SR):
    x = np.clip(np.asarray(x, dtype=np.float64), -1.0, 1.0)
    pcm = np.round(x * 32767).astype('<i2')
    with wave.open(str(path), 'wb') as w:
        w.setnchannels(1 if pcm.ndim == 1 else pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def db(v):
    return 20 * np.log10(np.maximum(v, 1e-9))


def rms_db(x):
    return float(db(np.sqrt(np.mean(np.square(x, dtype=np.float64)) + 1e-18)))


def frame_db(x, sr=SR, win=0.02):
    n = int(sr * win)
    m = len(x) // n
    f = x[:m * n].reshape(m, n).astype(np.float64)
    return db(np.sqrt(np.mean(f * f, axis=1) + 1e-18))


def pause_frames(x, sr=SR, win=0.02, min_len=0.25, margin=28.0, trim=0.05):
    """Boolean per 20 ms frame: True inside a pause (a stretch of at least min_len seconds more than `margin` dB below
    the file's loud speech level, its 95th-percentile frame, trimmed by `trim` seconds at both ends so word tails do not
    leak in). Also returns the speech frames, those within 18 dB of that level. Always run it on a clean signal: the
    scorer applies the masks it finds to degraded and processed files."""
    d = frame_db(x, sr, win)
    loud = np.percentile(d, 95)
    thr = loud - margin
    low = d < thr
    pause = np.zeros_like(low)
    i, n, k, t = 0, len(low), int(round(min_len / win)), int(round(trim / win))
    while i < n:
        if low[i]:
            j = i
            while j < n and low[j]:
                j += 1
            if j - i >= k:
                pause[i + t:j - t] = True
            i = j
        else:
            i += 1
    speech = d > loud - 18
    speech &= ~pause
    return pause, speech


def welch(segments, sr=SR, nfft=8192):
    """Average Hann-windowed periodogram over every full window inside the given segments (a list of arrays)."""
    w = np.hanning(nfft)
    acc, cnt = np.zeros(nfft // 2 + 1), 0
    for s in segments:
        for a in range(0, len(s) - nfft + 1, nfft // 2):
            acc += np.abs(np.fft.rfft(s[a:a + nfft] * w)) ** 2
            cnt += 1
    if not cnt:
        return None, None
    return np.fft.rfftfreq(nfft, 1 / sr), acc / cnt


def segments_from_frames(x, mask, sr=SR, win=0.02):
    """Contiguous runs of True frames as arrays of samples."""
    n = int(sr * win)
    out, i = [], 0
    while i < len(mask):
        if mask[i]:
            j = i
            while j < len(mask) and mask[j]:
                j += 1
            out.append(x[i * n:j * n])
            i = j
        else:
            i += 1
    return out
