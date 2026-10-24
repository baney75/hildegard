# SPDX-License-Identifier: Apache-2.0
import io
import json
import os

import numpy as np
import pytest

from hildegard_voice import audio, protocol
from hildegard_voice.backends import chatterbox as cb

FAKE = {"engine": "fake", "dir": ""}


def run(lines, fake_mark=True):
    out = io.StringIO()
    protocol.serve(stdin=io.StringIO("\n".join(json.dumps(x) for x in lines) + "\n"), stdout=out, fake_mark=fake_mark)
    return [json.loads(x) for x in out.getvalue().splitlines()]


def answer(msgs, rid):
    return next(m for m in msgs if m.get("id") == rid and "ok" in m)


def tone(seconds, sr=24000, f=180.0, amp=0.3):
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * f * t)).astype(np.float32)


def test_hello_says_ready_first(tmp_path):
    msgs = run([{"id": "1", "op": "hello"}])
    assert msgs[0] == {"ready": True, "version": protocol.__version__}
    assert answer(msgs, "1")["ok"] is True


def test_speak_writes_one_clip_with_progress_and_pauses(tmp_path):
    out = str(tmp_path / "a.wav")
    req = {
        "id": "2",
        "op": "speak",
        "model": FAKE,
        "voice": {"kind": "preset", "name": "af_heart"},
        "segments": [{"text": "In the summer of 1150", "pause": 0.5}, {"text": "she went down the river."}],
        "seed": 7,
        "out": out,
        "comment": "Made with Hildegard · v_1",
    }
    msgs = run([req])
    progress = [m["progress"] for m in msgs if "progress" in m]
    assert progress == [{"done": 1, "total": 2}, {"done": 2, "total": 2}]
    res = answer(msgs, "2")
    assert res["ok"], res
    r = res["result"]
    wav, sr = audio.read(out)
    assert sr == 24000 and abs(len(wav) / sr - r["seconds"]) < 0.01
    # The pause sits between the two segments.
    assert r["segments"][1]["start"] - r["segments"][0]["end"] >= 0.49
    # Loudness-matched, under the ceiling.
    assert abs(audio.loudness(wav, sr) - audio.TARGET_LUFS) < 2.5
    assert np.max(np.abs(wav)) <= 10 ** (audio.CEILING_DB / 20) + 1e-3
    import soundfile as sf

    assert "Hildegard" in (sf.info(out).extra_info or "") or sf.SoundFile(out).comment.startswith("Made with")


def test_same_seed_same_clip_and_another_voice_differs(tmp_path):
    def make(name, seed, f):
        out = str(tmp_path / f)
        run([{"id": "x", "op": "speak", "model": FAKE, "voice": {"kind": "preset", "name": name},
              "segments": [{"text": "Hello there"}], "seed": seed, "out": out}])
        return audio.read(out)[0]

    a, b, c = make("af_heart", 1, "a.wav"), make("af_heart", 1, "b.wav"), make("bm_george", 1, "c.wav")
    assert np.array_equal(a, b)
    assert len(a) != len(c) or not np.allclose(a, c)


def test_failures_have_codes_and_the_engine_keeps_going(tmp_path):
    msgs = run([
        {"id": "a", "op": "speak", "model": FAKE, "voice": {}, "segments": [{"text": "x [fail:oom]"}], "out": str(tmp_path / "a.wav")},
        {"id": "b", "op": "speak", "model": FAKE, "voice": {}, "segments": [], "out": str(tmp_path / "b.wav")},
        {"id": "c", "op": "nope"},
        {"id": "d", "op": "speak", "model": {"engine": "rm -rf"}, "voice": {}, "segments": [{"text": "hi"}], "out": str(tmp_path / "d.wav")},
        {"id": "e", "op": "hello"},
    ])
    assert answer(msgs, "a")["error"]["code"] == "out_of_memory"
    assert answer(msgs, "b")["error"]["code"] == "bad_request"
    assert answer(msgs, "c")["error"]["code"] == "bad_request"
    assert answer(msgs, "d")["error"]["code"] == "bad_request"
    assert answer(msgs, "e")["ok"]
    assert not os.path.exists(tmp_path / "a.wav")


