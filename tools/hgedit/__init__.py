# SPDX-License-Identifier: AGPL-3.0-only
"""Hildegard's video editor for agents: an edit list (`edl.json`) any model can write, rendered and proven on the output.

The pieces, in the order a job goes through them:

    edl.py          the contract: JSON Schema (edl.schema.json), a validator with plain-English errors, `--check`
    media.py        probing and decoding with PyAV (nothing else to install)
    signals.py      speech energy, typing and fan noise, pauses, motion, loudness; where the subject is
    transcript.py   word-timed text in, an edit list out: delete words, drop fillers, keep the last take
    plan.py         resolves an edit list to frames: the one function the renderer and the gate both use
    textfx.py       titles and captions: layout and drawing, so the gate can measure what the renderer drew
    encoders.py     h264_nvenc, h264_videotoolbox, h264_qsv, h264_vaapi when this computer has them, else libx264
    render.py       grouped parallel encode, restartable per group, audio mastering, dts-interleaved output
    verify.py       the gate: exit non-zero unless the output itself proves the edit list
    sheet.py        a contact sheet of the cut, with the joins
    selftest.py     synthesizes a recording with a planted fake key; the gate must fail without the blur, pass with it

Run it through ../edit_video.py. The design owes ideas to 0xSero/video-edit (an edit list rendered by a script and checked
on the output), onetwothird/Vedit (edl.json, filler and bad-take cuts), WyattBlue/auto-editor (loudness and motion cuts
with margins) and bugbakery/audapolis (edit the transcript, the media follows). The code is written for Hildegard.
"""

VERSION = 1
