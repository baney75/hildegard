---
name: hildegard-music
description: Use to make music, a jingle, a bed, sound effects, ambience, binaural beats or nature soundscapes (waves, rain, wind, fire) - from recipes, rendered and loudness-checked
---

# Music and sound effects from recipes

Read **hildegard-craft** first. This skill makes instrumental music, sound effects and long soundscapes with code you
can run anywhere: `scripts/sfx.py` renders a sound effect from a JSON recipe, `scripts/music.py` renders a piece from a
JSON score, `scripts/soundscape.py` renders 10 to 60 minute seamless beds (binaural beats, isochronic tones, waves,
rain, wind, creek, crickets, fire, noise) and `scripts/sheet.py` draws a picture of any audio. All of them check their own work, so a small model that fills in the recipe carefully gets a file that is in key, in
time, unclipped and at the right loudness.

**What this is not.** It is synthesized: subtractive, FM, additive and plucked-string models, played by a sequencer.
Expect synthesized instruments, not a recorded band; it has no singing voice and no speech. Say so every time you
deliver. For a real song with a voice, write a brief for Suno or for a music model (below).

Needs Python 3.10 or newer and numpy. ffmpeg is only needed to write `.mp3` or `.ogg`. No GPU, no network, no
Hildegard server. Run the scripts from this skill's `scripts/` folder, or with their full path.

**You cannot hear, so look.** Every script takes `--sheet out.png` and draws a contact sheet: the waveform, a
spectrogram on a log frequency axis, the short-term loudness against its target, and the energy in nine octave bands,
with the sections of a piece marked. Open the PNG (an image viewer or your file reader) before you deliver and read it
with "What the sheet shows" below. `python3 scripts/sheet.py any.wav out.png` does the same for any file.

## FAST PATH

1. **Pick the closest preset or template.** `python3 scripts/sfx.py --list` and `python3 scripts/music.py --list` print
   each one with a note. Sound effects: `presets/`. Music: `templates/`. Use the tables below. If nothing is close,
   take the nearest anyway; never write a recipe from nothing.
2. **Copy it** to your working folder (`cp presets/coin.json mycoin.json`).
3. **Change only what the brief asks.** Each file has a `note` and a `vary` field that name the safe knobs. Mood words
   map to knobs through the mood table, and only through it.
4. **Check**: `python3 scripts/music.py mine.json --check` (or `sfx.py`). Fix the first ERROR and run it again. Warnings
   are for you to read; fix any that your change caused.
5. **Render**: `python3 scripts/music.py mine.json out.wav --check --sheet out.png` (add `--bits 24` for a 24-bit
   master). The command checks, then writes the file only when there is no error. `.mp3` and `.ogg` work when ffmpeg is
   installed. Look at `out.png`.
6. **Measure and deliver.** The last line printed is the measurement. Deliver the file with: what it is (synthesized),
   length, loudness and true peak as measured, and what you changed from the preset. You cannot hear it; say the
   user's ears are the final check.

Shortcuts that need no copy: `python3 scripts/sfx.py --preset coin out.wav`, `python3 scripts/music.py --template lofi out.wav`.
Music accepts `--key "D major"`, `--tempo 90`, `--length 30` and `--seed 4` to change the key (everything is written
in scale degrees and roman numerals, so it transposes), the tempo, the exact length in seconds, and the random seed.
The same recipe and seed always give the same file.

## Which one

| The brief | Start from |
|---|---|
| a UI click, toggle, pop, notification, alert, error, success | `ui_click`, `ui_toggle`, `bubble_pop`, `notification_chime`, `alarm_beeps`, `error_buzz`, `success_jingle` |
| a game sound: coin, laser, sparkle | `coin`, `laser`, `magic_sparkle` |
| a transition: pass-by, rise, hit, scene change | `whoosh`, `riser`, `impact_hit`, `swell`, `thunder` |
| footsteps, a knock, typing, a camera, a page, a heartbeat | `footsteps_wood`, `door_knock`, `typewriter`, `camera_shutter`, `page_turn`, `heartbeat` |
| ambience: rain, wind, fire | `rain_bed`, `wind`, `fire_crackle` |
| a quiet bed under a spoken announcement, a church or school video | `church_announcement` |
| a corporate, product or explainer bed | `corporate_upbeat` |
| a chill, study, cozy, cafe bed | `lofi` |
| trailer, reveal, drama, a slow build | `cinematic_swell` |
| meditation, sleep, spa, a calm scene | `ambient_pad` |
| country, folk, a cheerful rustic tune | `country_shuffle` |
| a hymn, a worship or memorial piece in four parts | `hymn_chorale` |
| a 15 second radio or ad bed | `radio_jingle_15s` |
| a lullaby, a music box, a family video | `waltz_music_box` |

