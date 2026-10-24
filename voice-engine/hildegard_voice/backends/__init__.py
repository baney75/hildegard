# SPDX-License-Identifier: Apache-2.0
"""One module per model family. Each loads only from its model folder, lazily, and frees the GPU on release()."""
import importlib

ENGINES = {
    "kokoro": "kokoro",
    "chatterbox": "chatterbox",
    "qwen3-tts": "qwen",
    "whisper": "whisper",
    "fake": "fake",
}


def load(engine):
    if engine not in ENGINES:
        from ..errors import VoiceError

        raise VoiceError("bad_request", f"Unknown voice engine {engine!r}.")
    return importlib.import_module(f".{ENGINES[engine]}", __name__)


def pick_device(prefer=None, mps=True):
    """CUDA, then Apple's GPU where the model runs on it, then the CPU. `prefer` ("cpu") overrides."""
    try:
        import torch
    except ImportError:
        return "cpu"
    if prefer == "cpu":
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    m = getattr(torch.backends, "mps", None)
    if mps and m is not None and m.is_available():
        return "mps"
    return "cpu"


def seed_all(seed):
    import random

    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed % (2**32))
    except ImportError:
        pass
    try:
        import torch

        torch.manual_seed(seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass


def free_gpu():
    import gc

    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        m = getattr(torch, "mps", None)
        if m is not None and hasattr(m, "empty_cache") and torch.backends.mps.is_available():
            m.empty_cache()
    except Exception:
        pass
