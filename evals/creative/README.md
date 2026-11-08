# Creative eval: do the skills make weak models produce excellent design, video and audio work?

A blind, repeatable head-to-head for the Hildegard skills in design, video, audio and everyday writing. Donovan's bar is
that even a weak model, given the skills, should turn out amazing designs, video designs, audio work and prose. This eval
measures that: a cheap model answers a real client brief with no skills (`none`) and with the skills (`main`, or `new` for a
branch), and Claude Opus, who is not told which is which, picks the better piece. Audio and video-edit scripts are also scored
by measurement. Run it before and after any change to `skills/` and keep a change only if it wins.

## What it measures

| Domain | Tasks (tuned + held-out) | Deliverable | Scored by |
| --- | --- | --- | --- |
| design | 3 + 2: church flyer 1080x1350, album cover 1400x1400, hardware-store social square 1080x1080; 4-H sale poster 1200x1800, podcast cover | one self-contained `design.html`, rendered to PNG with Playwright's Chromium | Opus looks at both PNGs |
| video | 3 + 2: a detailer's 9:16 reel, a church Christmas Eve invitation, a woodshop film; a robotics trailer, a CSA farm ad | `plan.md`: shot list with generation prompts, camera, lens, duration, transitions, an edit decision list, a sound plan | Opus, by rubric (nothing is rendered) |
| audio | 3 + 2: clean a podcast voice, a ducked church announcement, a 15-second radio spot; clean a sermon recording, a farm voice-over | `process.sh`: ffmpeg (and sox) only, writes `out.wav` | measurement (below), then Opus reads the metrics table and both scripts |
| writing | 3 + 2: an email to a congregation, a price-change blog post, an event page; a short bio, a customer email | `draft.md` | `prose_lint.py` fails and warns; Opus picks, and lists invented facts |
| video edit | 1 (tuned only): cut four mismatched clips into a 22 to 28 second piece with titles and a music bed | `edit.sh`: ffmpeg only, writes `out.mp4` | measurement (below), then Opus reads the metrics, the script and a contact sheet of the result |

`tasks.json` is the tuned set (13 tasks). `heldout.json` holds 8 more, written now and never used for tuning: read it as
evidence, and read `tasks.json` results as the set you tune against. Every brief carries the client's facts and says "don't
ask me questions", so the eval measures making the work, not the interview.

### Media domains (`tasks-media.json`, `heldout-media.json`)

Five more domains for making pictures, sounds and motion with code. Each has 3 tuned tasks and 2 held-out ones, with real small-business,
church, family and creator briefs that carry their facts and say "don't ask me questions". They live in their own files so the first
13 + 8 tasks stay as they were; run them with `--set media` (tuned), `--set media-heldout`, or `--tasks-file a.json,b.json`.

