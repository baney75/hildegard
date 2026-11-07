# Each Hildegard skill, uploaded alone

claude.ai and ChatGPT take one skill folder per zip (`skill-<name>.zip` from `node scripts/pack-skills.mjs`). This is
what each skill needed from outside its own folder when opened alone, and what was done. Found by packing the skills at
795677a, unzipping each zip in its own empty folder, and listing every link, `scripts/` or `references/` path, script
and Hildegard tool or command its files name that is not inside that folder. `node scripts/skill-standalone.mjs` repeats
the file checks, and `packages/agents/test/skills-standalone.test.ts` holds them in CI.

## What failed, by skill

| Skill | Missing thing | How used | Fix |
| --- | --- | --- | --- |
| hildegard-blog | `scripts/prose_lint.py`, `prose_rules.json` | "in the **hildegard** skill's folder" (Fast path step 4) | Bundled from `skills/hildegard/scripts` (SHARED.json). Step 4 runs `python3 scripts/prose_lint.py draft.md` |
| hildegard-blog | `writing_voice*`, `site_post`, `site_publish`, `lint_writing`, `hildegard lint` | the voice file, samples, edit log and posting, all through Hildegard | Each step now says "With Hildegard linked: <tool>. Without Hildegard: <steps>": `voice.md`, `samples/`, `edits/` beside the project, a `<slug>.md` post with its top block |
| hildegard-design | none by path (`hildegard-art` is a name) | render already used `chromium --headless` | Added the no-browser fallback (`npx playwright screenshot`, or hand over unrendered and say so), and the image step's "Without Hildegard" |
| hildegard-3d | `references/sculpture-3d.md`, `references/figure-anatomy.md` of the hildegard skill; `read_skill hildegard` | "Read first" block | Names only ("the hildegard skill, if you have it"); `references/slop.md` bundled |
| hildegard-3d | `loop_start`, `loop_submit`, `loop_critique`, `loop_finish`, `printer_profile`: the measuring and the sheet | every round | Bundled `scripts/review_mesh.py` (from `tools/`); the round is a `spec.json` plus one command, with `brief.md` and `rounds.md`; print clearance defaults inline |
| hildegard-print | `scripts/mesh_kit.py` (hildegard-3d's) | `from mesh_kit import *` in `references/parts-and-fits.md` | Bundled from hildegard-3d |
| hildegard-print | `printer_profile`, `loop_*`, the slicer step, `THIRD_PARTY_NOTICES.md` | printer, fits, likeness and slice per round, the print sheet | Bundled `review_mesh.py` (fits, clearance, views, print pose, STL export); `print-job/printer.json`; slicing by the person's slicer; `print-sheet.md` written by hand; the print3d MIT notice shipped as `references/print3d-license.md` |
| hildegard-openscad | `openscad_status`, `loop_*`, `printer_profile`; renders only through Hildegard | sections 1, 4 to 6, 8 | `openscad --version`, `openscad -o round.stl main.scad`, `review_mesh.py` bundled |
| hildegard-loop | `loop_*`, `hildegard loop run`, `docs/agent-terms.md`; the checkers | the whole skill | A "loop by hand" section (`brief.md`, `rounds.md`, `review_mesh.py`, `review_media.py`, `contact_sheet.py` bundled); the docs path became a URL |
| hildegard-web | `site_*`, `loop_*`; the render and the audit | sections 0, 3, 4, 5 | Files in `site/`, templates and `references/tokens.css` already inside; a Playwright loop for three widths and both themes; the check table kept as the audit list; an offline `grep` |
| hildegard-film | `hildegard_status`, `list_presets`, `direct_shot`, `make_sequence`, `export_film`, `hildegard review` | rendering | The Fast path plan already stands alone; added what to hand over without Hildegard; `review_media.py` and `contact_sheet.py` bundled for clips the person brings back |
| hildegard-art | `hildegard_status`, `list_presets`, `make_image`, `review_prompt`, `review_take`, `hildegard review`; "read hildegard-craft first" | sections 1 to 3 | The image tool at hand; a prompt check against the bundled `references/slop.md`; `review_media.py` and `contact_sheet.py` bundled |
| hildegard-photo-edit | `hildegard review` (CLI), `make_image`, `direct_shot`, `review_take` | check each step; sections 6, 7 | ImageMagick steps were already first-class; review through bundled `review_media.py` and `contact_sheet.py`; sections 6 and 7 say what to do without |
| hildegard-craft | `review_prompt`, `review_take`, `export_film`, `speak`, `hildegard review` | the four gates | Bundled `review_media.py` and `contact_sheet.py`; prompt check against `references/slop.md` and `prompting.md` |
| hildegard-video-edit | `scripts/clean_voice.py`, `duck_mix.py`, `spot.py` (hildegard-sound's); `hildegard review`; `transcribe` | Fast path steps 1 to 3, section 7 | Three scripts bundled from hildegard-sound; the sheet and checks through `contact_sheet.py`, `review_media.py`, `check_video.py` |
| hildegard-sound | `cut_reel.py` (hildegard-video-edit's); `review_prompt`; `hildegard review`; speech tools | Fast path step 4, Music, Voice, Mix | Name-only pointer; lyric and narration lint against the bundled `references/slop.md` Sound section; `measure.py` is the check; the Hildegard section says what to use without |
| hildegard-setup | `docs/agents.md`, `docs/chatbots.md` | "section B", "section C" | URLs and "the guide"; a "Without Hildegard" start (the install line) |
| hildegard-cloud | the `hildegard cloud` command | every step | Says plainly what can and cannot be done without Hildegard installed |
| hildegard (router) | none by path (its scripts and references are inside) | | One sentence: everything else works alone with Python and FFmpeg |

## What is shared, and from where (`skills/SHARED.json`)

One source each; `node scripts/sync-skill-shared.mjs` copies it, and `node scripts/check-skills.mjs` fails when a copy
differs.

| Source | Copied into |
| --- | --- |
| `skills/hildegard/scripts/prose_lint.py`, `prose_rules.json` | hildegard-blog |
| `skills/hildegard/scripts/contact_sheet.py` | art, craft, film, loop, photo-edit, video-edit |
| `tools/review_media.py` | art, craft, film, loop, photo-edit, video-edit |
| `tools/review_mesh.py` | 3d, loop, openscad, print |
| `skills/hildegard-3d/scripts/mesh_kit.py` | print |
| `skills/hildegard-sound/scripts/clean_voice.py`, `duck_mix.py`, `spot.py` | video-edit |
| `skills/hildegard-craft/references/slop.md` | 3d, art, film, loop, photo-edit, sound, video-edit, web |
| `skills/hildegard-print/references/print3d-license.md` | 3d, loop, openscad |

## Not done, on purpose

- hildegard-film cannot render without Hildegard's models. It hands over the plan and reviews what comes back.
- `tools/review_web.js` runs inside Hildegard's own browser harness, so hildegard-web audits by the written check list
  and Playwright screenshots, not by a script.
- hildegard-design does not call `prose_lint.py`: its copy deck is the person's own words. Add `hildegard-design` to the
  `prose_lint.py` entry in `skills/SHARED.json` if a lint step is added to it.
- Header comments inside `.py` files still say "see THIRD_PARTY_NOTICES.md". They are comments in the shared sources, not
  instructions; the print3d notice is shipped as a file where a skill carries print3d's method.
- `review_media.py` imports PyAV even for a still image, so the skills say `pip install av numpy pillow`.
- hildegard-blog's no-Hildegard edits were swept into 48092d6 by another session's commit, so they are in history
  under that message.
