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
  `unshare -rn` (no network) and a 120 s timeout. The output is measured: integrated loudness and true peak (ffmpeg `ebur128`) against
  the brief's targets; clipped samples; for cleaning tasks the hum prominence at 60/120/180 Hz in the pauses, speech minus pause level, rumble,
  how much the quiet stretches were evened out, how far the pop was tamed, and a STOI-like fidelity against the clean reference (band-envelope
  correlation in 1/3-octave bands; documented in `stoi_like`; it ranks, it is not the standardized STOI). For mix tasks the voice and music
  files are found in the output by cross-correlation and fitted window by window, which gives the ducking depth (music gain in gaps minus
  under speech), the voice-to-music ratio while speaking, whether the lines are in order, where the sting lands, and whether the ending is a
  hard cut. Each metric becomes a pass/fail check, and the full table goes to the judge.
- **Video-edit scoring** (`score.py`): ran, length in range, 1280x720, 30 fps, H.264 and AAC, scene changes (ffmpeg scene score above 0.12), loudness
  within 2 LU, `blackdetect` for black stretches over half a second, and an estimate of which of the four clips appear (colour-histogram match).
- **Writing scoring** (`score.py`): `skills/hildegard/scripts/prose_lint.py --json` on the draft with front matter removed (the repo's `lint` command
  needs a built workspace; the Python lint reproduces it rule for rule). Note that the skill arms know about this lint and the `none` arm does not.
- **Judge** (`judge.py`): Opus (`claude -p --model opus`, no MCP, Read only) sees each task's two deliverables in both orders as `A` and `B`, with
  file names neutralized, front matter stripped and no arm names, against a domain rubric (in the file). Design: the two rendered PNGs. Video:
  the two plans. Audio and video edit: the measured table, the scripts and, for video edit, a frame contact sheet. It returns the winner, the
  margin (slight or clear), the reasons, and the invented facts it found. If one arm has no usable deliverable, it wins automatically and the verdict is
  flagged `auto`; the report prints how many verdicts were automatic. A skill-arm plan can still mention a Hildegard tool by name, which is a small leak.
- **Selftest**: `python3 evals/creative/selftest/test_scorers.py` runs a passthrough control and a competent reference script through the scorers;
  the controls must fail the checks they should, and the references must pass.

## Run it

```sh
evals/creative/run.sh <label>                       # tuned set, none vs main, haiku and luna; resumable
evals/creative/run.sh <label> --set heldout         # the held-out set
evals/creative/run.sh <label> --cand new --base main   # this checkout's skills/ (or $NEW_SKILLS) against main
evals/creative/run.sh <label> --only a1-podcast-clean,d1-fall-festival --models haiku
```

State lives in `~/.cache/hildegard-creative-eval/` (`runs/<arm>/<model>/<task>/`, `judge/<label>/`); delete a run folder to redo it.
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

### Limits

- Three tasks per domain and one response each; the judge's position bias splits some tasks. Use the held-out set and repeat runs before believing a small gap.
- `~/.codex/AGENTS.md` loads for Luna in every arm (no switch for it). The skill arms' extra sentence is a treatment, and the none arm's Haiku sees Claude Code's built-in design skills.
- The audio decomposition assumes each source is placed once; a looped bed is scored on its first pass. `stoi_like` ranks and is not standardized STOI.
- Video-edit cut counting started as ffmpeg scene changes only, which missed crossfades; it now also counts source-clip switches. That edit to `score.py`
  came after the first scoring pass, so `e1-canoe-cut` was re-scored and re-judged and the rest were not affected.
- Plan judging cannot test whether a prompt renders well in LTX or Wan. It tests whether the plan is complete, consistent and feasible on paper.
