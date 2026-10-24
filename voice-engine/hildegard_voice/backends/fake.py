# SPDX-License-Identifier: Apache-2.0
"""A stand-in for tests and for `pnpm dev` without a GPU: a voice-like hum, as long as the words would take to say.

It needs only numpy. Different voices hum at different pitches, and the same text, voice and seed always make the same
clip, so tests can tell takes apart and repeat them.
"""
import hashlib
import os

import numpy as np

from ..errors import VoiceError


def _pitch(voice):
    key = voice.get("name") or voice.get("ref") or voice.get("description") or "default"
    return 110 + int(hashlib.sha256(key.encode()).hexdigest()[:4], 16) % 140


class Backend:
    sample_rate = 24000
    marks = False

    def __init__(self, model_dir, device=None):
        self.dir = model_dir
        self.device = "cpu"

    def speak(self, seg, voice, settings):
        text = seg["text"]
        if "[fail:oom]" in text:
            raise VoiceError("out_of_memory", "Your GPU ran out of memory.")
        if "[fail:engine]" in text:
            raise VoiceError("engine_failed", "The voice engine stopped with an error.")
        words = max(1, len(text.split()))
        seconds = max(0.4, words / (2.6 * float(settings.get("speed", 1.0))))
        sr = self.sample_rate
        t = np.arange(int(seconds * sr)) / sr
        f0 = _pitch(voice) * (1 + 0.04 * np.sin(2 * np.pi * 0.7 * t))
        phase = 2 * np.pi * np.cumsum(f0) / sr
        tone = sum(np.sin(k * phase) / k for k in range(1, 6))
        # Syllables: an envelope at about four a second.
        env = 0.5 + 0.5 * np.sin(2 * np.pi * 4.0 * t - np.pi / 2)
        rng = np.random.default_rng(int(settings.get("seed", 0)) % (2**32))
        wav = 0.25 * tone * env + 0.003 * rng.standard_normal(len(t))
        return wav.astype(np.float32)

    def convert(self, source, ref):
        from .. import audio

        wav, sr = audio.read(source, self.sample_rate)
        shift = _pitch({"ref": ref}) / 180
        idx = np.clip((np.arange(len(wav)) * shift).astype(int), 0, len(wav) - 1)
        return wav[idx].astype(np.float32)

    def transcribe(self, path, language=None, words=True):
        """What a test put in a sidecar file next to the clip, read back as a transcript with even word timings."""
        side = f"{path}.txt"
        text = open(side, encoding="utf-8").read().strip() if os.path.exists(side) else ""
        from .. import audio

        wav, sr = audio.read(path)
        dur = len(wav) / sr
        ws = text.split()
        step = dur / max(1, len(ws))
        return {
            "language": language or "en",
            "seconds": round(dur, 3),
            "segments": [
                {
                    "start": 0.0,
                    "end": round(dur, 3),
                    "text": text,
                    "words": [
                        {"start": round(i * step, 3), "end": round((i + 1) * step, 3), "word": w, "p": 0.99}
                        for i, w in enumerate(ws)
                    ],
                }
            ]
            if ws
            else [],
        }

    def release(self):
        pass
