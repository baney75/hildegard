# SPDX-License-Identifier: Apache-2.0
"""Kokoro-82M (Apache-2.0, hexgrad): 54 built-in voices in eight languages, fast enough for any CPU.

Files under the model folder: config.json, kokoro-v1_0.pth and voices/<name>.pt. A voice's first letter is its
language: a American English, b British English, e Spanish, f French, h Hindi, i Italian, p Brazilian Portuguese,
z Mandarin. It can't clone or take acting directions; Hildegard says so in the Studio rather than ignoring them.
"""
import os

import numpy as np

from ..errors import VoiceError
from . import pick_device

REPO = "hexgrad/Kokoro-82M"
LANGS = {"a", "b", "e", "f", "h", "i", "p", "z"}


class Backend:
    sample_rate = 24000
    marks = False

    def __init__(self, model_dir, device=None):
        self.dir = model_dir
        self.device = pick_device(device)
        self._model = None
        self._pipes = {}

    def _load(self):
        if self._model is None:
            from kokoro import KModel

            cfg = os.path.join(self.dir, "config.json")
            pth = os.path.join(self.dir, "kokoro-v1_0.pth")
            for f in (cfg, pth):
                if not os.path.exists(f):
                    raise VoiceError("model_missing", "Kokoro isn’t fully installed.", f)
            self._model = KModel(repo_id=REPO, config=cfg, model=pth).to(self.device).eval()
        return self._model

    def _pipe(self, lang):
        if lang not in self._pipes:
            from kokoro import KPipeline

            self._pipes[lang] = KPipeline(lang_code=lang, repo_id=REPO, model=self._load())
        return self._pipes[lang]

    def speak(self, seg, voice, settings):
        name = voice.get("name") or "af_heart"
        if voice.get("kind") not in (None, "preset"):
            raise VoiceError("unsupported", "Kokoro speaks only its own voices. Chatterbox or Qwen3-TTS can clone.")
        path = os.path.join(self.dir, "voices", f"{os.path.basename(name)}.pt")
        if not os.path.exists(path):
            raise VoiceError("model_missing", f"Kokoro has no voice called {name}.", path)
        lang = name[0]
        if lang not in LANGS:
            raise VoiceError("unsupported", f"Kokoro can’t speak {name}’s language here.")
        speed = float(np.clip(settings.get("speed", 1.0), 0.5, 2.0))
        import torch

        parts = []
        with torch.inference_mode():
            for result in self._pipe(lang)(seg["text"], voice=path, speed=speed):
                a = result.audio if hasattr(result, "audio") else result[2]
                if a is not None:
                    parts.append(a.detach().cpu().numpy().astype(np.float32).reshape(-1))
        if not parts:
            raise VoiceError("engine_failed", "Kokoro made no sound for that text.")
        return np.concatenate(parts)

    def release(self):
        self._model = None
        self._pipes = {}
