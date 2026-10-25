# Craft, not slop

Hildegard should never produce slop. This page defines it and lists the gates that keep it out. The agent-facing
version is the **hildegard-craft** skill (`skills/hildegard-craft/`), which every other skill builds on.

## What slop is

Slop is generated work whose choices were left to the model's defaults: nobody decided what it is for, what is in the
frame, or what to cut, and nobody looked hard at it before it shipped. You can see it in the result three ways:

1. **The average look:** glossy, oversaturated, centred, glowing, waxy skin, "epic" for no reason.
2. **Mistakes nobody fixed:** melting hands, garbled lettering, flicker, faces that change between shots, frozen
   frames, blown highlights, sound that clips.
3. **Filler:** more takes, shots, words and music than the idea needs.

The full catalogue is `skills/hildegard-craft/references/slop.md`.

## The gates

| Gate | When | What does it | Where |
| --- | --- | --- | --- |
| 1. Brief | Before rendering | The agent writes who it's for, what it is, three specifics, constraints and references (qualities, not names) | hildegard-craft skill |
| 2. Prompt lint | Before rendering | `review_prompt` (MCP), and a note on every `direct_shot` | `packages/craft/src/lint.ts` |
| 3. Review | After every render | `review_take` (MCP), `GET /api/takes/:id/review`, `hildegard review <file>`: technical checks, a nine-frame contact sheet, and the rubric | `tools/review_media.py`, `packages/craft/src/rubric.ts` |
| 4. Delivery | Before showing anyone | Final-bar checks (`--final`), at most three rounds per shot, honest notes on what still fails | hildegard-craft skill |

### Prompt lint

Fails: quality words ("8k", "masterpiece", "cinematic", "trending on …"), tag salad (comma lists instead of
sentences), fewer than 12 words, stock phrases in words, lyrics and voice ("tapestry", "testament to").
Warns: camera words in the prompt when the camera field sets them, more than 140 words, negations (models draw what
they're told not to), too many beats for one shot, dashes, mood without anything visible, a named living artist.

### Technical checks

| Check | Fails when | Warns when |
| --- | --- | --- |
| `size` | Short side under 720 px for a final video (1024 for an image), 320/512 for drafts | |
| `length` | More than 15% off the length asked for | |
| `highlights` | A tenth of frames have a quarter of the picture pure white | |
| `shadows`, `contrast` | | Crushed blacks in a tenth of frames, or almost no tonal range |
| `colour` | Final, and mean saturation over 0.62 or a fifth of pixels over 0.9 | The same, on a draft |
| `black_frames` | Over a tenth of frames black, past the first and last half second | |
| `frozen` | | Over a second without motion in a shot of 3 s or more |
| `flicker` | Frame-to-frame brightness jitter over 0.03 | Over 0.015 |
| `clipping` | Peak over 0 dBFS, or over 0.01% of samples at full scale | |
| `loudness` | Louder than −9 LUFS or quieter than −30 (ITU-R BS.1770, matches FFmpeg's ebur128) | Outside −18 to −12 |

`--film` relaxes flicker at cuts for an edited film.

### The rubric

Yes or no questions about things you can point at, so a small model can answer honestly: intent, subject, a specific
detail, anatomy, text, light, motion, continuity across shots, sound and words. Each "no" comes with what to change.
The agent answers each as `id: yes|no, the frame or time that shows it`, changes one thing per round, and stops after
three rounds with an honest note.

## Skills

| Skill | For |
| --- | --- |
| hildegard | The midwife's method for any creative work: interview, research, drafts, critique, delivery |
| hildegard-craft | The bar: slop, the gates, prompting |
| hildegard-film | Films from a brief: shot list, takes, review, export |
| hildegard-video-edit | Cutting, grading, stabilising, captions, sound mixing and delivery with FFmpeg |
| hildegard-photo-edit | Photo corrections and exports with ImageMagick, and animating a photo |
| hildegard-art | Stills and series, with art direction and critique |
| hildegard-sound | Music, voice and mixing levels |
| hildegard-setup | Installing Hildegard, linking AI apps, agent access within terms |
| hildegard-cloud | Renting a GPU on Runpod |
| hildegard-3d | 3D models for screens and printing, built in code (`scripts/mesh_kit.py`) and checked view by view |
| hildegard-loop | Generate, render, critique, refine: the loop, by hand or as a coding-agent run |
| hildegard-print | Working parts to print: measured from photos and listings, sized from your printer's fits, sliced, with a print sheet (`scripts/print_kit.py`) |
| hildegard-web | Websites and web app screens as real HTML and CSS, rendered at three widths in light and dark and audited |

`hildegard skills install --json` puts them where Claude Code, Codex and OMP read them, from any model provider. Every
app linked to Hildegard also reads them over MCP (`list_skills`, `read_skill`), and [chatbots.md](chatbots.md) has the
uploads for the Claude app, claude.ai and ChatGPT.

## The loop

A piece that needs several tries goes through Hildegard's loop (`apps/server/src/loop.ts`): `loop_start` takes the
brief and targets, `loop_submit` takes a version (a 3D model, a web page or site, an image, a take or a sound) and returns Hildegard's
checks and a contact sheet, and `loop_critique` must answer every rubric question with evidence before the next round
is taken. 3D models are measured and drawn by `tools/review_mesh.py`: watertight, manifold, winding, volume, bodies,
debris and size, and for prints units, bed, base, overhang and balance, on a sheet of eight views, a top or bottom
view and silhouettes; print loops also measure fits between parts, likeness to a photographed outline, and slice
every passing round (`apps/server/src/printer.ts`). Web pages are opened in a browser cut off from the network and
audited at phone, tablet and desktop width, light and dark (`apps/server/src/web-review.ts`, `tools/review_web.js`).
Making parts and sites: [make.md](make.md). `hildegard loop run codex "<idea>"` hands a whole loop to a coding agent, within its terms.
