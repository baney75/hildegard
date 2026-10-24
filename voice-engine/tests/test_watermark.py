# SPDX-License-Identifier: Apache-2.0
import pytest

from hildegard_voice import audio

from .test_engine import FAKE, answer, run, tone

perth = pytest.importorskip("perth", reason="the watermark library isn't installed")


def test_every_real_clip_is_watermarked_and_the_checker_hears_it(tmp_path):
    out = str(tmp_path / "m.wav")
    msgs = run([{"id": "1", "op": "speak", "model": FAKE, "voice": {"name": "af_heart"},
                 "segments": [{"text": "one two three four five six seven eight nine ten"}], "out": out}], fake_mark=False)
    assert answer(msgs, "1")["ok"], msgs
    plain = str(tmp_path / "p.wav")
    audio.write(plain, tone(4.0), 24000)
    marked = answer(run([{"id": "2", "op": "mark", "path": out}]), "2")["result"]["score"]
    unmarked = answer(run([{"id": "3", "op": "mark", "path": plain}]), "3")["result"]["score"]
    assert marked > 0.8 > 0.3 > unmarked
