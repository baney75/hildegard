# SPDX-License-Identifier: Apache-2.0
"""The inaudible watermark on every clip Hildegard makes: Resemble AI's Perth (MIT), whose weights ship in its package.

A clip without the mark never leaves the engine. `detect` is the "Is this ours?" check: it hears the mark in a file
even after it has been re-encoded, which says an AI voice made it. Which voice and when is in Hildegard's own ledger.
"""
import numpy as np

from .errors import VoiceError

_marker = None


def _perth():
    global _marker
    if _marker is None:
        try:
            import perth

            cls = getattr(perth, "PerthImplicitWatermarker", None)
            if cls is None:
                raise ImportError("PerthImplicitWatermarker is unavailable")
            _marker = cls()
        except Exception as e:
            raise VoiceError(
                "no_watermark",
                "The watermark isn’t installed, so Hildegard won’t make voices here. Run `hildegard voice install` again.",
                str(e),
            ) from e
    return _marker


def apply(wav, sr):
    """The clip with the mark in it. Same length, same rate."""
    if not len(wav):
        return wav
    marked = np.asarray(_perth().apply_watermark(np.asarray(wav, np.float32), sample_rate=sr), np.float32)
    if len(marked) != len(wav):  # resampling inside can shift a sample either way
        marked = np.pad(marked, (0, max(0, len(wav) - len(marked))))[: len(wav)]
    return marked


def detect(wav, sr):
    """How sure the mark is there, 0 to 1. A clip Hildegard made reads near 1; one it didn't reads near 0."""
    if len(wav) < sr // 2:
        return 0.0
    bits = np.asarray(_perth().get_watermark(np.asarray(wav, np.float32), sample_rate=sr, round=False), np.float32)
    return float(np.clip(np.mean(bits), 0.0, 1.0)) if bits.size else 0.0


def reset():
    """Drop the marker, for tests."""
    global _marker
    _marker = None