| a long calming bed: ocean, rain, wind, a creek, crickets, a fire, brown or pink noise | `ocean_beach`, `rain_roof_light`, `rain_roof_heavy`, `rain_leaves`, `rain_storm_build`, `wind_gentle`, `wind_strong`, `creek`, `crickets_night`, `campfire`, `brown_noise`, `pink_noise`, `white_noise` in `soundscapes/` |
| binaural beats (headphones) or isochronic tones (speakers) | `binaural_delta_3hz`, `binaural_theta_6hz`, `binaural_alpha_10hz`, `binaural_beta_14hz`, `binaural_wind_down`, `isochronic_10hz`, `isochronic_wind_down` |
| a mix of beds | `beach_rain_alpha`, `forest_night`, `rainy_fireside` |

Other lengths: change `--length`. A bed longer than the template: set `length_s` and repeat a section by raising its
`bars` (a progression cycles to fill the bars). Bars needed = seconds x tempo / (60 x beats per bar).

## Soundscapes: long, seamless, generated

`python3 scripts/soundscape.py --list`, then `python3 scripts/soundscape.py ocean_beach out.wav --minutes 60`. Every
sound is a function of absolute time with seeded randomness, so the hour never loops and the render is chunked with flat
memory; a chunked file is byte for byte the same as a one-pass file. Rendering runs about 6 to 10 times faster than real
time. The length is exact, loudness is trimmed to the target (-20 to -26 LUFS, quiet beds), true peak is under -1 dBTP.
`references/soundscapes.md` has the recipe format, the layer types and the mixing rules.

- **Pick one preset and set the length.** `--minutes` stretches a journey's stages in proportion.
- **Mix with `gain_db`.** One bed at 0, a detail at about -8, a tone at about -12. At most four layers.
- **Binaural beats need stereo headphones.** Say so in the delivery. On speakers use the isochronic presets.
- **Make no health claim.** Never say a frequency helps sleep, focus, anxiety, pain or mood, or that it treats anything,
  and do not repeat the user's own claims as fact. Say what it is: two tones a set number of hertz apart, one per ear.
- `--check` measures the beat frequency from the finished file for each stage. A value more than 0.1 Hz off the recipe
  is an error.

## Rules for a small model

These exist because small models drift. Follow them literally.

1. **Start from a preset or template. Copy field names, pattern names and instrument names from `references/scores.md`
   and `references/recipes.md`. Never invent one.** An unknown name fails `--check` and the message lists the choices.
2. **Mood words in the brief are the only reason to change a musical choice**, and the mood table says what each one
   changes. A word that is not in the table changes nothing. Do not add a genre, an instrument or a section the brief
   did not ask for.
3. **One change, then `--check`.** Never change five things and then look.
4. **Fix the first ERROR first.** If the same error survives two tries, deliver the unmodified template and say
   what you could not do.
5. **Never claim** a recorded band, a real instrument, a voice, a famous sound or a style "in the manner of" a named
   artist or song. Never name an artist, band or tune in a recipe. The hymn template's tune is original.