| Domain | Tasks (tuned + held-out) | Deliverable | Scored by |
| --- | --- | --- | --- |
| photoedit | 3 + 2: a beach-retreat hero (tilt 3 degrees, cold cast, dark, 16:9); a farm-stand photo (blue-green cast, a stop under, grain, 4:5); a barn Christmas card (tilt, blown sky, 7:5); a bakery shelf (dark, yellow, noisy, square); a sanctuary slide (tilt 4 degrees, crushed shadows, cold, 4:5) | ONE script, `process.sh` (ImageMagick and/or inline Python) or `process.py` (Pillow, numpy), that writes `out.jpg` at the exact size under a byte cap | measurement against the clean photo (below), then Opus sees before, reference, and both edits |
| photocreate | 3 + 2: an Advent bulletin cover, a farm-stand logo mark, a soup recipe-card illustration; a minimalist foothills print, a VBS lighthouse | an image made by code: `art.svg`, `art.html` (rendered here by Playwright's Chromium) or `make.py` (Pillow, numpy) writing `art.png`, at the exact size | file facts (below), then Opus looks at both PNGs on craft |
| sfx | 3 + 2: a UI success chime, a page turn, 30 s of rain on a tin roof; a whoosh into a title card, a shop-door bell | `make.py` (numpy) or `make.sh` (sox, ffmpeg) writing `out.wav` | length, loudness, true peak, clipping, spectral checks per effect, then Opus reads the metrics and spectrogram PNGs (it cannot hear, and its rubric says so) |
| music | 3 + 2: a church announcement bed (30 s, 72 BPM, G major), a shop promo (30 s, 124 BPM, A major), a podcast intro (20 s, 80 BPM, A minor); a 15 s radio jingle bed (108 BPM, F major), a memorial slideshow bed (36 s, 60 BPM, E-flat major) | `make.py` or `make.sh` writing `out.wav` | length, loudness, true peak, tempo, key, dead air, no hard cut, then Opus reads the metrics, spectrogram and chromagram PNGs |
| codevideo | 3 + 2: a fire-department pancake promo (1080 x 1920), a verse card with gentle motion (1080 x 1080), a data reveal with the brief's numbers; a photo slideshow with captions from three given photos, a save-the-date | `make.py` or `make.sh` writing `out.mp4` (14 to 17 s, H.264) | duration, size, fps, size cap, black stretches, motion, OCR of the frames for every required line and for no extra number or date, then Opus sees a contact sheet of 8 frames |

## Method

- **Responders** (subscriptions only; `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are unset, and a quota or billing message stops the run):
  - `haiku`: Claude Haiku 5.5, `claude -p --model haiku --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'`, tools
    Read, Write, Bash and Skill. The arm's skills reach it as a plugin (`--plugin-dir` on a temp copy of `skills/`), the way the
    installed plugin gives them; the init event lists them as `hildegard:hildegard`, `hildegard:hildegard-art`, and so on.
    `--setting-sources ""` keeps the owner's CLAUDE.md, user skills and settings out. The `none` arm has no plugin.
  - `luna`: GPT-6 Luna, `codex exec -m gpt-6-luna -c model_reasoning_effort=low --skip-git-repo-check --ignore-user-config -s workspace-write`,
    skills in the work folder's `.agents/skills/`, which Codex reads per project. Codex also loads the owner's global skills, so
    `respond.sh` switches each off by path (`skills.config`); both arms then see only Codex's four bundled system skills plus
    the arm's own. One leak remains and is the same in every arm: `~/.codex/AGENTS.md` still loads, because Codex has no switch for it.
    The real `CODEX_HOME` is used; no auth file is read or copied.
  - The skill arms get one added sentence in the prompt telling the model to load the fitting skill and its references first. Without it
    a weak model rarely reaches for an installed skill unprompted (field note: haiku-never-loads-skills-in-claude-p-trigger-evals). `runmeta.py`
    records from each transcript whether a skill was actually loaded, and the report prints that rate. Design briefs also tell every arm
    where Chromium is, so a model can render its own work and look at it.
- **Inputs** (`make_audio.py`, reproducible): speech is a public-domain LibriVox reading of the Declaration of Independence from
  archive.org, downloaded once to `~/.cache/hildegard-creative-eval/` and pinned by SHA-256
  (`03f70357a1562ba643576d9fc846b9156c79c2af720fe3ac7721a7b275c02f85`). Segments are cut at pauses. Degradations are numpy with a fixed seed:
  60 Hz hum and four harmonics, high-passed hiss, an air-handler rumble (sermon task), level dips, room echo (an exponential
  impulse response with a hard early reflection), and loud plosive thumps clipped at full scale. The music beds, a bell sting and the
  four test clips (`ffmpeg` lavfi sources at 1280x720/30, 1920x1080/24, a 720x1280 portrait clip and 1280x720/25) are synthesized with no
  network. The clean source for each cleaning task is kept in `ref/` and never shown to a responder.
- **Audio scoring** (`score_audio.py`). The responder's script is re-run here, not trusted: in a temp folder holding only the inputs, under
  `sandbox.py` and a 120 s timeout: bubblewrap with the filesystem read-only, a tmpfs over the owner's home, `/tmp` and `/run`,
  only that folder writable, no network, new PID, IPC and UTS namespaces, no capabilities and no new privileges. Without bubblewrap it falls back to
  `unshare -rn` plus `setpriv --no-new-privs` and warns that the filesystem is then not isolated; with neither it refuses. The output is measured: integrated loudness and true peak (ffmpeg `ebur128`) against
  the brief's targets; clipped samples; for cleaning tasks the hum prominence at 60/120/180 Hz in the pauses, speech minus pause level, rumble,
  how much the quiet stretches were evened out, how far the pop was tamed, and a STOI-like fidelity against the clean reference (band-envelope
  correlation in 1/3-octave bands; documented in `stoi_like`; it ranks, it is not the standardized STOI). For mix tasks the voice and music
  files are found in the output by cross-correlation and fitted window by window, which gives the ducking depth (music gain in gaps minus
  under speech), the voice-to-music ratio while speaking, whether the lines are in order, where the sting lands, and whether the ending is a
  hard cut. Each metric becomes a pass/fail check, and the full table goes to the judge.
- **Design rendering** (`score.py`): model HTML is untrusted. Chromium gets a throwaway profile and `HOME` in a temp folder (removed afterwards), its own
  sandbox on (`--no-sandbox` only if this machine cannot run it; `chromium_sandbox` in score.json says which), and a dead proxy for every request except
  Google Fonts, loopback and IP addresses included.
- **Video-edit scoring** (`score.py`): ran, edit.sh under the same sandbox, length in range, 1280x720, 30 fps, H.264 and AAC, scene changes (ffmpeg scene score above 0.12), loudness
  within 2 LU, `blackdetect` for black stretches over half a second, and an estimate of which of the four clips appear (colour-histogram match).
- **Writing scoring** (`score.py`): `skills/hildegard/scripts/prose_lint.py --json` on the draft with front matter removed (the repo's `lint` command
  needs a built workspace; the Python lint reproduces it rule for rule). Note that the skill arms know about this lint and the `none` arm does not.
- **Media inputs** (`make_media.py`, reproducible): the photos are public-domain or CC0 pictures from Wikimedia Commons (`media-sources.json` lists
  page, license, author and SHA-256 of each), downloaded once to `~/.cache/hildegard-creative-eval/photos` (override with `PHOTOS_DIR`) and never put in git; a
  file that does not match its pin is refused. Each photo-edit input is the clean photo run through known operations with a fixed seed: a tilt of 3 to 4 degrees, a
  channel-gain colour cast, exposure in stops (linear light), a raised black point (crushed shadows), noise (luma and colour, heavier in the lights), then JPEG at q90.
  The tilt is applied to the full photo and the input is the largest window with no empty corners, so a responder meets the corners only when it straightens.
  The clean window is kept as `ref/<task>/reference.png` and is never shown to a responder. The slideshow task gets three of the photos at 1280 px wide.
- **Photo-edit scoring** (`score_media.py`, `imglib.py`): the script is re-run in a temp folder under `sandbox.py` (the same sandbox as video-edit and audio) with `PATH=/usr/bin:/bin:/usr/local/bin`
  (never `~/.local/bin`, which holds a Chrome launcher). `out.jpg` is checked for being a JPEG, the exact size, a byte cap, and empty corners. Then it is located inside
  the reference (normalized cross-correlation over crop width and offset, on blurred luma, so colour and exposure do not matter), and everything else is measured against
  that aligned reference crop: whether the named subject survived the crop; straightness (a projection-profile tilt estimate of the horizon or the vertical lines, a proxy
  read against the reference's own estimate, within 0.75 degrees; each task names the line family its photo has); white balance (distance between the log R/G and B/G ratios
  of the means; for a cast task at most 30 percent of the input's, and at most 0.05); exposure (mean luma within 0.06, clipped highlights and shadows no worse than the reference by 0.02 and 0.03);
  noise (Immerkaer's estimate, excess over the reference at most half the input's) and detail (gradient energy 0.6 to 1.35 of the reference); and SSIM against the reference crop
  (uniform 7 x 7 window, 384 px wide, lightly blurred; at least 0.75). `selftest/test_media_scorers.py` runs an oracle that undoes the known operations (it must pass every check) and a
  pass-through (it must fail white balance, exposure, straightness and denoising where the photo has them).
- **Picture scoring**: `art.svg` and `art.html` are rendered by Playwright's Chromium at the asked size, `make.py` is run and its `art.png` taken. Checks are the file facts only (rendered,
  exact size, not blank, value range, a few colours, no network references); the look is the judge's.
- **Sound scoring** (`score_sound.py`, numpy only): `out.wav` from `make.py` or `make.sh`, run as above with a 180 s limit. Every sound: length, true peak, clipping. Effects add the checks in that
  file's docstring (a chime has a clear pitch that steps upward with a fast attack and a decay; a page turn is noisy with its centroid in 1.5 to 9 kHz; rain is broadband and steady with no tonal peak and
  droplets in the 4 to 8 kHz band; a whoosh is noisy with a spectral centroid that rises at least 1.8 times then falls at least 1.5 times, peaking mid-sound; a bell has a clear pitch and rings on for a second).
  Music adds integrated loudness against the brief, dead air, a hard cut at the end, tempo (onset-flux autocorrelation with a harmonic sum; within 5 percent of the asked BPM, or of half or double it, which is
  reported as the octave), and key (chroma from spectral peaks at A = 440 with overtones removed: at least 0.85 of the energy inside the asked scale, at least 0.8 in each third, and that scale holding more energy than
  any other seven-note scale; the Krumhansl-Schmuckler estimate is reported). The judge cannot hear: it gets the metrics, a spectrogram with a loudness strip (and a chromagram for music) as a PNG, and the script,
  and its rubric says so.
- **Video scoring** (`score_media.py`): `out.mp4` from `make.py` or `make.sh` with a 300 s limit. Checks: duration in range, exact size, 24 to 60 fps, H.264 yuv420p, a size cap, no black stretch over half a second,
  and motion (the share of one-second windows with no frame change at all stays under the task's limit). Text is read with tesseract (sparse mode, also on the inverted frame when it is dark) from 14 frames across the
  piece: every required line must be found in one frame (each word within 0.8 similarity of an OCR word), and no OCR number or month or weekday that is not in the required lines may appear in two frames (a count-up task
  checks only the last three frames); the slideshow also checks every given image shows (luma correlation of 48 x 27 thumbnails). Without tesseract those checks are skipped and the result says so. The judge gets a contact sheet of 8 frames.
- **Judge** (`judge.py`): Opus (`claude -p --model opus`, no MCP, Read limited to its working folder with `Read(./**)`; a bare `Read` reads anywhere the owner can) sees each task's two deliverables in both orders as `A` and `B`, with
  file names neutralized, front matter stripped and no arm names, against a domain rubric (in the file). Each call runs in a fresh temp folder outside the eval tree that holds only those files (`A.*`, `B.*`, and for media tasks `before.jpg` and `reference.jpg`); the verdicts, which
  name the arms, are written elsewhere, and a scan refuses to call the judge if the folder holds anything else, a file name names an arm, or a file points into the eval tree. Design: the two rendered PNGs. Video:
  the two plans. Audio and video edit: the measured table, the scripts and, for video edit, a frame contact sheet. It returns the winner, the
  margin (slight or clear), the reasons, and the invented facts it found. If one arm has no usable deliverable, it wins automatically and the verdict is
  flagged `auto`; the report prints how many verdicts were automatic. A run counts only if the responder finished (a `done` file and a `meta.json` with no error): one that timed out or died
  after writing part of its deliverable is never scored or judged, loses automatically, and the report says how many verdicts had such an arm. Before the files are copied, any skill path
  (`.agents/skills/...`, `skills/hildegard-...`, `SKILL.md`), skill name or reference file name in a text deliverable becomes `[reference]`, the same way in both arms, and the scan fails the judgment if one is left.
  A skill-arm plan can still mention a Hildegard tool by name, which is a small leak.
- **Selftest**: `python3 evals/creative/selftest/test_scorers.py` runs a passthrough control and a competent reference script through the scorers;
  the controls must fail the checks they should, and the references must pass. `python3 evals/creative/selftest/test_hardening.py` checks the
  sandbox (a script that writes to the real home or outside its folder, connects out or sees `~/.ssh` fails, a normal ffmpeg script passes), the render
  isolation, run reuse keyed by the skills hash, skill-load parsing, a responder that dies, a quota message halting dispatch, and the judge's folder.
- **Not sandboxed**: the responder sessions themselves. Haiku's Bash tool runs on the host with the network (its tool list is Read, Write, Bash and Skill), and
  Codex runs with its own `workspace-write` sandbox. Only the re-run of a finished script, and the render of its HTML, is isolated.
- **Reuse**: a response is reused only while the skills it was made with are unchanged. `skills.sha` in each run folder (and `skills_hash` in meta.json) is a SHA-256 over
  the arm's skills folder; `main` is archived from `origin/main` into `skills-main-<tree>` so a moved `main` is never mixed with an old one; the report prints the hashes
  each arm used. A run from before this check has no hash, and `run.sh` makes it again.

## Run it

```sh
evals/creative/run.sh <label>                       # tuned set, none vs main, haiku and luna; resumable
evals/creative/run.sh <label> --set heldout         # the held-out set (--set heldout2: a second one, design and video)
evals/creative/run.sh <label> --cand new --base main --judge-only   # judge and report the responses already on disk; no responder runs
evals/creative/run.sh <label> --set media           # the media tuned set (media-heldout, media-both)
evals/creative/run.sh <label> --tasks-file tasks-media.json,/path/to/more.json   # any task files
evals/creative/run.sh <label> --cand new --base main   # this checkout's skills/ (or $NEW_SKILLS) against main
evals/creative/run.sh <label> --cand new --base main --new-skills ~/work/hildegard-motion/skills   # any folder of skill folders
evals/creative/run.sh <label> --only a1-podcast-clean,d1-fall-festival --models haiku
```

State lives in `~/.cache/hildegard-creative-eval/` (`runs/<arm>/<model>/<task>/`, `judge/<label>/`); delete a run folder to redo it.
A quota or billing message stops the whole run: the response exits 99, `dispatch.sh` makes xargs stop starting jobs, and a `STOP` file under `runs/` keeps later
responses from calling a model until you delete it. A responder that dies before a finished transcript leaves a `meta.json` with the error and no `done`, so it is made again.
It writes `evals/creative/results-<label>.json` and prints the summary and a design contact sheet path. Needs `claude` and `codex` signed in
with a subscription, `ffmpeg`, `numpy`, `Pillow` and Playwright's Chromium. One response per task, arm and model is about 52 responses
and 52 Opus verdicts for the tuned set.

## Reading results

Verdicts are tasks times two orders. The rate counts a tie as half. A task counts as won only when both orders agree; when they split, that is
the judge's position bias, so read it as a tie. Win rates on 3 tasks per domain are coarse: treat a domain as won when it wins outright on most of its
tasks and loses none, and use the objective metrics to see why.

## Results


### Baseline, 2026-11-07: `main` skills against no skills, tuned set (`results-baseline.json`)

One response per task, arm and model; each task judged in both orders (52 responses, 52 verdicts). Skills loaded: the `main` arm loaded a
Hildegard skill in 13 of 13 runs for both models (they were told to; the `none` arm in 0 of 13). Claude Code's own built-in skills (`artifact-design`,
`design`) are visible to every Haiku run, including `none`, and Haiku loaded `artifact-design` on the design briefs without the plugin, so for Haiku design
the baseline is not skill-free.

| Domain | Haiku 5.5: main wins of verdicts (tasks won/lost outright) | GPT-6 Luna (low): main wins of verdicts (tasks won/lost outright) |
| --- | --- | --- |
| design (3 tasks) | 3 of 6 (1/1) | 1 of 6 (0/2) |
| video plans (3) | 4 of 6 (1/0) | 4 of 6 (2/1) |
| audio (3) | 2 of 6 (1/2) | 2 of 6 (1/2) |
| writing (3) | 6 of 6 (3/0) | 2 of 6 (1/2) |
| video edit (1) | 0 of 2 (0/1) | 2 of 2 (1/0) |
| all | 15 of 26 (0.58) | 11 of 26 (0.42) |

**Read it plainly: the skills do not yet make a weak model's work reliably better.** They clearly help in two places: Haiku's writing (3 tasks
won, none lost, 2.5 invented facts per draft against 4.0, 0 prose-lint hits on both sides) and video plans (both models win 4 of 6 verdicts;
Luna's plans carry 0.5 invented facts per plan against 1.5). In design, audio and the edit script they win about as often as they lose, and
Luna's design and writing get worse with the skills (design 1 of 6, writing 2 of 6). With 1 to 3 tasks per cell, one split task moves a cell a lot; the
split tasks are position bias in the judge, so the tuned set shows direction, not size. Do not tune against this table; confirm with `--set heldout`.

Audio, measured (checks passed of 10 to 13; each script re-run with no network):

| Task | Model | none | main | What decided it |
| --- | --- | --- | --- | --- |
| a1 podcast clean | Haiku | 7/10, hum 13.1 dB, pauses 9.1 dB | 9/10, hum 0.7 dB, pauses 20.2 dB | main notched the hum and kept speech (fidelity 0.87 against 0.71) |
| a1 podcast clean | Luna | 8/10, -15.7 LUFS | 7/10, -18.8 LUFS | main used one-pass `loudnorm`; hum still 38.5 dB, no notch |
| a2 church duck | Haiku | 12/12, ducks 19.7 dB | 12/12, ducks 9.4 dB | main's ducking was gentle: bed stays under the voice but audible |
| a2 church duck | Luna | 7/12, no ducking, voice lost | 12/12, ducks 10.3 dB | main won |
| a3 radio spot | Haiku | 12/13, ducks 10.4 dB | 10/13, ducks 5.5 dB | main ducked less and ended on a 0.1 s fade |
| a3 radio spot | Luna | 10/13 | 9/13 | main's voice track was damaged (fidelity 0.29) |

Video edit: Haiku none 9/9 (eight source switches, crossfades); Haiku main 8/9 (four switches, no scene changes, fewer than five cuts); Luna none 8/9;
Luna main 9/9. No black stretches in any of the four.

Five most common failures in the `main` arm's outputs:

1. **The cleaning script misses its delivery target and the hum.** Luna's `a1` ran `loudnorm` once and shipped -18.8 LUFS against a -16 target
   (every other main script, five of six, used a measured two-pass), and it never notched the 60 Hz hum (prominence 38.5 dB, with a comment that mentions
   notch filters it does not apply). Only Haiku's `a1` notched; it reached 0.7 dB.
2. **Ducking is timid or absent.** Haiku's spot script used `sidechaincompress=threshold=0.03:ratio=4` and ducked 5.5 dB (the `ducks` check wants 6 or more);
   its church announcement ducked 9.4 dB with a ratio-6 compressor where the no-skill script used a ratio-20 compressor and ducked 19.7 dB. Luna's `a3` main
   script fed one `[voice]` label into both the sidechain and the final mix without `asplit`, which wrecked the voice track (lines found at 0.0, 0.1 and 0.97 s).
3. **Design craft slips the skills don't catch.** Luna's hardware-store square has a ruler illustration over the offer, so the main line reads
   "ANY SINGLE REGULAR-PR"; Haiku's festival flyer headline reads "Fall & Festival" through a stray gold ampersand; Luna's bluegrass title runs into the hill shape.
   Haiku rendered `check.png` in all three main design runs and still shipped the ampersand; Luna rendered none (no `check.png` in any of its design folders, in either arm).
4. **Invented copy on designs.** Luna's main flyers add "A day of good food and fall fun", "A festival favorite for all ages", "3 DAYS ONLY" and
   "Thank you for 70 years · 1955-2025" (the brief's prohibition on inventions was explicit). 1.5 invented facts per design against 1.3 with no skill.
5. **Video plans break their own rules.** Luna's Christmas Eve plan says every clip is at most 5 seconds, then makes its last shot a single 10-second
   generation ("Shot 6, full 10 s"); Haiku's plan adds "falling snow" and "one lamp post glowing in a snowy back lot", and a communion cup and plate in silver,
   none in the brief. Haiku's detailing reel changes "about three cars a day" into the voice-over line "We take three cars a day". Plans also hold shots on a model that cannot do text.

What I would try first: put the two-pass `loudnorm` recipe, a hum notch recipe and a `sidechaincompress` template with `asplit` in
`skills/hildegard/references/sound-design.md`/`hildegard-sound` as copy-paste blocks; tell the design skills to render and read the PNG once and fix collisions before finishing
and to add no copy that is not in the brief; add a 5-second-per-shot rule and "no facts beyond the brief" to the video-plan references. Those are
changes for the session that owns `skills/`; this PR changes none.

### Media baseline, 2026-11-07: `main` skills against no skills, media tuned set (`results-media-baseline.json`)

One response per task, arm and model, each judged in both orders (60 responses, 60 verdicts); `main` is `origin/main`'s `skills/` at the time of the run. State lives in
`~/.cache/hildegard-creative-eval-media` (its own `EVAL_DIR`, so it does not touch another run in the default one). The `main` arm loaded a Hildegard skill in 15 of 15 runs for both models
(it was told to; the `none` arm in 0 of 15), but Haiku read no reference file in a median run and Luna read 5. Contact sheets (kept out of git):
`contact-photo-edit-media-baseline.png`, `contact-photo-create-media-baseline.png`, `contact-motion-media-baseline.png` in the state folder; reduced copies are committed as
`baseline-media-contact-*.jpg` next to this file.

| Domain | Haiku 5.5: main wins of verdicts (tasks won/lost outright) | GPT-6 Luna (low): main wins of verdicts (tasks won/lost outright) |
| --- | --- | --- |
| photoedit (3 tasks) | 2 of 6 (1/2) | 2 of 6 (1/2) |
| photocreate (3) | 0 of 6 (0/3) | 5 of 6 (2/0) |
| sfx (3) | 4 of 6 (2/1) | 3 of 6 (1/1) |
| music (3) | 6 of 6 (3/0) | 4 of 6 (2/1) |
| codevideo (3) | 4 of 6 (2/1) | 3 of 6 (1/1) |
| all | 16 of 30 (0.53) | 17 of 30 (0.57) |

**Read it plainly: on these media tasks the skills are a wash.** Music is the one clear win for Haiku (3 of 3 tasks; its main beds read as A minor and carry
more layers, where the no-skill ones read as C major or end early), and Luna's pictures drawn in code are better with the skills (2 of 3 won, none lost). But
Haiku's pictures are worse with them (0 of 3: the judge calls `main`'s Advent cover "banded arcs [that] read as a rainbow or retro sunset", with "the hill cut[ting] the arcs off with a crude
straight edge"), and photo editing, the domain with the most measurable truth, loses 2 of 3 tasks to no skills for both models. One response per cell, so one split task moves a cell a lot: read
direction, not size, and confirm with `--set media-heldout`.

Objective checks passed (of 9 to 14 per task; each script re-run with no network), `none` / `main`:

| Task | Haiku | Luna | What decided it |
| --- | --- | --- | --- |
| p1 retreat hero | 10 / 11 of 13 | 8 / 8 of 13 | Luna turned the photo the wrong way in both arms (tilt 4.35 degrees became 5.4 and 6.1) and `main`'s output has black wedges at the edges; Haiku levelled it both times, `main` stayed cold (white-balance error 0.126 against 0.073) |
| p2 farm stand | 11 / 12 of 14 | 12 / 12 of 14 | `main` fixed the cast better (error 0.057 and 0.071 against 0.185 for both `none` outputs) but left the picture a stop dark (mean luma 0.09 low) |
| p3 barn card | 8 / 7 of 13 | 10 / 12 of 13 | Haiku replaced the sky with a synthetic gradient in both arms (luma 0.46 low, halos); Luna `main` kept the barn and sky natural (white-balance error 0.013) but left 1 degree of tilt |
| c1 to c3 pictures | 6 / 6 of 6 | 6 / 6 of 6 | file facts all pass; the judge decides on craft |
| s1 chime | 9 / 10 of 10 | 9 / 10 of 10 | both `none` chimes ended while still ringing (decay check); both `main` chimes pass |
| s2 page turn | 9 / 9 | 9 / 9 | all pass; the judge splits on how paper-like the spectrogram is |
| s3 rain | 10 / 10 | 9 / 9 of 10 | Luna `main` droplet CV 0.22 (static-like) against 0.43 for `none`; Luna `none` is 2 dB loud |
| m1 church bed | 7 / 9 of 9 | 9 / 9 of 9 | Haiku `none` made a 20.5 s piece with a cut ending |
| m2 shop promo | 9 / 9 | 7 / 9 of 9 | Luna `none` clipped (true peak +2.0 dBTP) and read as F-sharp minor |
| m3 podcast intro | 9 / 9 | 8 / 8 of 9 | Luna `none` measured 113.5 BPM against 80; Luna `main` has 1.9 s of dead air |
| v1 pancake promo | 9 / 10 of 10 | 9 / 9 of 10 | Luna's `main` shows most lines in the first seconds, then holds (54 percent of one-second windows with no change) |
| v2 verse card | 10 / 10 | 10 / 9 of 10 | Luna `main` fades all lines in within 1.5 s then barely moves (73 percent static) |
| v3 pantry reveal | 10 / 10 | 9 / 9 of 10 | Luna's counts settle correctly, but both Luna videos hold still too long (37 and 40 percent of windows); Haiku's do not (17 and 30) |

Five most common failures in the `main` arm's outputs (counts are of the 30 `main` media outputs; quotes are the judge's or the measured values):

1. **Straightening goes wrong or stops short** (3 of 6 photo edits fail the straightness check). Luna's `p1` turned the picture the wrong way: "Both edits rotated the wrong way, so the horizon is worse than before (5.4 degrees for A, 6.1 for B,
   from 4.35)", and the `main` copy "also has dark wedges down the left and right edges where the rotated image no longer covers the frame". Haiku's `p3` stayed "visibly tilted at -2.3 degrees, so the fence line and barn corner still lean";
   Luna's `p3` left 1.05 degrees.
2. **Colour and exposure do not reach the reference** (3 of 6 fail white balance, 3 of 6 exposure). Haiku's `p1` "stays cool and bluish over the water and sky"; its `p3` "replace[s] the sky with a synthetic gradient that leaves halos around the tree and
   barn and adds heavy noise" (mean luma 0.46 under the reference). The fix for a cast task is usually a gray-world gain, which removes the evening warmth along with the cast.
3. **The crop loses what the client named, or the edit is over-sharpened** (2 of 6 fail `subject_kept`, 2 of 6 `detail_kept`). Luna's `p2` main: "its crop leaves out the tomatoes, the first item the client named, and it barely removes the grain (noise
   only drops from 2.95 to 2.41)". Haiku's `p1` main is "over-sharpened and noisier (noise 9.57 against about 7.2 in the reference, detail ratio 1.2)".
