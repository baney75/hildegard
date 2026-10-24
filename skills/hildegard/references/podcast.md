# Podcasts and audio storytelling

Load this for podcasts, audio documentaries, interviews, radio pieces, audiobooks, spoken essays and audio dramas.

## Sources

- **Jessica Abel, *Out on the Wire* (2015):** how *This American Life*, *Radiolab*, *Planet Money* and others build stories. The focus sentence: somebody does something because ___, but ___.
- **Transom.org** (from PRX): the open manual of public-radio craft, covering structure, interviewing, tape and mixing.
- **Ira Glass on story:** the anecdote (a sequence of actions creating momentum) alternates with the moment of reflection (why it matters).
- **NPR Training** (training.npr.org): writing for the ear, sound quality, scripting.
- **Rob Rosenthal's *HowSound*:** a podcast that breaks down great audio stories.
- **Interviewing:** NPR Training's guides; John Sawatsky's method (short, open, neutral questions); Terry Gross's practice of curious, prepared follow-up.

## Formats, and when each works

- **Interview or conversation:** a guest, a host, and a question that drives the episode. Prepare questions, but follow the answers.
- **Narrative or documentary:** scripted narration and recorded tape (interviews, scenes, archival sound), built like a story.
- **Solo essay or commentary:** one voice; needs a strong script and a strong opening.
- **Panel or roundtable:** needs a moderator and clear roles, or it turns into noise.
- **Audio drama or fiction:** scripted scenes with sound design. See `sound-design.md` and `writing.md`.
- **Audiobook:** consistent voice and room, chapter files, the retailer's specs (ACX: −23 to −18 dB RMS, peaks −3 dB, noise floor −60 dB).

## The interview process (for a guest, and for the user)

This is the same Socratic craft as SKILL.md step 1, aimed at a guest:
- **Prepare** with research on the guest. Write questions that only this guest can answer.
- **Ask short, open, neutral questions:** "What happened next?" "What did that feel like?" "Walk me through that day." Avoid yes/no and double-barreled questions.
- **Ask for scenes, not summaries:** "Take me to the moment you…" Tape of a scene beats tape of an opinion.
- **Follow the heat, and let silence work.** People fill a pause with the real answer.
- **Get the person to say it in one sentence:** the line the episode will hinge on.
- **Record clean:** a quiet, soft room (closets of clothes beat bare rooms); the mic 10–15 cm from the mouth, slightly off-axis; one mic per person; a separate recording for each remote guest (double-ender); 30 seconds of room tone at the start.

## Structure

- **The focus sentence** (Abel) before scripting: who does what, why, and what stands in the way. If it can't be written, the story isn't found yet.
- **Cold open:** the most compelling tape first, in the first 30 seconds, before the intro music.
- **Anecdote, then reflection, alternating** (Glass). Each section ends with a question that pulls into the next.
- **Signposting:** the ear can't skim back, so tell listeners where they are. Recap briefly after long sections.
- **Write for the ear:**
  - short sentences, one idea each;
  - subject and verb early;
  - concrete words;
  - numbers rounded and repeated;
  - names repeated more often than on paper;
  - read every line aloud before recording.
- **Tracking:** narration recorded in the same room, mic and energy each time. Record "pickups" (fixes) in the same session if possible.
- **Endings:** land on tape or on a line that reframes the whole episode, not on a summary.

## Editing

1. **Transcribe everything** (Whisper or `whisperx`), and do a paper edit of the selects. Story first, as in `video-editing.md`.
2. **Assemble** in story order, then tighten: remove false starts, repeated ideas and dead stretches. Keep the speaker's voice and rhythm. Over-cleaned speech sounds robotic and dishonest.
3. **Ethics:** never edit someone into saying something they didn't mean. Cut for length and clarity, not to change meaning, and keep context.
4. **Ums and pauses:** remove the distracting ones. Keep pauses that carry thought or emotion.
5. **Music and sound:**
   - beds under narration, sitting low and ducked under speech (`scripts/edit.py` handles ducking for audio-only too, given a black or still-image video track);
   - "buttons" (a short musical sting) to end sections;
   - ambience to set scenes;
   - license every cue.
6. **Dialogue cleanup and mixing:** `sound-design.md` (Dialogue cleanup), then loudness to −16 LUFS (Apple ±1), true peak −1 dBTP. Use stereo at −16, or mono at −19 if measured on a stereo meter.

## Publishing package

- **Audio:** MP3 at 128–192 kbps for speech (stereo if there's stereo music), 44.1 or 48 kHz, ID3 tags (title, show, episode, artwork). Artwork is 3000×3000 px, JPEG or PNG, RGB, and readable at thumbnail size (pitfall 18).
- **Chapters** (ID3 chapter frames or Podcasting 2.0 JSON chapters) with timestamps.
- **A transcript** (accessibility and search), and captions for any video version.
- **Show notes:** a two-sentence hook, guest bio and links, sources, timestamps.
- **Video podcasts:** two or three camera angles with a cut to whoever speaks, readable lower-thirds, and short vertical clips around the strongest 30–60 seconds, with burned-in captions (`video-editing.md`).

## Checklist

- [ ] The focus sentence is written, and the cold open is the strongest tape.
- [ ] Anecdote and reflection alternate; the listener always knows where they are.
- [ ] Edits preserve meaning and voice; the cuts are inaudible; room tone fills every gap.
- [ ] Loudness is measured at −16 LUFS (±1), true peak −1 dBTP or lower, mono or stereo accounted for.
- [ ] Tags, artwork, chapters, transcript and show notes are all present.
- [ ] Every music cue and sample is licensed.