6. **Never say how it sounds** ("warm, lush, beautiful"). Report the numbers and what the recipe does ("a nylon guitar
   pattern over a soft pad, 76 BPM, G major").
7. **Keep the loudness target** (music -14 LUFS, true peak -1 dBTP; effects as the preset says) unless the user names a
   platform that needs another, and then say which.
8. **No health claims, ever** (see Soundscapes). **No lyrics, no singing, no speech here.** Words belong in the Suno path below or in Hildegard's voice tools, with
   the consent rules in **hildegard-sound**.
9. **Pieces stay short** (under three minutes). For more, render sections and join them with FFmpeg
   (**hildegard-video-edit**).

## Mood table

Find each mood word in the brief and set the row's values. When two rows conflict, the first word in the brief wins.
Everything not listed stays as the template has it.

| Mood words | Template | Tempo | Key and mode | Drums | Other changes |
|---|---|---|---|---|---|
| warm, gentle, reverent, hopeful, quiet, calm voice-over bed | `church_announcement` | 66 to 80 | major: G, D or F | none or soft shaker | no melody track while someone speaks |
| upbeat, energetic, bright, corporate, modern, confident | `corporate_upbeat` | 112 to 128 | major: C or G | `corporate` or `four_floor` | keep the bell hook; mute it under speech |
| relaxed, chill, cozy, study, cafe, mellow | `lofi` | 70 to 84 | major: F or C | `lofi`, swing 0.5 | keep the 7th chords |
| epic, dramatic, tense, powerful, cinematic, trailer | `cinematic_swell` | 50 to 72 | minor: D, A or E | `epic` toms | longer `rise` for more build |
| dreamy, peaceful, meditative, sleepy, floating, spa | `ambient_pad` | 54 to 70 | lydian or major | none | fewer melody notes |
| rustic, folksy, country, cheerful, farm, barn | `country_shuffle` | 96 to 120 | major: G, D or A | `country_shuffle`, swing 0.8 to 1 | keep the violin tune |
| sacred, solemn, hymn, worship, memorial, reverent choir | `hymn_chorale` | 60 to 84 | major: D, F, G or Bb | none | keep four parts; change the tune only on chord tones |
| playful, whimsical, childlike, lullaby, sweet | `waltz_music_box` | 80 to 112 | major: F or C | `waltz_soft` or none | keep the 3/4 time |
| sad, wistful, tender, longing | `cinematic_swell` | 56 to 70 | minor: A or D | none | `rise` and `fade` only, no `peak` drums |
| suspense, mystery, eerie, uneasy | `ambient_pad` | 50 to 62 | minor or phrygian | none | `--key "E phrygian"`, a quiet bell |
| fast, driving, sporty, racing | `corporate_upbeat` | 124 to 132 | major | `four_floor` | `pulse` or `eighths` bass |
| retro, game, 8-bit | sfx presets | | | | `coin`, `laser`, `success_jingle` |

If the brief names none of these words, use the "Which one" table and change nothing else. If it needs a mood the
table lacks, say so and pick the nearest row.

## Writing a brief for Suno or a music model

When the user wants a real song, with a singer, or a sound this tool cannot make (a full band, a recorded drum
kit, a vocal), do not fake it with this tool. Write the brief instead, and say you did.

- Read the **hildegard** skill's `song-suno.md` for the method, the output contract and Suno's
  limits. It owns lyrics, hooks, hymns, the Styles box and the Exclude box. Follow it; do not restate it here.
- Fill this brief first, in plain words, from the user's request and the mood table (not from your taste):
  - **Use and length**: "45 s bed under a talk" or "3 min worship song".
  - **Form**: sections and bar counts ("8 bars intro, verse, chorus, 4 bar outro").
  - **Tempo and key**: "76 BPM, G major". Use the mood table's ranges.
  - **Instruments**: named from the instrument list in `references/scores.md` where possible ("nylon guitar, felt piano,
    upright bass, brushes"), and "no synth pads" style exclusions in the negatives.
  - **Vocal**: "instrumental" or "female, close, plain" (voice traits, never a real singer's name).
  - **Where it sits**: under dialogue (no lead melody where words are) or in front.
- **Use a score as a sketch.** Render the nearest template at the chosen tempo and key and give the user that file as
  a demo of the form and chords; the Suno prompt then names the same chords and sections.
- If Hildegard has a music model installed (`hildegard_status` and `list_presets` show it), use it with the same
  gates as the other models. The catalog's candidate and its license terms are in `references/models.md`. Nothing is
  downloaded or its license accepted on the owner's behalf; that is a `needs-owner` step. Without Hildegard, the brief
  and the sketch are the whole job.

## Going further (for a strong model)

Once the preset path works, a capable model can leave it, and keeps the same checks.

- **Write a score from scratch** with `references/scores.md`: your own sections and progressions, custom drum grids
  (`{"grid": {"kick": "x...x...", "snare": "....x..."}}`), melodies from degrees or from note lists
  (`"notes": [[0, 1, "E4"], [1, 0.5, "G4", 0.8]]`), a second melody track as a countermelody, per-section `gain_db`,
  `swing`, humanize amounts, `octave`, `attack` and `release` per track, per-track `lowcut` and `highcut`, and ducking
  under the kick (`duck` in dB). Voice-leading for four parts is automatic when a track's role is `chorale`.
- **Build a new sound effect** with `references/recipes.md`: layers of a transient, a body and a tail; pitch sweeps;
  filter cutoff curves; `events` for repeated or scattered hits; a `sample` layer from the user's own file.
- **Stems and mixes.** Mute tracks (`"mute": true`) and render each role separately for a video editor; `--seed`
  gives alternate takes. Render at `--bits 24` for a master and join pieces with FFmpeg.
- **Targets.** Change `master.loudness` for a platform (podcast -16, broadcast -23); `limit_db` bounds how hard the
  limiter may work (it tells you when a mix cannot reach its target).
- **Write a soundscape from scratch** with `references/soundscapes.md`: any mix of the ten layer types, `automation`
  curves for slow changes (rain that builds over 20 minutes), `stages` with different carriers, `--chunk` for memory,
  `--bits 24` for a master, `.mp3` for a small file.
- **Layer sound and picture.** Time effects to the cut (**hildegard-sound**, **hildegard-video-edit**); duck the bed
  under speech with `duck` on the pad or with FFmpeg sidechain.
- **Judge it as music**: does the bar count give a real phrase shape (4 or 8 bars), does the melody land on chord
  tones on the strong beats (`--check` warns when it does not), is one instrument owning each register. Replace
  whatever fails; the templates are starting points, not finished art.
- **Reference check.** The audio check snippet in the **hildegard** skill's `sound-design.md` draws a
  spectrogram and measures a file; the scripts' `--json` output carries the same numbers.

## What the sheet shows

Read the PNG from top to bottom.

| Panel | A good result | A problem and its fix |
|---|---|---|
| Waveform (top) | the body fills a steady band, with a clean fade at the end and the section lines where the sections change | a flat-topped block means clipping or over-limiting: lower `gain_db`; a huge spike means one hit dominates: lower it |
| Spectrogram | the bass and kick at the bottom, chords and melody as horizontal lines, drums as vertical lines, a gentle fade toward the top | a solid bright band under 60 Hz is rumble: lower the bass or kick `level_db`; harsh bright columns above 8 kHz are hats or noise: lower them or set `highcut` |
| Short-term loudness | close to the dashed target and steady; sections differ by a few LU on purpose | a long dip is a thin section; a rising line is a build. Fix unplanned jumps with `gain_db` per section |
| Octave bands | a gentle slope: the 125 to 500 Hz bars highest, then falling toward 16 kHz | the 60 Hz bar near the top is too much bass; a high 8 kHz bar is too bright |

A sheet shows what is in the file. It does not show whether the music is good: the user's ears decide that.

## What `--check` tells you

| Message | Meaning and fix |
|---|---|
| `unknown field (did you mean x?)` | a misspelled or invented field; use the suggestion or delete it |
| `is out of range a to b` | a value outside what the renderer accepts; use a value in range |
| `the lengths add up to N beats but a bar is M` | a melody bar is too long or short; fix the numbers after the colons |
| `melody note(s) ... are outside G major` | a warning: a note not in the key; fine only if chosen |
| `first-beat notes that are not in the chord` | a warning: a held note on beat 1 that clashes; use a chord tone |
| `clipping` | the mix goes past full scale; leave `master.normalize` on and lower `gain_db` |
| `loudness ... from the target` | peaks stop the limiter; thin the loudest layer or track, or lower the target |
| `true peak ... above the limit` | a limiter failure on a very peaky mix; lower the loudest layer |
| `the result is silent` | gains or envelopes remove all sound, or a track has no entry for the section names |
| `DC offset` | a layer sits off zero; remove a low-frequency layer or add a high-pass |

## Deliver

Give the user the file path, then: what it is (a synthesized piece or effect, not a recording), its length, its
measured loudness and true peak, the key and tempo for music, and what you changed from the preset. Offer the
`.mp3` if they need a small file. If anything is a guess, say which part. They listen and decide.
