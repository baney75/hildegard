# SPDX-License-Identifier: Apache-2.0
# The speaker encoder below follows Resemble AI's Chatterbox (MIT), itself adapted from Corentin Jemine's
# Real-Time-Voice-Cloning (MIT): https://github.com/resemble-ai/chatterbox, models/voice_encoder. Copyright (c) 2025
# Resemble AI; copyright (c) 2019 Corentin Jemine. Both under the MIT License, kept in THIRD_PARTY_NOTICES.md.
"""Who is speaking: a 256-number fingerprint of a voice, for the consent check.

Hildegard keeps the speaker's recorded consent with every cloned voice and compares each sample against it before
anything is made from them. A sample from someone else is refused. The weights are Chatterbox's `ve.safetensors`
(5.7 MB), which downloads with every model that can clone.
"""
import numpy as np

SAMPLE_RATE = 16000
N_FFT = 400
HOP = 160
MELS = 40
PARTIAL = 160
#: Two clips this alike or more are the same person. The encoder's own scale: unrelated adults sit around 0.4 to 0.6,
#: one person on two microphones around 0.8 to 0.9.
SAME_SPEAKER = 0.75

_models = {}


def _encoder(path, device="cpu"):
    import torch
    from torch import nn

    class VoiceEncoder(nn.Module):
        def __init__(self):
            super().__init__()
            self.lstm = nn.LSTM(MELS, 256, num_layers=3, batch_first=True)
            self.proj = nn.Linear(256, 256)
            self.similarity_weight = nn.Parameter(torch.tensor([10.0]))
            self.similarity_bias = nn.Parameter(torch.tensor([-5.0]))

        def forward(self, mels):
            _, (hidden, _) = self.lstm(mels)
            raw = torch.relu(self.proj(hidden[-1]))
            return raw / torch.linalg.norm(raw, dim=1, keepdim=True).clamp_min(1e-9)

    key = (path, str(device))
    if key not in _models:
        from safetensors.torch import load_file

        model = VoiceEncoder()
        model.load_state_dict(load_file(path))
        _models.clear()
        _models[key] = model.to(device).eval()
    return _models[key]


def mel(wav):
    """40-band power mel spectrogram at 16 kHz, (frames, 40), as the encoder was trained on."""
    import librosa

    spec = np.abs(librosa.stft(wav, n_fft=N_FFT, hop_length=HOP, win_length=N_FFT, center=True, pad_mode="reflect"))
    basis = librosa.filters.mel(sr=SAMPLE_RATE, n_fft=N_FFT, n_mels=MELS, fmin=0, fmax=8000)
    return np.dot(basis, spec**2).T.astype(np.float32)


def partials(m, rate=1.3, min_coverage=0.8):
    """Overlapping 1.6 s windows over the spectrogram, as Chatterbox's encoder takes them."""
    step = max(1, min(PARTIAL, int(round((SAMPLE_RATE / rate) / PARTIAL))))
    n, rem = divmod(max(len(m) - PARTIAL + step, 0), step)
    if n == 0 or (rem + (PARTIAL - step)) / PARTIAL >= min_coverage:
        n += 1
    need = PARTIAL + step * (n - 1)
    if need > len(m):
        m = np.concatenate([m, np.zeros((need - len(m), MELS), np.float32)])
    return np.stack([m[i * step : i * step + PARTIAL] for i in range(n)])


def embed(path_or_wav, weights, sr=None, device="cpu"):
    """One L2-normalised fingerprint for a whole clip."""
    import torch

    from . import audio

    if isinstance(path_or_wav, str):
        wav, _ = audio.read(path_or_wav, SAMPLE_RATE)
    else:
        wav = audio._resample(np.asarray(path_or_wav, np.float32), sr, SAMPLE_RATE)
    wav = audio.trim(wav, SAMPLE_RATE, top_db=20)
    if len(wav) < SAMPLE_RATE:
        from .errors import VoiceError

        raise VoiceError("bad_request", "That clip has less than a second of speech in it.")
    model = _encoder(weights, device)
    with torch.inference_mode():
        parts = torch.from_numpy(partials(mel(wav))).to(device)
        e = model(parts).mean(dim=0)
        e = e / torch.linalg.norm(e).clamp_min(1e-9)
    return e.cpu().numpy().astype(np.float32)


def similarity(a, b):
    return float(np.dot(np.asarray(a, np.float32), np.asarray(b, np.float32)))
