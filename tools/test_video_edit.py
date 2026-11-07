# SPDX-License-Identifier: AGPL-3.0-only
"""Tests for tools/hgedit and tools/edit_video.py. Run: python -I tools/test_video_edit.py (the server's test suite runs this).

Clips are tiny and made here: a few seconds at 12 fps, with a voice-shaped sound, fan noise and keystrokes, so nothing is
downloaded and every test says what it proves. Hardware encoders are never tried: tests pass libx264."""

import json
import os
import shutil
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ["HG_EDIT_ENCODER"] = "libx264"

from hgedit import edl as edl_mod, encoders, media, plan as plan_mod, render, selftest, signals, transcript as tr, verify  # noqa: E402
from hgedit.media import RATE  # noqa: E402

FPS = 12


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


if __name__ == "__main__":
    unittest.main(verbosity=1)