def test_a_line_that_is_not_json_is_refused_not_fatal():
    out = io.StringIO()
    protocol.serve(stdin=io.StringIO('not json\n{"id":"1","op":"hello"}\n'), stdout=out, fake_mark=True)
    msgs = [json.loads(x) for x in out.getvalue().splitlines()]
    assert msgs[1]["ok"] is False and msgs[1]["error"]["code"] == "bad_request"
    assert answer(msgs, "1")["ok"]


def test_analyze_reports_level_noise_and_clipping(tmp_path):
    sr = 24000
    quiet = np.concatenate([tone(2, sr), np.zeros(sr, np.float32)]) + 0.001 * np.random.default_rng(0).standard_normal(3 * sr).astype(np.float32)
    p = str(tmp_path / "c.wav")
    audio.write(p, quiet, sr)
    r = answer(run([{"id": "1", "op": "analyze", "path": p}]), "1")["result"]
    assert 2.9 < r["seconds"] < 3.1
    assert r["snrDb"] > 30
    assert r["clipping"] == 0
    assert 0.55 < r["speech"] < 0.8
    clipped = np.clip(tone(1, sr, amp=2.0), -1, 1)
    audio.write(p, clipped, sr)
    assert answer(run([{"id": "1", "op": "analyze", "path": p}]), "1")["result"]["clipping"] > 0.05


def test_dub_fits_lines_to_their_slots_and_ducks_the_bed(tmp_path):
    sr = 24000
    bed = tone(6, sr, f=440, amp=0.2)
    audio.write(str(tmp_path / "bed.wav"), bed, sr)
    audio.write(str(tmp_path / "l1.wav"), tone(1.0, sr, f=200), sr)
    audio.write(str(tmp_path / "l2.wav"), tone(3.0, sr, f=200), sr)  # too long for its 2 s slot
    out = str(tmp_path / "dub.wav")
    r = answer(
        run([{"id": "1", "op": "dub", "bed": str(tmp_path / "bed.wav"), "out": out, "sampleRate": sr,
              "lines": [{"start": 0.5, "seconds": 1.5, "path": str(tmp_path / "l1.wav")},
                        {"start": 3.0, "seconds": 2.0, "path": str(tmp_path / "l2.wav")}]}]),
        "1",
    )
    assert r["ok"], r
    wav, _ = audio.read(out, sr)
    assert abs(len(wav) - len(bed)) <= 1
    # Nothing of the long line spills past its slot.
    after = wav[int(5.2 * sr) : int(5.8 * sr)]
    assert np.max(np.abs(after - bed[int(5.2 * sr) : int(5.8 * sr)])) < 0.05


def test_join_never_clicks_and_fit_pads_short_clips():
    sr = 24000
    j = audio.join([np.ones(sr, np.float32), np.ones(sr, np.float32)], sr)
    assert j[0] == 0 and j[-1] == 0
    assert len(audio.fit(np.ones(sr, np.float32), sr, 2.0)) == 2 * sr


def test_vc_windows_cut_long_recordings_and_keep_every_sample():
    sr = 16000
    wav = np.random.default_rng(1).standard_normal(sr * 65).astype(np.float32)
    wav[sr * 15 : sr * 15 + sr // 5] = 0  # a quiet moment to cut at
    parts = cb._windows(wav, sr, 20.0)
    assert sum(len(p) for p in parts) == len(wav)
    assert all(len(p) <= 20 * sr for p in parts)
    assert len(parts[0]) < 20 * sr


def test_decode_turns_any_recording_into_a_mono_wav(tmp_path):
    import soundfile as sf

    src = str(tmp_path / "in.flac")
    stereo = np.stack([tone(2.0, 48000), tone(2.0, 48000)], axis=1)
    sf.write(src, stereo, 48000)
    out = str(tmp_path / "out.wav")
    r = answer(run([{"id": "1", "op": "decode", "path": src, "out": out}]), "1")
    assert r["ok"], r
    wav, sr = sf.read(out)
    assert sr == 24000 and wav.ndim == 1 and abs(len(wav) - 48000) < 10
    assert r["result"]["seconds"] == pytest.approx(2.0, abs=0.01)


def test_decode_refuses_what_isnt_audio(tmp_path):
    bad = tmp_path / "x.wav"
    bad.write_bytes(b"not audio at all")
    r = answer(run([{"id": "1", "op": "decode", "path": str(bad), "out": str(tmp_path / "o.wav")}]), "1")
    assert not r["ok"] and r["error"]["code"] == "audio_unreadable"
