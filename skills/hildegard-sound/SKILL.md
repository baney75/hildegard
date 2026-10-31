---
name: hildegard-sound
description: Use when asked to add or fix sound, music, voice-over, narration or a mix, or to make music or speech with Hildegard's audio models - sound design, mixing, loudness, consent for voices.
---

# Sound

Read **hildegard-craft** first. Bad sound ruins good pictures faster than anything; generic "epic" music and robotic
narration are the sound of slop.

## What Hildegard has

`hildegard_status` and `list_presets` show what's installed. Today LTX makes sound together with its video (from the
prompt: say what is heard, "rain on a tin roof, a kettle starting to whistle"); Wan makes none. Music, voice and
transcription models are on Hildegard's roadmap: when they appear in `list_presets`, use them with the same gates.
Until then, work with sound your user provides or that your own tools can make, and mix it with FFmpeg
(**hildegard-video-edit**, section 7).

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
