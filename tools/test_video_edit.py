# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for tools/hgedit and tools/edit_video.py. Run: python -I tools/test_video_edit.py (the server's test suite runs this).

Clips are tiny and made here: a few seconds at 12 fps, with a voice-shaped sound, fan noise and keystrokes, so nothing is
downloaded and every test says what it proves. Hardware encoders are never tried: tests pass libx264."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import weakref

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["HG_EDIT_ENCODER"] = "libx264"

from hgedit import edl as edl_mod, encoders, media, plan as plan_mod, render, selftest, signals, transcript as tr, verify  # noqa: E402
from hgedit.media import RATE  # noqa: E402

FPS = 12
EDIT_VIDEO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "edit_video.py")


def scene_for(w, h):
    def scene(i, t):
        img = np.full((h, w, 3), 40, np.uint8)
        x = int((0.5 + 0.4 * np.sin(t * 2.0)) * (w - 24))
        img[h // 3 : h // 3 + 24, x : x + 24] = (240, 240, 240)
        img[:6, : (i * 7) % w + 1] = (200, 80, 80)
        return img

    return scene


def make_clip(path, seconds=6.0, size=(320, 180), talk=((0.3, 1.8), (3.0, 4.5)), typing=(), scene=None):
    selftest.write_recording(path, seconds, FPS, size, selftest.voice_track(seconds, list(talk), typing), scene or scene_for(*size))


class Tmp(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix="hg-edit-test-")
        self.addCleanup(shutil.rmtree, self.d, True)

    def p(self, name):
        return os.path.join(self.d, name)

    def write_edl(self, edl, name="e.json"):
        path = self.p(name)
        with open(path, "w") as f:
            json.dump(edl, f)
        return path


# ── The contract ────────────────────────────────────────────────────────────────────────────────────────────────


class Contract(Tmp):
    def setUp(self):
        super().setUp()
        self.clip = self.p("a.mp4")
        make_clip(self.clip)

    def errs(self, edl):
        try:
            plan_mod.resolve(edl, self.d, analyze=False, track=False)
        except edl_mod.EdlError as e:
            return [f"{p}: {m}" for p, m in e.errors]
        return []

    def test_a_good_list_resolves_to_a_known_frame_count(self):
        plan = plan_mod.resolve({"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 0.5, "end": 2.5}, {"start": 3.0, "end": 4.0}]}, self.d)
        self.assertEqual(plan["out_frames"], 24 + 12)
        self.assertEqual(plan["joins"], [24])
        self.assertEqual(plan["audio_samples"], round(36 / FPS * RATE))

    def test_rejects_unknown_fields_and_suggests_the_near_one(self):
        e = self.errs({"version": 1, "sources": {"a": {"path": self.clip}}, "music": {"path": self.clip, "fadeout": 2}})
        self.assertTrue(any("music.fadeout" in x and "fade_out" in x for x in e), e)
        e = self.errs({"version": 1, "sources": {"a": {"path": self.clip}}, "keeps": []})
        self.assertTrue(any("keeps" in x and "keep" in x for x in e), e)

    def test_rejects_bad_ranges(self):
        src = {"a": {"path": self.clip}}
        bad = [
            ({"keep": [{"start": 3, "end": 2}]}, "keep[0].end"),
            ({"keep": [{"start": 0, "end": 99}]}, "past the end"),
            ({"keep": [{"start": -1, "end": 2}]}, "keep[0].start"),
            ({"cuts": [{"start": 1, "end": 1}]}, "cuts[0].end"),
            ({"keep": [{"start": 0, "end": 2, "source": "zz"}]}, "isn’t one of the sources"),
            ({"blur": [{"start": 1, "end": 2}]}, "needs a box"),
            ({"blur": [{"start": 1, "end": 2, "box": [0.1, 0.1, 2, 0.2]}]}, "blur[0].box[2]"),
            ({"titles": [{"text": "x", "start": 50, "end": 60}]}, "after the video ends"),
            ({"keep": [{"start": 0, "end": 2}], "cuts": [{"start": 0, "end": 2.5}]}, "Nothing is left"),
            ({"secrets": [{"regex": "(", "text": None}]}, "secrets[0]"),
        ]
        for extra, want in bad:
            e = self.errs({"version": 1, "sources": src, **extra})
            self.assertTrue(any(want in x for x in e), (extra, e))

    def test_two_sources_need_a_source_on_every_range(self):
        e = self.errs({"version": 1, "sources": {"a": {"path": self.clip}, "b": {"path": self.clip}}, "keep": [{"start": 0, "end": 1}]})
        self.assertTrue(any("needs a source" in x for x in e), e)

    def test_check_command_exits_nonzero_and_names_the_field(self):
        path = self.write_edl({"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 2, "end": 1}]})
        import subprocess

        r = subprocess.run([sys.executable, "-I", os.path.join(os.path.dirname(__file__), "edit_video.py"), "check", "--json", path], capture_output=True, text=True)
        self.assertEqual(r.returncode, 1)
        out = json.loads(r.stdout.strip().splitlines()[-1])
        self.assertFalse(out["ok"])
        self.assertEqual(out["errors"][0]["path"], "keep[0].end")

    def test_snaps_to_the_frame_grid_and_joins_abutting_pieces(self):
        plan = plan_mod.resolve({"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 1.01, "end": 2.02}, {"start": 2.02, "end": 3.0}]}, self.d)
        self.assertEqual(len(plan["segments"]), 1)
        self.assertEqual(plan["segments"][0]["src_frame"], 12)
        self.assertEqual(plan["out_frames"], 36 - 12)

    def test_schema_matches_what_the_validator_enforces(self):
        s = edl_mod.schema()
        self.assertEqual(s["additionalProperties"], False)
        self.assertIn("pauses", s["properties"])
        for k in ("blur", "boxes", "titles", "captions", "chapters", "music", "reframe", "target"):
            self.assertIn(k, s["properties"])


# ── Words in, edit list out ─────────────────────────────────────────────────────────────────────────────────────


def words_from(text_with_times):
    """'0.0 so  0.4 um  0.8 the' style helper: a list of (start, end, word) → transcript segments."""
    return {"language": "en", "segments": [{"start": text_with_times[0][0], "end": text_with_times[-1][1], "text": "",
                                           "words": [{"start": a, "end": b, "word": w} for a, b, w in text_with_times]}]}


SAMPLE = words_from([
    (0.00, 0.30, "So"), (0.30, 0.70, "today"), (0.70, 1.00, "we"), (1.00, 1.40, "build"), (1.40, 1.90, "this."),
    (2.40, 2.65, "Um,"), (3.20, 3.50, "first"), (3.50, 3.90, "the"), (3.90, 4.40, "setup."),
    (5.00, 5.30, "It"), (5.30, 5.70, "is,"), (5.70, 5.90, "like,"), (6.30, 6.80, "simple."),
    (7.50, 7.80, "I"), (7.80, 8.10, "like"), (8.10, 8.50, "tea."),
])


class TranscriptEdit(Tmp):
    def test_fillers_go_with_margins_that_protect_the_neighbours(self):
        words = tr.words_of(SAMPLE)
        found = tr.find_fillers(words)
        gone = {words[i]["word"] for i in found}
        self.assertEqual(gone, {"Um,", "like,"})  # a hesitation "like," goes; "I like tea" stays
        cuts, notes = tr.cuts_for(words, found, "filler", margin=0.05, duration=9.0)
        self.assertEqual(len(cuts), 2)
        a, b, _ = cuts[0]
        self.assertAlmostEqual(a, 1.90 + 0.05)  # 50 ms after "this."
        self.assertAlmostEqual(b, 3.20 - 0.05)  # 50 ms before "first"
        # No cut touches a kept word.
        for a, b, _ in cuts:
            for w in words:
                if w["i"] not in found:
                    self.assertTrue(b <= w["start"] or a >= w["end"], (a, b, w))

    def test_a_cut_with_no_room_is_skipped_and_said_so(self):
        words = tr.words_of(words_from([(0, 0.4, "so"), (0.42, 0.5, "uh"), (0.52, 1.0, "yes")]))
        cuts, notes = tr.cuts_for(words, tr.find_fillers(words), "filler", margin=0.05)
        self.assertEqual(cuts, [])
        self.assertTrue(any("clear of the words" in n for n in notes))

    def test_the_last_take_stays(self):
        words = tr.words_of(words_from([
            (0.0, 0.3, "So"), (0.3, 0.6, "the"), (0.6, 1.0, "thing"), (1.0, 1.3, "is"), (1.3, 1.5, "the."),
            (3.0, 3.3, "So"), (3.3, 3.6, "the"), (3.6, 4.0, "thing"), (4.0, 4.3, "is"), (4.3, 4.8, "simple.")]))
        bad = tr.find_bad_takes(words)
        self.assertEqual(sorted(bad), [0, 1, 2, 3, 4])
        self.assertNotIn(5, bad)

    def test_a_stutter_loses_its_first_copy(self):
        words = tr.words_of(words_from([(0, .2, "so"), (.2, .4, "the"), (.4, .6, "so"), (.6, .8, "the"), (.8, 1.2, "end.")]))
        self.assertEqual(sorted(tr.find_bad_takes(words)), [0, 1])

    def test_deleting_words_in_the_text_cuts_exactly_those(self):
        words = tr.words_of(SAMPLE)
        text = tr.to_text(words)
        self.assertIn("[0.0] So today we build this.", text)
        edited = text.replace("So today we build this.", "We build this.")
        gone, notes = tr.deleted_from_text(words, edited)
        self.assertEqual(gone, {0, 1})
        self.assertEqual(notes, [])
        cuts, _ = tr.cuts_for(words, gone, "deleted", margin=0.05)
        self.assertEqual(len(cuts), 1)
        self.assertAlmostEqual(cuts[0][0], 0.0)
        self.assertAlmostEqual(cuts[0][1], 0.70 - 0.05)  # 50 ms before "we"

    def test_added_words_are_refused_not_followed(self):
        words = tr.words_of(SAMPLE)
        gone, notes = tr.deleted_from_text(words, tr.to_text(words).replace("this.", "this, folks."))
        self.assertEqual(gone, set())
        self.assertTrue(notes)

    def test_plan_from_a_transcript_makes_a_checkable_edit_list(self):
        from hgedit import planner

        clip = self.p("a.mp4")
        make_clip(clip, seconds=9.0, talk=((0.0, 1.9), (3.2, 4.4), (5.0, 6.8), (7.5, 8.5)))
        with open(self.p("transcript.json"), "w") as f:
            json.dump(SAMPLE, f)
        edl, report = planner.propose(clip, SAMPLE, None, pauses=False, base_dir=self.d)
        self.assertEqual(report["filler_cuts"], 2)
        plan = plan_mod.resolve(edl, self.d)
        self.assertLess(plan["out_seconds"], 9.0 - 0.9)  # both fillers and their gaps are gone
        # the captions never show a word that was cut
        shown = " ".join(" ".join(c["lines"]) for c in plan["cues"])
        self.assertNotIn("Um", shown)
        self.assertNotIn("like,", shown)
        self.assertIn("I like tea.", shown)

    def test_the_plan_command_writes_a_fresh_edit_folder_from_the_transcript_it_is_given(self):
        clip = self.p("a.mp4")
        make_clip(clip, seconds=9.0, talk=((0.0, 1.9), (3.2, 4.4), (5.0, 6.8), (7.5, 8.5)))
        os.makedirs(self.p("elsewhere"))
        words = self.p(os.path.join("elsewhere", "words.json"))
        with open(words, "w") as f:
            json.dump(SAMPLE, f)
        out = self.p(os.path.join("fresh", "edit", "edl.json"))
        env = dict(os.environ, HG_EDIT_ENCODER="libx264")
        r = subprocess.run([sys.executable, "-I", EDIT_VIDEO, "plan", clip, "-o", out, "--transcript", words, "--json"],
                           capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(os.path.isfile(self.p(os.path.join("fresh", "edit", "transcript.json"))))
        r = subprocess.run([sys.executable, "-I", EDIT_VIDEO, "check", out, "--json"], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertGreater(json.loads(r.stdout.splitlines()[-1])["summary"]["cues"], 0)


# ── Captions ────────────────────────────────────────────────────────────────────────────────────────────────────


class Captions(Tmp):
    def test_words_are_retimed_onto_the_output_clock(self):
        clip = self.p("a.mp4")
        make_clip(clip, seconds=6.0)
        t = words_from([(0.5, 1.0, "before"), (2.5, 3.0, "hello"), (3.0, 3.5, "there."), (3.6, 4.0, "cut"), (4.0, 4.4, "me"), (5.0, 5.5, "after.")])
        edl = {"version": 1, "sources": {"a": {"path": clip}}, "keep": [{"start": 2.0, "end": 6.0}], "cuts": [{"start": 3.55, "end": 4.5}],
               "captions": {"transcript": t, "min_seconds": 0.5}}
        plan = plan_mod.resolve(edl, self.d)
        self.assertAlmostEqual(plan["out_seconds"], 4.0 - 0.95, delta=1 / FPS)
        cues = plan["cues"]
        self.assertEqual(cues[0]["lines"], ["hello there."])
        self.assertAlmostEqual(cues[0]["start"], 0.5, delta=0.01)  # 2.5 s of the source, kept from 2.0 s
        self.assertAlmostEqual(cues[0]["end"], 1.0 + 0.0, delta=0.6)
        self.assertEqual(cues[-1]["lines"], ["after."])
        self.assertAlmostEqual(cues[-1]["start"], 5.0 - 2.0 - 0.95, delta=1 / FPS)
        shown = " ".join(" ".join(c["lines"]) for c in cues)
        self.assertNotIn("cut me", shown)
        self.assertNotIn("before", shown)

    def test_cues_obey_line_length_and_stay_in_frame(self):
        words = [{"word": w, "start": i * 0.3, "end": i * 0.3 + 0.28} for i, w in enumerate("this is a fairly long sentence that has to be split across several captions without running off the screen at all.".split())]
        cues = tr.make_cues(words, max_chars=24, max_lines=2)
        self.assertGreater(len(cues), 1)
        for c in cues:
            self.assertLessEqual(len(c["lines"]), 2)
            self.assertTrue(all(len(x) <= 24 for x in c["lines"]), c)
        for c, n in zip(cues, cues[1:]):
            self.assertLessEqual(c["end"], n["start"])

    def test_the_gate_fails_a_caption_outside_the_frame(self):
        from hgedit import textfx

        o = textfx.layout_caption(["a caption"], 640, 360)
        self.assertTrue(textfx.inside(o.box, 640, 360, 0.02))
        wide = textfx.Overlay(np.zeros((40, 700, 4), np.uint8), -20, 300)
        self.assertFalse(textfx.inside(wide.box, 640, 360))


# ── Pauses ──────────────────────────────────────────────────────────────────────────────────────────────────────


class Pauses(Tmp):
    def test_dead_air_shortens_and_typing_in_a_pause_is_kept(self):
        # speech 0-2, dead pause 2-5 (a fan only), speech 5-7, pause 7-11 with typing, speech 11-13
        x = selftest.voice_track(14.0, [(0, 2), (5, 7), (11, 13)], typing=[7.5, 7.7, 7.8, 8.2, 8.3, 9.0, 9.1, 9.3, 10.2])
        act = signals.activity(np.stack([x, x]))
        self.assertEqual(len(act["speech"]), 3, act["speech"])
        cuts, kept = signals.dead_pauses(act, 0, 13.0, max_pause=0.7, keep=0.3, margin=0.12)
        self.assertEqual(len(cuts), 1)
        a, b = cuts[0]
        self.assertTrue(2.1 < a < 2.3 and 4.7 < b < 4.9, cuts)  # leaves about 0.3 s of the 3 s pause
        self.assertEqual(len(kept), 1)
        self.assertTrue(7.0 <= kept[0][0] and kept[0][1] <= 11.1)
        self.assertEqual(kept[0][2], "typing or clicking")

    def test_typing_in_a_pause_can_be_cut_when_asked(self):
        x = selftest.voice_track(8.0, [(0, 2), (6, 8)], typing=[3, 3.2, 3.4, 4, 4.2])
        act = signals.activity(np.stack([x, x]))
        cuts, kept = signals.dead_pauses(act, 0, 8.0, activity_mode="cut")
        self.assertEqual(len(cuts), 1)
        self.assertEqual(kept, [])

    def test_a_fan_does_not_hide_pauses_the_way_a_fixed_threshold_does(self):
        # the same speech over a louder fan: a fixed -45 dB silence level would find no pause at all
        for level in (0.01, 0.03):
            x = selftest.voice_track(8.0, [(0, 2), (5, 7)], fan_level=level)
            act = signals.activity(np.stack([x, x]))
            cuts, _ = signals.dead_pauses(act, 0, 7.0)
            self.assertEqual(len(cuts), 1, (level, act["speech"]))

    def test_pause_analysis_holds_a_bounded_part_of_a_long_recording(self):
        import tracemalloc  # noqa: PLC0415
        from fractions import Fraction  # noqa: PLC0415
        from types import SimpleNamespace as NS  # noqa: PLC0415
        from unittest import mock  # noqa: PLC0415

        sr, rng = signals.SR, np.random.default_rng(1)

        class File:  # stands in for half an hour of sound, decoded a second at a time: 115 MB in all
            streams = NS(audio=[None])
            __enter__, __exit__ = lambda self: self, lambda self, *a: False

            def decode(self, s):
                return (NS(pts=k * sr, time_base=Fraction(1, sr), to_ndarray=lambda: rng.normal(0, 0.01, (1, sr)).astype(np.float32)) for k in range(1800))

        same = NS(resample=lambda f: [] if f is None else [f])
        with mock.patch.object(media.av, "open", lambda p: File()), mock.patch.object(media.av, "AudioResampler", lambda **k: same):
            tracemalloc.start()
            act = signals.analyze("long.wav", 0, 0.0, 1800.0)
            peak = tracemalloc.get_traced_memory()[1]
            tracemalloc.stop()
        self.assertGreater(act["frames"], 179000)
        self.assertLess(peak, 40 << 20)

    def test_a_render_applies_it_by_frames(self):
        clip = self.p("a.mp4")
        make_clip(clip, seconds=8.0, talk=((0, 2), (5, 7)), typing=[])
        plan = plan_mod.resolve({"version": 1, "sources": {"a": {"path": clip}}, "pauses": {"max": 0.7, "keep": 0.3}}, self.d)
        self.assertLess(plan["out_seconds"], 8.0 - 2.0)
        self.assertEqual(len(plan["pauses_cut"]), 2)  # the dead pause and the trailing silence
        self.assertEqual(plan["out_frames"], sum(s["frames"] for s in plan["segments"]))


# ── Rendering ───────────────────────────────────────────────────────────────────────────────────────────────────


class Rendering(Tmp):
    def setUp(self):
        super().setUp()
        self.clip = self.p("a.mp4")
        make_clip(self.clip, seconds=8.0, talk=((0.3, 2.5), (3.5, 6.0)))

    def gate(self, edl, name="out.mp4", clean="no", **kw):
        # Cleaning the voice is a filter chain that dominates the run time; one test below keeps it on.
        edl = dict(edl, audio={"clean": clean, **edl.get("audio", {})})
        path = self.write_edl(edl, name + ".edl.json")
        out = self.p(name)
        r = render.render(path, out, workers=kw.pop("workers", 2), encoder="libx264", **kw)
        return r, verify.verify(out, path), path, out

    def test_output_frame_count_equals_the_edit_list_across_groups(self):
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 0.0, "end": 3.0}, {"start": 4.0, "end": 7.5}], "target": "youtube"}
        old = render.GROUP_MIN
        render.GROUP_MIN = 20  # force several groups from a small clip
        self.addCleanup(setattr, render, "GROUP_MIN", old)
        r, rep, _, out = self.gate(edl)
        self.assertGreater(r["groups"], 2)
        self.assertEqual(r["frames"], 36 + 42)
        checks = {c["id"]: c for c in rep["checks"]}
        self.assertEqual(checks["frames"]["status"], "pass", checks["frames"])
        self.assertEqual(checks["frames"]["got"], 78)
        self.assertTrue(rep["ok"], rep)
        info = media.probe(out)
        self.assertEqual(info["audio_tracks"], 2)  # the mastered mix and the untouched original

    def test_a_restart_reuses_finished_groups_and_a_changed_edit_does_not(self):
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 0.0, "end": 7.0}]}
        old = render.GROUP_MIN
        render.GROUP_MIN = 20
        self.addCleanup(setattr, render, "GROUP_MIN", old)
        path = self.write_edl(edl)
        out = self.p("out.mp4")
        render.render(path, out, workers=1, encoder="libx264", keep_work=True)
        r2 = render.render(path, out, workers=1, encoder="libx264", keep_work=True)
        self.assertEqual(r2["reused_groups"], r2["groups"])
        edl["titles"] = [{"text": "Hello", "start": 0.5, "end": 2.0}]
        path = self.write_edl(edl)
        r3 = render.render(path, out, workers=1, encoder="libx264", keep_work=True)
        self.assertLess(r3["reused_groups"], r3["groups"])
        self.assertTrue(verify.verify(out, path)["ok"])

    def test_the_gate_fails_when_the_output_is_not_what_the_list_says(self):
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 0.0, "end": 5.0}]}
        _, rep, path, out = self.gate(edl)
        self.assertTrue(rep["ok"], rep)
        longer = dict(edl, keep=[{"start": 0.0, "end": 6.0}])
        rep2 = verify.verify(out, self.write_edl(longer, "longer.json"))
        self.assertFalse(rep2["ok"])
        self.assertEqual(next(c for c in rep2["checks"] if c["id"] == "frames")["status"], "fail")

    def test_verifying_without_rendering_never_passes_a_video_from_an_older_list(self):
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 0.0, "end": 4.0}]}
        _, rep, path, out = self.gate(edl)
        self.assertTrue(rep["ok"], rep)
        with open(path) as f:
            rendered = json.load(f)
        # A title added after the render isn't in the video: the old video can't pass for the new list.
        self.dump_edl(dict(rendered, titles=[{"text": "Hello", "start": 0.5, "end": 2.0}]), path)
        rep = verify.verify(out, path)
        self.assertFalse(rep["ok"])
        c = next(c for c in rep["checks"] if c["id"] == "render")
        self.assertEqual(c["status"], "fail")
        self.assertIn("Render again", c["detail"])
        # The gate's own settings and the declared secrets go into no frame, so changing them needs no new render.
        self.dump_edl(dict(rendered, verify={"max_frozen": 5}), path)
        rep = verify.verify(out, path)
        self.assertTrue(rep["ok"], rep)
        self.assertEqual(next(c for c in rep["checks"] if c["id"] == "render")["status"], "pass")
        # Nor can a video changed after it was rendered, or one with no record of the list it came from.
        self.dump_edl(rendered, path)
        with open(out, "ab") as f:
            f.write(b"\0" * 16)
        rep = verify.verify(out, path)
        self.assertFalse(rep["ok"])
        self.assertIn("changed after", next(c for c in rep["checks"] if c["id"] == "render")["detail"])
        os.remove(out + ".plan.json")
        self.assertFalse(verify.verify(out, path)["ok"])

    def test_reversing_the_sources_invalidates_a_render_even_when_the_shape_is_equal(self):
        b = self.p("b.mp4")
        make_clip(b, seconds=8.0, talk=((0.3, 2.5),))  # same size, rate and length as a.mp4, so nothing else tells them apart
        edl = {"version": 1, "sources": {"a": {"path": self.clip}, "b": {"path": b}}, "audio": {"keep_original": False}}
        _, rep, path, out = self.gate(edl)
        self.assertTrue(rep["ok"], rep)
        with open(path) as f:
            rendered = json.load(f)
        self.dump_edl(dict(rendered, sources={"b": rendered["sources"]["b"], "a": rendered["sources"]["a"]}), path)
        rep = verify.verify(out, path)
        self.assertFalse(rep["ok"])
        self.assertEqual(next(c for c in rep["checks"] if c["id"] == "render")["status"], "fail")

    def dump_edl(self, edl, path):
        with open(path, "w") as f:
            json.dump(edl, f)

    def test_mastered_sound_that_is_silent_or_cannot_be_measured_fails_the_gate(self):
        quiet = self.p("quiet.mp4")
        selftest.write_recording(quiet, 3.0, FPS, (320, 180), np.zeros(3 * RATE, np.float32), scene_for(320, 180))
        _, rep, _, _ = self.gate({"version": 1, "sources": {"a": {"path": quiet}}}, "quiet.out.mp4")
        c = next(c for c in rep["checks"] if c["id"] == "loudness")
        self.assertEqual(c["status"], "fail", c)
        self.assertIn("silent", c["detail"])
        self.assertFalse(rep["ok"])
        # Unmastered on purpose: no target, nothing to fail.
        _, rep, _, _ = self.gate({"version": 1, "sources": {"a": {"path": quiet}}, "audio": {"master": False}}, "raw.out.mp4")
        self.assertEqual(next(c for c in rep["checks"] if c["id"] == "loudness")["status"], "skip")
        # Sound that would measure on the target, with a meter that can't run.
        _, rep, path, out = self.gate({"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 0.0, "end": 3.0}]}, "loud.mp4")
        self.assertTrue(rep["ok"], rep)
        real = verify.voice_clean.choose_backend

        def broken():
            raise verify.voice_clean.CleanError("This PyAV build doesn’t have the audio filters the cleanup needs.")

        verify.voice_clean.choose_backend = broken
        try:
            rep = verify.verify(out, path)
        finally:
            verify.voice_clean.choose_backend = real
        c = next(c for c in rep["checks"] if c["id"] == "loudness")
        self.assertEqual(c["status"], "fail", c)
        self.assertIn("loudness", rep["unproven"])
        self.assertFalse(rep["ok"])

    def test_the_gate_fails_black_and_frozen_stretches(self):
        black = self.p("black.mp4")
        selftest.write_recording(black, 3.0, FPS, (320, 180), selftest.voice_track(3.0, [(0, 3)]), lambda i, t: np.zeros((180, 320, 3), np.uint8))
        edl = {"version": 1, "sources": {"a": {"path": black}}, "verify": {"max_frozen": 1}}
        _, rep, _, _ = self.gate(edl, "black.out.mp4")
        ids = {c["id"]: c["status"] for c in rep["checks"]}
        self.assertEqual(ids["black"], "fail")
        self.assertEqual(ids["frozen"], "fail")
        self.assertFalse(rep["ok"])

    def test_loudness_lands_on_the_target_and_the_peak_under_the_ceiling(self):
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "target": {"name": "t", "lufs": -16, "peak": -1.5}}
        r, rep, _, _ = self.gate(edl, clean="yes")
        self.assertTrue(r["cleaned"])
        c = next(c for c in rep["checks"] if c["id"] == "loudness")
        self.assertEqual(c["status"], "pass", c)
        self.assertLess(abs(c["lufs"] + 16), 1.0)
        self.assertLess(c["true_peak"], -1.4)

    def test_titles_boxes_and_chapters(self):
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "keep": [{"start": 0, "end": 8}],
               "titles": [{"text": "Hello Hildegard", "subtitle": "a test", "start": 0.5, "end": 2.5, "kind": "title"}],
               "boxes": [{"start": 1, "end": 3, "box": [0.4, 0.3, 0.2, 0.2], "color": "#ff0000", "fill": 0.2}],
               "chapters": [{"at": 0, "title": "Start"}, {"at": 3, "title": "Middle"}, {"at": 6, "title": "End"}]}
        r, rep, path, out = self.gate(edl)
        self.assertTrue(rep["ok"], rep)
        with open(os.path.splitext(out)[0] + ".chapters.txt") as f:
            txt = f.read()
        self.assertEqual(txt.splitlines(), ["0:00 Start", "0:03 Middle", "0:06 End"])
        # the title card really is on the picture: the middle of the frame differs from the same frame with no title
        from hgedit import sheet

        got = sheet._frames_at(out, [1.0, 5.0])
        self.assertGreater(np.abs(got[1.0].astype(int)[70:110, 100:220] - got[5.0].astype(int)[70:110, 100:220]).mean(), 8)

    def test_hidden_regions_are_solid_or_blurred_in_the_pixels(self):
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "blur": [{"start": 0, "end": 8, "box": [0.0, 0.0, 1.0, 0.5], "style": "solid"}]}
        _, rep, _, out = self.gate(edl)
        from hgedit import sheet

        f = sheet._frames_at(out, [2.0])[2.0]
        self.assertLess(np.abs(f[10:80, 10:300].astype(int) - np.array([24, 24, 28])).max(), 8)  # lossy video, so near, not equal

    def test_a_vertical_target_reframes_by_cropping_not_squashing(self):
        big = self.p("wide.mp4")
        make_clip(big, seconds=3.0, size=(640, 360), talk=((0, 3),), scene=lambda i, t: _moving_block(640, 360, t, 0.75))
        for target, aspect in (("shorts", 9 / 16), ({"name": "sq", "aspect": "1:1"}, 1.0)):
            edl = {"version": 1, "sources": {"a": {"path": big}}, "target": target, "reframe": {"mode": "motion"}, "audio": {"keep_original": False}}
            r, rep, path, out = self.gate(edl, f"v{aspect:.2f}.mp4", workers=1)
            self.assertAlmostEqual(r["width"] / r["height"], aspect, delta=0.02)
            self.assertEqual(r["height"], 360)  # never scaled up past the source
            self.assertTrue(rep["ok"], rep)
        # motion mode kept the block (at 75 % across) in the 9:16 crop; a centred crop would have lost it
        from hgedit import sheet

        out916 = self.p("v0.56.mp4")
        frame = sheet._frames_at(out916, [1.5])[1.5]
        self.assertGreater((frame.min(axis=2) > 200).sum(), 200)
        edl = {"version": 1, "sources": {"a": {"path": big}}, "target": "shorts", "reframe": {"mode": "center"}}
        self.gate(edl, "centre.mp4", workers=1)
        frame = sheet._frames_at(self.p("centre.mp4"), [1.5])[1.5]
        self.assertLess((frame.min(axis=2) > 200).sum(), 20)

    def test_a_title_is_drawn_on_every_kind_of_reframe(self):
        big = self.p("wide2.mp4")
        make_clip(big, seconds=2.0, size=(640, 360), talk=((0, 2),), scene=lambda i, t: _moving_block(640, 360, t, 0.5))
        for name, edl in (("crop", {"target": "shorts", "reframe": {"mode": "center"}}), ("pad", {"target": "shorts", "reframe": {"fit": "pad"}}),
                          ("scale", {"target": {"name": "sd", "height": 180}}), ("none", {})):
            edl = dict(edl, version=1, sources={"a": {"path": big}}, audio={"keep_original": False},
                       titles=[{"text": "Hello", "start": 0.0, "end": 1.5}])
            r, rep, _, _ = self.gate(edl, name + ".mp4", workers=1)
            self.assertTrue(rep["ok"], (name, rep))

    def test_music_ducks_under_the_voice_by_the_recipe(self):
        # a music bed of two chords; the voice speaks 0.5-2.5 and 5-7 of an 8 s clip.
        music = self.p("music.wav")
        t = np.arange(int(10 * RATE)) / RATE
        bed = (0.2 * np.sin(2 * np.pi * 220 * t) + 0.2 * np.sin(2 * np.pi * 330 * t + 1)).astype(np.float32)
        from hgedit import selftest as st

        vc = self.p("voice.mp4")
        make_clip(vc, seconds=8.0, talk=((0.5, 2.5), (5.0, 7.0)))
        import wave

        with wave.open(music, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((bed * 32767).astype("<i2").tobytes())
        base = {"version": 1, "sources": {"a": {"path": vc}}, "audio": {"master": False, "clean": "no", "fade_ms": 0}}
        plan0 = plan_mod.resolve(base, self.d)
        voice_only, _, info0 = render.build_audio(plan0)
        plan1 = plan_mod.resolve(dict(base, music={"path": music, "duck_db": 16, "under_db": -8, "fade_in": 0, "fade_out": 0}), self.d)
        mixed, _, info1 = render.build_audio(plan1)
        bed_only = mixed - voice_only
        rms = lambda a, b: float(np.sqrt(np.mean(bed_only[:, int(a * RATE) : int(b * RATE)] ** 2)))  # noqa: E731
        talking = rms(1.0, 2.0)
        pause = rms(3.5, 4.5)
        drop = 20 * np.log10(pause / talking)
        self.assertGreater(drop, 14.0, drop)  # the recipe drops 16 dB
        self.assertLess(drop, 18.0, drop)
        # the music is back at full level in the pause and sits at the asked level against the voice
        self.assertEqual(info1["music"]["duck_db"], 16)
        self.assertEqual(info1["music"]["speech_stretches"], 2)

    def test_a_render_with_music_still_passes_the_gate(self):
        music = self.p("m.wav")
        import wave

        t = np.arange(int(4 * RATE)) / RATE
        with wave.open(music, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes((0.3 * np.sin(2 * np.pi * 261 * t) * 32767).astype("<i2").tobytes())
        edl = {"version": 1, "sources": {"a": {"path": self.clip}}, "music": {"path": music}, "target": "youtube"}
        r, rep, _, _ = self.gate(edl)
        self.assertTrue(rep["ok"], rep)
        self.assertEqual(r["music"]["duck_db"], 16.0)


def _moving_block(w, h, t, at):
    img = np.full((h, w, 3), 30, np.uint8)
    x = int(at * w + 30 * np.sin(t * 6))
    img[h // 2 - 30 : h // 2 + 30, x - 30 : x + 30] = 255
    return img


# ── Encoders ────────────────────────────────────────────────────────────────────────────────────────────────────


class Encoders(unittest.TestCase):
    def setUp(self):
        encoders._cache.clear()
        self.old = os.environ.pop("HG_EDIT_ENCODER", None)

    def tearDown(self):
        encoders._cache.clear()
        if self.old is not None:
            os.environ["HG_EDIT_ENCODER"] = self.old

    def test_the_first_hardware_encoder_that_works_wins(self):
        seen = []

        def probe(name):
            seen.append(name)
            return name == "h264_qsv"

        self.assertEqual(encoders.choose(None, probe=probe), ("h264_qsv", "hardware"))
        self.assertEqual(seen, ["h264_nvenc", "h264_videotoolbox", "h264_qsv"])

    def test_without_hardware_it_is_libx264(self):
        self.assertEqual(encoders.choose("auto", probe=lambda n: False)[0], "libx264")

    def test_a_named_encoder_that_does_not_work_falls_back_and_says_so(self):
        name, why = encoders.choose("h264_vaapi", probe=lambda n: False)
        self.assertEqual(name, "libx264")
        self.assertIn("h264_vaapi", why)

    def test_there_are_no_b_frames_so_group_joins_cannot_reorder(self):
        for n in ("libx264", "h264_nvenc", "h264_videotoolbox", "h264_qsv", "h264_vaapi"):
            self.assertEqual(encoders.options_for(n)["bf"], "0")


# ── The gate against a planted secret ───────────────────────────────────────────────────────────────────────────


class Gate(unittest.TestCase):
    @staticmethod
    def dump(obj, path):
        with open(path, "w") as f:
            json.dump(obj, f)

    @unittest.skipUnless(shutil.which("tesseract"), "tesseract isn’t installed, so the planted key can’t be looked for. Install it (apt install tesseract-ocr, brew install tesseract) to run this.")
    def test_fails_without_the_blur_and_passes_with_it(self):
        ok, lines = selftest.run(say=lambda s: None)
        self.assertTrue(ok, "\n".join(lines))
        self.assertIn("failed the edit without the blur and passed the edit with it", lines[-1])

    def test_without_tesseract_the_gate_says_unproven_and_can_be_made_to_fail(self):
        d = tempfile.mkdtemp(prefix="hg-edit-ocr-")
        self.addCleanup(shutil.rmtree, d, True)
        src = os.path.join(d, "r.mp4")
        info = selftest.make_secret_recording(src, seconds=3.0, secret=(0.5, 2.5))
        edl = {"version": 1, "sources": {"a": {"path": src}}, "blur": [{"start": 0.4, "end": 2.6, "box": info["box"]}], "secrets": [selftest.FAKE_KEY]}
        path = os.path.join(d, "e.json")
        out = os.path.join(d, "o.mp4")
        self.dump(edl, path)
        render.render(path, out, workers=1, encoder="libx264")
        real = shutil.which
        verify.shutil.which = lambda n, *a, **k: None if n == "tesseract" else real(n, *a, **k)
        try:
            rep = verify.verify(out, path)
            c = next(c for c in rep["checks"] if c["id"] == "ocr")
            self.assertEqual(c["status"], "skip")
            self.assertEqual(rep["unproven"], ["ocr"])
            self.assertTrue(rep["ok"])
            edl["verify"] = {"require_ocr": True}
            self.dump(edl, path)
            rep = verify.verify(out, path)
            self.assertFalse(rep["ok"])
        finally:
            verify.shutil.which = real

    def test_the_matcher_reads_through_ocr_confusions_and_masks_what_it_reports(self):
        key = selftest.FAKE_KEY
        garbled = key.replace("l", "1").replace("0", "O")
        self.assertTrue(verify.fuzzy_has(f"API_KEY = {garbled}", key))
        self.assertFalse(verify.fuzzy_has("API_KEY = nothing to see here", key))
        hits = verify.find_leaks("", "contact me at ann@example.com or 10.0.0.12 on build-01.internal", [], verify.ALL_KINDS)
        self.assertEqual({k for k, _ in hits}, {"email", "ip", "hostname"})
        for _, shown in hits:
            self.assertNotIn("ann@example.com", shown)
        self.assertEqual(verify.find_leaks("nothing here", "nothing here", [key], verify.ALL_KINDS), [])


class OcrReading(Tmp):
    """The OCR half of the gate with the frames and tesseract stood in for, so it runs without tesseract and without real
    long or 4K video: what is read, from where, how many frames are held at once, and what a failing tesseract means."""

    def setUp(self):
        super().setUp()
        self.clip = self.p("a.mp4")
        make_clip(self.clip, seconds=4.0)
        self.peak, self.times, self.widths = 0, [], []
        real_which, real_frames, real_ocr = verify.shutil.which, verify.media.video_frames, verify.ocr_text
        verify.shutil.which = lambda n, *a, **k: "/usr/bin/tesseract" if n == "tesseract" else real_which(n, *a, **k)
        self.addCleanup(setattr, verify.shutil, "which", real_which)
        self.addCleanup(setattr, verify.media, "video_frames", real_frames)
        self.addCleanup(setattr, verify, "ocr_text", real_ocr)

    def plan(self, **edl):
        return plan_mod.resolve({"version": 1, "sources": {"a": {"path": self.clip}}, **edl}, self.d, track=False)

    def frames(self, seconds, size, fps=30, bright_after=None):
        """Stands in for media.video_frames: black frames (white from `bright_after`), counting how many are alive at once."""
        w, h = size
        refs = []

        def source(path, step=None, start=0.0, end=None, size=None, pick=None):
            stop = seconds if end is None else min(end, seconds)
            i, nxt = int(np.ceil(start * fps - 1e-9)), start
            while i / fps <= stop + 1e-9:
                t = i / fps
                i += 1
                if step is not None:
                    if t + 1e-6 < nxt:
                        continue
                    nxt = max(nxt + step, t + step * 0.5)
                if pick is not None and not pick(t):
                    continue
                bright = bright_after is not None and t >= bright_after
                a = np.full((h, w, 3), 255, np.uint8) if bright else np.zeros((h, w, 3), np.uint8)
                refs[:] = [r for r in refs if r() is not None]
                refs.append(weakref.ref(a))
                self.peak = max(self.peak, len(refs))
                self.times.append(t)
                yield t, a
                del a

        verify.media.video_frames = source

    def reads(self, text_when_bright="", text_always=""):
        def ocr(png, psm=11):
            from PIL import Image  # noqa: PLC0415

            with Image.open(png) as im:
                self.widths.append(im.width)
                bright = im.getpixel((0, 0))[0] > 128
            return (text_when_bright if bright else "") + text_always

        verify.ocr_text = ocr

    def test_the_scan_decodes_with_the_log_callback_off_and_the_meter_leaves_it_as_it_was(self):
        import av.logging as avlog  # noqa: PLC0415

        seen = []
        self.frames(2.0, (64, 36))
        source = verify.media.video_frames

        def watched(*a, **k):
            for item in source(*a, **k):
                seen.append(avlog.get_level())
                yield item

        verify.media.video_frames = watched
        self.reads()
        before = avlog.get_level()
        self.addCleanup(avlog.set_level, before)
        avlog.set_level(avlog.WARNING)  # as voice_clean leaves it after a measure
        verify.ocr_check("out.mp4", self.plan(secrets=[selftest.FAKE_KEY]))
        self.assertTrue(seen)
        self.assertEqual(set(seen), {None})
        self.assertEqual(avlog.get_level(), avlog.WARNING)
        avlog.set_level(None)
        verify.measure_loudness(self.clip)
        self.assertIsNone(avlog.get_level())

    def test_a_declared_kind_is_found_without_any_blur(self):
        self.frames(4.0, (320, 180))
        self.reads(text_always="write to ann@example.com today")
        c = verify.ocr_check("out.mp4", self.plan(secrets=[{"kind": "email"}]))
        self.assertEqual(c["status"], "fail", c)
        self.assertIn("email", {x["kind"] for x in c["leaks"]})

    def test_a_declared_secret_shown_away_from_the_blur_fails_the_gate(self):
        self.frames(4.0, (320, 180), bright_after=3.0)
        self.reads(text_when_bright=f"API_KEY = {selftest.FAKE_KEY}")
        plan = self.plan(blur=[{"start": 0.5, "end": 1.2, "box": list(selftest.KEY_BOX)}], secrets=[selftest.FAKE_KEY])
        c = verify.ocr_check("out.mp4", plan)
        self.assertEqual(c["status"], "fail", c)
        self.assertTrue(all(x["t"] >= 3.0 for x in c["leaks"]), c["leaks"])

    def test_a_key_readable_just_before_its_redaction_starts_fails_the_gate(self):
        from PIL import Image  # noqa: PLC0415

        self.frames(4.0, (320, 180), bright_after=3.0)  # the key shows from 3.0 s; the redaction starts at 3.5 s

        def ocr(png, psm=11):  # the redaction's crop reads nothing; the whole frame reads the key while it shows
            with Image.open(png) as im:
                return f"API_KEY = {selftest.FAKE_KEY}" if psm == 11 and im.getpixel((0, 0))[0] > 128 else ""

        verify.ocr_text = ocr
        c = verify.ocr_check("out.mp4", self.plan(blur=[{"start": 3.5, "end": 3.9, "box": list(selftest.KEY_BOX), "style": "solid"}]))
        self.assertEqual(c["status"], "fail", c)
        self.assertTrue(any(x["t"] < 3.5 for x in c["leaks"]), c["leaks"])

    def test_scan_all_applies_the_built_in_kinds_to_every_frame_not_just_near_a_blur(self):
        self.frames(4.0, (320, 180), bright_after=3.0)
        self.reads(text_when_bright="write to ann@example.com today")  # readable from 3 s, far from a blur at 0.5 to 1.0 s
        blur = [{"start": 0.5, "end": 1.0, "box": list(selftest.KEY_BOX), "style": "solid"}]
        c = verify.ocr_check("out.mp4", self.plan(blur=blur, verify={"ocr_scan": "all"}))
        self.assertEqual(c["status"], "fail", c)
        self.assertTrue(all(x["t"] >= 3.0 for x in c["leaks"]), c["leaks"])
        c = verify.ocr_check("out.mp4", self.plan(blur=blur))  # the default scans windows only, as documented
        self.assertNotEqual(c["status"], "fail", c)

    def test_a_pattern_that_can_backtrack_for_hours_is_refused_and_long_text_is_matched_in_pieces(self):
        import time  # noqa: PLC0415

        with self.assertRaises(edl_mod.EdlError) as e:
            self.plan(secrets=[{"regex": "(a+)+$"}])
        self.assertIn("repeats a group", str(e.exception))
        t = time.monotonic()
        self.assertEqual(verify.find_leaks("a" * 200000, "", [{"regex": "a*b"}], []), [])
        self.assertLess(time.monotonic() - t, 3.0)

    def test_adjacent_overlapping_repeats_are_refused_too(self):
        for rx in ("a*a*a*a*a*b", "a+a+a+b", "(a*)(a*)(a*)b", r"\w*x\w*x\w*@"):
            with self.assertRaises(edl_mod.EdlError, msg=rx) as e:
                self.plan(secrets=[{"regex": rx}])
            self.assertIn("open-ended repeats", str(e.exception))
        for rx in ("a*a*b", r"sk-[A-Za-z0-9_-]{20,}", r"\d{3}-\d{2}-\d{4}", r"password\s*[:=]\s*\S+", r"[\w.]+@[\w.]+\.[a-z]{2,}"):
            self.plan(secrets=[{"regex": rx}])  # ordinary key patterns still pass

    def test_a_tesseract_that_fails_is_not_an_empty_read(self):
        self.frames(4.0, (320, 180))
        real_run = verify.subprocess.run
        self.addCleanup(setattr, verify.subprocess, "run", real_run)
        verify.subprocess.run = lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", (
            "Error opening data file /usr/share/tessdata/eng.traineddata\nFailed loading language 'eng'\n"
            "Tesseract couldn't load any languages!\n"))
        c = verify.ocr_check("out.mp4", self.plan(secrets=[selftest.FAKE_KEY], verify={"require_ocr": True}))
        self.assertEqual(c["status"], "fail", c)
        self.assertTrue(c.get("unproven"))
        self.assertIn("eng.traineddata", c["detail"])
        self.assertNotIn("/usr/share", c["detail"])
        c = verify.ocr_check("out.mp4", self.plan(secrets=[selftest.FAKE_KEY]))
        self.assertNotEqual(c["status"], "pass", c)
        self.assertTrue(c.get("unproven"))

    def test_4k_frames_are_held_a_few_at_a_time_and_scaled_down_for_ocr(self):
        self.frames(40.0, (3840, 2160))
        self.reads()
        plan = self.plan(secrets=[selftest.FAKE_KEY], verify={"ocr_fps": 1})
        plan["out_seconds"] = 40.0
        c = verify.ocr_check("out.mp4", plan)
        self.assertEqual(c["status"], "pass", c)
        self.assertGreaterEqual(c["frames"], 40)
        self.assertLessEqual(self.peak, 3)
        self.assertLessEqual(max(self.widths), 1920)

    def test_a_long_video_reads_a_bounded_number_of_frames_through_all_of_it(self):
        hours = 3 * 3600.0
        self.frames(hours, (64, 36))
        self.reads()
        plan = self.plan(secrets=[selftest.FAKE_KEY], verify={"require_ocr": True})
        plan["out_seconds"] = hours
        c = verify.ocr_check("out.mp4", plan)
        self.assertEqual(c["status"], "fail", c)  # a frame every 12 s can miss a key shown for 5 s: unproven, not a pass
        self.assertTrue(c.get("unproven"))
        self.assertIn("one frame every 12 s", c["detail"])
        self.assertLessEqual(c["frames"], 902)
        self.assertLessEqual(self.peak, 3)
        self.assertGreater(max(self.times), hours - 60)
        plan["verify"], plan["out_seconds"] = {}, 3600.0
        c = verify.ocr_check("out.mp4", plan)
        self.assertEqual((c["status"], c.get("unproven")), ("warn", True), c)


if __name__ == "__main__":
    unittest.main(verbosity=1)
