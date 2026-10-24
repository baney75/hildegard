# SPDX-License-Identifier: Apache-2.0
"""Qwen3-TTS (Apache-2.0, Alibaba's Qwen team), in two of its published forms:

- VoiceDesign (1.7B): a new voice from a description in words ("a weathered baritone, slow and kind"), plus a line of
  acting direction for each paragraph.
- Base (0.6B or 1.7B): clones a voice from a sample and what is said in it.

Ten languages. The model folder holds the repository's files as published, speech_tokenizer/ included.
"""
import os

import numpy as np

from ..errors import VoiceError
from . import pick_device

LANGS = {
    "en": "English",
    "zh": "Chinese",
    "ja": "Japanese",
    "ko": "Korean",
    "de": "German",
    "fr": "French",
    "ru": "Russian",
    "pt": "Portuguese",
    "es": "Spanish",
    "it": "Italian",
}


class Backend:
    sample_rate = 24000
    marks = False

    def __init__(self, model_dir, device=None):
        self.dir = model_dir
        self.device = pick_device(device)
        self._model = None

    def _load(self):
        if self._model is None:
            for f in ("config.json", "model.safetensors", os.path.join("speech_tokenizer", "model.safetensors")):
                if not os.path.exists(os.path.join(self.dir, f)):
                    raise VoiceError("model_missing", "Qwen3-TTS isn’t fully installed.", f)
            import torch
            from qwen_tts import Qwen3TTSModel

            dtype = torch.bfloat16 if self.device == "cuda" else torch.float32
            self._model = Qwen3TTSModel.from_pretrained(self.dir, device_map=self.device, dtype=dtype)
        return self._model

    def kind(self):
        import json

        with open(os.path.join(self.dir, "config.json"), encoding="utf-8") as f:
            return json.load(f).get("tts_model_type", "base")

    def speak(self, seg, voice, settings):
        m = self._load()
        lang = LANGS.get((seg.get("language") or "en").lower())
        if not lang:
            raise VoiceError("unsupported", f"Qwen3-TTS doesn’t speak {seg.get('language')}.")
        kw = {"temperature": float(np.clip(settings.get("temperature", 0.9), 0.1, 1.5))}
        kind = voice.get("kind")
        if kind == "design":
            # The voice is the description; a paragraph's direction adds to it.
            instruct = " ".join(x for x in (voice.get("description"), seg.get("instruct")) if x).strip()
            if not instruct:
                raise VoiceError("bad_request", "Describe the voice first.")
            wavs, sr = m.generate_voice_design(text=seg["text"], instruct=instruct, language=lang, **kw)
        elif kind == "clone":
            ref = voice.get("ref")
            if not ref or not os.path.exists(ref):
                raise VoiceError("bad_request", "The voice’s sample is missing.")
            ref_text = voice.get("refText")
            wavs, sr = m.generate_voice_clone(
                text=seg["text"],
                language=lang,
                ref_audio=ref,
                ref_text=ref_text,
                x_vector_only_mode=not ref_text,
                **kw,
            )
        else:
            raise VoiceError("unsupported", "Qwen3-TTS needs a described or cloned voice.")
        self.sample_rate = int(sr)
        wav = np.asarray(wavs[0], np.float32).reshape(-1)
        speed = float(settings.get("speed", 1.0))
        if abs(speed - 1.0) > 0.02:
            import librosa

            wav = librosa.effects.time_stretch(wav, rate=float(np.clip(speed, 0.5, 2.0))).astype(np.float32)
        return wav

    def release(self):
        self._model = None
