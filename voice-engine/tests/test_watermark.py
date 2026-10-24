# SPDX-License-Identifier: Apache-2.0
import numpy as np
import pytest

from hildegard_voice import audio, mark

from .test_engine import FAKE, answer, run

perth = pytest.importorskip("perth", reason="the watermark library isn't installed")


def test_every_real_clip_is_watermarked_and_the_checker_hears_it(tmp_path):
    out = str(tmp_path / "m.wav")
    msgs = run([{"id": "1", "op": "speak", "model": FAKE, "voice": {"name": "af_heart"},
                 "segments": [{"text": "one two three four five six seven eight nine ten"}], "out": out}], fake_mark=False)
    assert answer(msgs, "1")["ok"], msgs
    assert answer(run([{"id": "2", "op": "mark", "path": out}]), "2")["result"]["score"] > 0.8
    # Broadband sound, as speech is: the detector reads it clean until the mark goes in. (A pure tone is no test:
    # Perth reads one as marked either way. Real speech from LibriSpeech reads 0.01 to 0.03 unmarked, 1.0 marked.)
    plain = (0.05 * np.random.default_rng(0).standard_normal(4 * 24000)).astype(np.float32)
    path = str(tmp_path / "p.wav")
    audio.write(path, plain, 24000)
    assert answer(run([{"id": "3", "op": "mark", "path": path}]), "3")["result"]["score"] < 0.3
    assert mark.detect(mark.apply(plain, 24000), 24000) > 0.8
