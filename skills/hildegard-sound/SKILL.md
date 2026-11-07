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

### A person's own voice, for a voice-over

You can't use your user's microphone from a chat, so ask Hildegard for a page that can. `record_link` with
`kind: "voice"` and a short `purpose` gives a link that works once for 30 minutes. On your user's own computer it opens
in a browser there, with nothing to set up. If they want to record on a phone, ask for `where: "phone"`: with
Hildegard's link on you get a link and a QR code to show (if the answer says the link is public, tell them so). With none
on, nothing is made; the answer gives a private route with its question, or says a phone link would be public. For a
private one, ask them the sentence word for word and call `link_on` with `confirmed: true` and the plan id only after
they say yes. A public link you can't turn on from a chat: tell them what the answer says (the Studio's “Record on your
phone” button, or `hildegard tunnel cloudflare --quick` in a terminal) and offer to record on this computer. Show your
user the link and the sentence it comes with, then call `recording_status` until it says received. The link is a secret for that person:
don't paste it anywhere else. Then `clean_voice` with the `media_id`: it takes out hum, rumble, clicks and room noise,
evens the level and sets it to -16 LUFS with the true peak under -1.5 dB (`target_lufs` and `peak` change that), and
returns the loudness it measured. Listen to the cleaned file before you use it. The cleanup chain lives in one place,
`tools/voice_clean.py`; point to that file and don't write the filters out again.

Put it over a film with `export_film` and `voiceover: { media_id }`. The film's own sound ducks 12 dB while the voice
speaks (`duck_db`), `start_seconds` and `gain_db` place and level it, and the mix is set to -14 LUFS and -1 dBTP at the
film's length. For video of a person, `record_link` with `kind: "video"`; `clean_voice` cleans its sound and keeps
the picture.

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
