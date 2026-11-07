---
name: hildegard-sound
description: Use when asked to add or fix sound, music, voice-over, narration or a mix, or to make music or speech with Hildegard's audio models - sound design, mixing, loudness, consent for voices.
---

# Sound

Read **hildegard-craft** first. Bad sound ruins good pictures faster than anything; generic "epic" music and robotic
narration are the sound of slop.

## What Hildegard has

`hildegard_status` and `list_presets` show what's installed; `list_voices` shows the voices.

- **Speech:** `speak` turns a script into speech on the owner's GPU, in a voice from `list_voices`. Act a line with
  tags in square brackets (`[whispers]`, `[laughs]`) and `[pause 0.5s]`; give one line of `direction` ("warm, close
  to the mic"). `design_voice` makes a new voice from a description, and `keep_designed_voice` saves it.
- **Changing and reading speech:** `convert_voice` says a recording in another voice, `transcribe` turns speech into
  text with timings, and `dub` does both into another language. Long jobs return an id: poll `voice_job_status`.
- **Cloning a real person's voice** happens only in the Studio, with that person reading a fresh consent line aloud.
  `clone_voice` explains it; you can't start one. Never imitate a real person's voice any other way.
- **Sound with picture:** LTX makes sound together with its video, from the prompt: say what is heard ("rain on a
  tin roof, a kettle starting to whistle"). Wan makes none.
- **Music:** Hildegard has no music model. Use music your user provides or a library track with a license that
  allows the use, write a brief for a music model they run elsewhere (below), and mix it with FFmpeg
  (**hildegard-video-edit**, section 7).
- If a voice model isn't installed, `install_voice_model` downloads it. Its first call returns the license terms:
  show them to your user word for word, and call again with `accept_license` only if they say yes.

## Music

A music brief, not a mood word:

- **Form and length:** "45 s: 8 bars intro, verse, lift at 0:28 on the door opening, ring out".
- **Tempo and key:** "78 BPM, D minor".
- **Instruments:** "felt piano, upright bass, brushed snare, no synth pads".
- **Era or scene:** "late-night jazz club, 1958", by qualities, not by an artist's name.
- **Where it sits:** under dialogue (sparse, no lead melody where words are) or in front (a music video).

Lint lyrics with `review_prompt` and `medium: "music"`: stock lines ("set me free", "into the night") are slop. Write
lyrics from one concrete scene.

## Voice

- **Consent first.** Never clone or imitate a real person's voice without their clear permission. Refuse and say why.
- Write for speaking: short sentences, one idea each, punctuation where a breath goes. Read it aloud in your head.
- Lint narration with `review_prompt` and `medium: "voice"`.
- Generate line by line, so a bad line can be redone alone. Listen to every line; re-generate any that are flat,
  rushed or mispronounced.

## Sound design

Every shot has a sound even if nothing "happens": a room tone, wind, distant traffic. Silence reads as broken. Layer:

1. **Ambience** for the place, continuous across cuts in the same place.
2. **Effects** for things we see (footsteps, a door, a cup set down), in sync with the frame.
3. **Music and voice** on top.

Change the ambience exactly on the cut when the place changes; overlap it a few frames (a J or L cut) to carry the
viewer across.

## Mix and master

- Speech is the reference: everything else sits under it.
- Fades of 5 to 20 ms at every audio edit.
- Duck music under speech (sidechain, see hildegard-video-edit).
- Master to about -14 LUFS integrated, true peak under -1 dB (speech-only: -16 LUFS) with the two-pass loudnorm.
- Check: `hildegard review final.mp4 --audio` (or a `.wav`). `clipping` or `loudness` failing means fix the mix, not
  the limiter.

## Deliver

Listen through once, start to end, before you say it's done. Tell your user what is in the mix, its loudness, and
where any sound came from (generated, their files, a library and its license).
