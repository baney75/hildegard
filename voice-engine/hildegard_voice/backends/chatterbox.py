# SPDX-License-Identifier: Apache-2.0
"""Chatterbox Multilingual (MIT, Resemble AI): clones a voice from a few seconds, in 23 languages, with an emotion
control, and converts one voice to another (speech to speech) with the same decoder.

Files under the model folder, as Chatterbox's own from_local reads them: ve.pt, t3_mtl23ls_v2.safetensors, s3gen.pt,
grapheme_mtl_merged_expanded_v1.json, conds.pt (its built-in voice) and Cangjie5_TC.json (for Chinese). Chatterbox
watermarks what it makes itself, with the same Perth mark Hildegard uses.
"""
import os

import numpy as np

from .. import audio
from ..errors import VoiceError
from . import pick_device

FILES = (
    "ve.pt",
    "t3_mtl23ls_v2.safetensors",
    "s3gen.pt",
    "grapheme_mtl_merged_expanded_v1.json",
    "conds.pt",
)
LANGS = {
    "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt",
    "ru", "sv", "sw", "tr", "zh",
}  # fmt: skip
#: Speech-to-speech converts in windows this long, cut at the quietest moment near the end of each.
VC_WINDOW_S = 20.0


def _offline_cangjie(model_dir):
    """Chatterbox fetches its Chinese table from Hugging Face; hand it the copy Hildegard downloaded instead."""
    try:
        from chatterbox.models.tokenizers import tokenizer as tok
    except ImportError:
        return
    local = os.path.join(model_dir, "Cangjie5_TC.json")

    def hf_hub_download(*_a, filename=None, **_k):
        if filename == "Cangjie5_TC.json" and os.path.exists(local):
            return local
        raise FileNotFoundError(f"{filename} isn’t installed")

    tok.hf_hub_download = hf_hub_download


class Backend:
    sample_rate = 24000
    marks = True

    def __init__(self, model_dir, device=None):
        self.dir = model_dir
        self.device = pick_device(device)
        self._tts = None
        self._vc = None

    def _load(self):
        if self._tts is None:
            for f in FILES:
                if not os.path.exists(os.path.join(self.dir, f)):
                    raise VoiceError("model_missing", "Chatterbox isn’t fully installed.", f)
            _offline_cangjie(self.dir)
            from chatterbox.mtl_tts import ChatterboxMultilingualTTS

            self._tts = ChatterboxMultilingualTTS.from_local(self.dir, self.device)
            self.sample_rate = int(self._tts.sr)
        return self._tts

    def speak(self, seg, voice, settings):
        tts = self._load()
        lang = (seg.get("language") or "en").lower()
        if lang not in LANGS:
            raise VoiceError("unsupported", f"Chatterbox doesn’t speak {lang}.")
        kind = voice.get("kind") or "default"
        if kind == "clone":
            ref = voice.get("ref")
            if not ref or not os.path.exists(ref):
                raise VoiceError("bad_request", "The voice’s sample is missing.")
        elif kind != "default":
            raise VoiceError("unsupported", "Chatterbox clones voices; it can’t design one from words.")
        else:
            ref = None
        wav = tts.generate(
            seg["text"],
            language_id=lang,
            audio_prompt_path=ref,
            exaggeration=float(np.clip(settings.get("exaggeration", 0.5), 0.25, 2.0)),
            cfg_weight=float(np.clip(settings.get("cfg", 0.5), 0.0, 1.0)),
            temperature=float(np.clip(settings.get("temperature", 0.8), 0.05, 2.0)),
        )
        wav = wav.detach().cpu().numpy().reshape(-1).astype(np.float32)
        speed = float(settings.get("speed", 1.0))
        if abs(speed - 1.0) > 0.02:
            import librosa

            wav = librosa.effects.time_stretch(wav, rate=float(np.clip(speed, 0.5, 2.0))).astype(np.float32)
        return wav

    def convert(self, source, ref):
        """`source` spoken again in the voice of `ref`, word for word and with its timing."""
        tts = self._load()
        if self._vc is None:
            from chatterbox.vc import ChatterboxVC

            self._vc = ChatterboxVC(tts.s3gen, self.device)
        wav, sr = audio.read(source, 16000)
        out = []
        for piece in _windows(wav, sr, VC_WINDOW_S):
            tmp = os.path.join(os.path.dirname(source), f".vc-{os.getpid()}-{len(out)}.wav")
            audio.write(tmp, piece, sr)
            try:
                got = self._vc.generate(tmp, target_voice_path=ref)
            finally:
                os.remove(tmp)
            out.append(got.detach().cpu().numpy().reshape(-1).astype(np.float32))
        return audio.join(out, self.sample_rate)

    def release(self):
        self._tts = None
        self._vc = None


def _windows(wav, sr, seconds):
    """Cut a long recording into pieces of at most `seconds`, each ending at the quietest 100 ms near its end."""
    n = int(seconds * sr)
    if len(wav) <= n:
        return [wav]
    out, start, frame = [], 0, sr // 10
    while start < len(wav):
        end = min(len(wav), start + n)
        if end < len(wav):
            lo = start + n // 2
            region = wav[lo:end]
            k = len(region) // frame
            if k > 1:
                e = (region[: k * frame].reshape(k, frame) ** 2).mean(axis=1)
                end = lo + int(np.argmin(e)) * frame + frame // 2
        out.append(wav[start:end])
        start = end
    return out