4. **Motion that is not there** (3 of 6 videos fail `not_static`; all three are Luna's). The judge on Luna's `v2` main: "B fades all three lines in within about 1.5 s, and its frames barely change for most of the clip, which fails the
   not-static check (0.73 static)". The `none` videos fail this check 3 times too (Haiku `v1`, Luna `v1` and `v3`), so it is a weak-model habit the skills have not changed.
5. **Pictures drawn in code with loose construction** (Haiku `main` lost all three picture tasks). "A cup handle that floats loose from the cup and sandwich wedges that hover over the plate" in the soup card; "the sun floats loose in the top-right
   corner, and its scattered rays break up the silhouette at thumbnail size" in the farm-stand logo; the Advent cover is read as "a rainbow or retro sunset". The skills' drawing guidance is not reaching the SVG that a weak model writes.

Also seen once each: Luna's `m1` bed repeats a four-note pluck unchanged for 30 s and ends on an unresolved D pad (the judge preferred the no-skill bed); a `main` rain bed that is "a denser, more static-like broadband field".

What I would try first, for the session that owns `skills/`: tell the photo skill to measure the horizon and verticals instead of guessing the angle and to rotate-then-crop inside the valid area; to correct a cast per channel against a
neutral the picture actually has and not by gray-world; to keep the subject box in a crop; and to check the output with the same numbers the scorer uses. For code-drawn pictures, a render-look-fix loop with a layer checklist (every part touches what it
should). For motion, a staging recipe (one thing arriving per 1.5 to 2 s, an ease, a drift under everything). Those are changes for that session; this PR changes no skill.

Notes on this baseline: it was re-run after two fixes found on the first pass. The judge skipped every picture task as "no usable deliverable" (a picture drawn in code has no `ran` field), so the 12 picture verdicts were redone; and the church-bed brief
asked for a "sparse" bed whose tempo no onset-based estimator can read (four of four outputs missed), so it now asks for "a soft pulse you could tap along to" and its four runs were redone. Nothing else was rerun.

### Limits

- Three tasks per domain and one response each; the judge's position bias splits some tasks. Use the held-out set and repeat runs before believing a small gap.
- `~/.codex/AGENTS.md` loads for Luna in every arm (no switch for it). The skill arms' extra sentence is a treatment, and the none arm's Haiku sees Claude Code's built-in design skills.
- The audio decomposition assumes each source is placed once; a looped bed is scored on its first pass. `stoi_like` ranks and is not standardized STOI.
- Video-edit cut counting started as ffmpeg scene changes only, which missed crossfades; it now also counts source-clip switches. That edit to `score.py`
  came after the first scoring pass, so `e1-canoe-cut` was re-scored and re-judged and the rest were not affected.
- Media tasks: one response per cell and no repeats. The tilt estimate is a proxy (a projection profile of the photo's horizon or vertical lines, within 0.75 degrees; each task names the family its photo has) and was
  checked against rotations of the same photos, not against human labels. OCR reads stylized type over a photograph badly, so the extra-number check only counts digits at 85 percent confidence or more and allows text that is in a supplied photo.
  The tempo check reads pulsed music, not a bed that sounds once a bar. Sound and music are judged from measurements and pictures, never heard.
- Plan judging cannot test whether a prompt renders well in LTX or Wan. It tests whether the plan is complete, consistent and feasible on paper.
