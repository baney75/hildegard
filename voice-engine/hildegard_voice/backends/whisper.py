# SPDX-License-Identifier: Apache-2.0
"""faster-whisper (MIT, SYSTRAN) running OpenAI's Whisper weights (MIT) converted for CTranslate2: transcripts with
word timings, for the transcript editor, dubbing and the consent check."""
import os

from ..errors import VoiceError
from . import pick_device


class Backend:
    sample_rate = 16000
    marks = False

    def __init__(self, model_dir, device=None):
        self.dir = model_dir
        # CTranslate2 has no Apple GPU backend; int8 on the CPU is quick for the small model.
        self.device = "cuda" if pick_device(device, mps=False) == "cuda" else "cpu"
        self._model = None

    def _load(self):
        if self._model is None:
            if not os.path.exists(os.path.join(self.dir, "model.bin")):
                raise VoiceError("model_missing", "The transcription model isn’t installed.")
            from faster_whisper import WhisperModel

            self._model = WhisperModel(
                self.dir, device=self.device, compute_type="float16" if self.device == "cuda" else "int8"
            )
        return self._model

    def transcribe(self, path, language=None, words=True):
        segments, info = self._load().transcribe(
            path, language=language or None, word_timestamps=words, vad_filter=True, beam_size=5
        )
        out = []
        for s in segments:
            out.append(
                {
                    "start": round(s.start, 3),
                    "end": round(s.end, 3),
                    "text": s.text.strip(),
                    "words": [
                        {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word.strip(), "p": round(w.probability, 3)}
                        for w in (s.words or [])
                    ],
                }
            )
        return {"language": info.language, "seconds": round(info.duration, 3), "segments": out}

    def release(self):
        self._model = None
