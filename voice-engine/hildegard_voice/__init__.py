# SPDX-License-Identifier: Apache-2.0
"""Hildegard's voice engine: speech, voice design, cloning, speech-to-speech and transcription on your own GPU.

It runs as a child of the Hildegard server, one process per model family, each in its own Python environment, and
speaks JSON lines over stdin and stdout (see protocol.py). It never reaches the network: every model loads from the
folder Hildegard downloaded and checked it into, and every clip it makes carries an inaudible watermark.
"""

__version__ = "0.1.0"
