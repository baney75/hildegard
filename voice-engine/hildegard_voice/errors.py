# SPDX-License-Identifier: Apache-2.0
"""Failures sorted into codes the server can explain in a sentence, like the video engine's."""


class VoiceError(Exception):
    """code is one of: bad_request, model_missing, out_of_memory, unsupported, audio_unreadable, no_watermark,
    engine_failed."""

    def __init__(self, code, message, detail=""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail


def classify(e):
    """Turn any exception into a VoiceError."""
    if isinstance(e, VoiceError):
        return e
    text = f"{type(e).__name__}: {e}"
    if any(s in text for s in ("out of memory", "OutOfMemory", "MPS backend out of memory", "Allocation on device")):
        return VoiceError("out_of_memory", "Your GPU ran out of memory.", text)
    if isinstance(e, FileNotFoundError) or "No such file" in text:
        return VoiceError("model_missing", "A model file this needs is not installed.", text)
    if isinstance(e, ModuleNotFoundError):
        return VoiceError("model_missing", "The voice engine for this model is not installed.", text)
    return VoiceError("engine_failed", "The voice engine stopped with an error.", text)
