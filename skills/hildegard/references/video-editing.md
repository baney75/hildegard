# Video editing

Load this for any edit: a film, a music video cut, a documentary, a podcast video, a trailer, a short, a reel, a lyric video, a cutdown, or the user's own footage. Editing is where a film is finally written. Treat it as authorship, not assembly.

## Sources

- **Walter Murch, *In the Blink of an Eye* (2nd ed., 2001):** the rule of six. An ideal cut serves:
  1. emotion (51%);
  2. story (23%);
  3. rhythm (10%);
  4. eye-trace (7%);
  5. the 2D plane of the screen (5%);
  6. 3D space (4%).

  Sacrifice from the bottom up. He also writes that cuts land where a blink would: at the end of a thought.
- **Michael Ondaatje, *The Conversations* (2002):** Murch at length on sound, structure and the editor's choices.
- **Edward Dmytryk, *On Film Editing* (1984):** never cut without a reason; cut on movement; when in doubt, cut long; substance before form.
- **Sergei Eisenstein, *Film Form* (1949):** montage. Meaning comes from collision: metric, rhythmic, tonal, overtonal and intellectual montage.
- **Lev Kuleshov's effect:** the same face reads differently after different shots, so meaning lives in the juxtaposition.
- **Karen Pearlman, *Cutting Rhythms* (2nd ed., 2016):** rhythm as timing, pacing and trajectory, felt in the editor's body.
- **Thelma Schoonmaker** (Scorsese's editor) and **Sally Menke** (Tarantino's): watch their work for performance-driven cutting and audacious structure.
- **Mascelli, *The Five C's of Cinematography* (1965),** and **Katz, *Film Directing Shot by Shot* (1991):** coverage and continuity, the material the editor works from.
- **Documentary editing:** Karen Everett's *I Want to Be a Documentary Filmmaker*; Christopher Ali and colleagues on structure. Above all, the paper-edit practice: transcribe everything, then cut the story on paper.

## The editing passes

1. **Organize.**
   - Log every clip: what it is, the best takes, its timecode.
   - Sync sound to picture (by timecode, or by waveform).
   - Transcribe all dialogue and interviews (Whisper, or `whisperx` for word timing).
   - Make a contact sheet of every clip's frames (`scripts/contact_sheet.py --video`).
2. **Paper edit** (anything with speech). Cut the story from the transcript: select the lines, order them, mark the B-roll needs. This is fast to revise and keeps the story first.
3. **Assembly.** Everything in story order, long and loose.
4. **Rough cut.** Structure: what scenes, in what order, at what length. Cut whole scenes freely; the story is found here. Watch it down without stopping and note where your attention drifts.
5. **Fine cut.** Within each scene: performance, frame-accurate cut points, J- and L-cuts, rhythm.
6. **Picture lock.** No more changes to timing. Everything downstream (sound mix, grade, titles, music sync) depends on it.
7. **Finishing:**
   - the sound edit and mix (`sound-design.md`);
   - the color grade (`color.md`);
   - titles and graphics;
   - deliverables and quality control.

Watch the whole cut at every pass, with fresh eyes. Each viewing should be a real viewing, at full speed with sound, not scrubbing.

## Cutting craft

- **Every cut needs a motive:** new information, a reaction, a change of energy, a match, music, a sound. If you can't say why it's there, don't cut.
- **Cut on action.** A movement that starts in one shot and finishes in the next hides the cut (for example, a hand reaching for a door).
- **Match cuts** (shape, motion, color, sound or idea) link two places or times. Kubrick's bone becoming a satellite in *2001* is the canonical one.
- **J-cut:** the next shot's sound arrives before its picture, pulling the viewer forward. **L-cut:** the current sound continues over the next picture, so a scene lingers. Most dialogue scenes should be built from J- and L-cuts, not straight cuts.
- **Reaction shots** carry the emotion. The listener's face often matters more than the speaker's.
- **Eye-trace** (Murch): put the point of interest in the next shot near where the eye was in the last one, unless the jump is the point.
- **Continuity:** the 180-degree line, screen direction and eyelines. Break them only on purpose (a deliberate disorienting jump cut).
- **Jump cuts:** a deliberate discontinuity in one shot (Godard's *Breathless*), useful for time compression, anxiety and talking-head energy. They read as either style or mistake, so commit to the choice.
- **Cross-cutting and parallel action:** two lines intercut. Accelerate toward the moment they meet (Griffith; the baptism sequence in *The Godfather*).
- **Montage sequences:** compress time with images in rhythm, building to a result.
- **Pacing.** Tension shortens shots; reflection lengthens them. Vary shot length, because constant cutting is as numbing as none. Hold the shot on the moment that matters longer than feels safe.
- **Shot length** follows what's in the shot: a wide, busy shot needs longer to read than a close-up. Titles need (words ÷ 3) + 1 seconds.
- **First and last frames:** the first image sets the contract with the viewer, and the last one is what they keep. Choose both deliberately.
- **Cutting to music:**
  - cut on downbeats or phrase starts (the song map in `music-video.md`);
  - make sync points on hits;
  - use the music's sections for structure;
  - don't cut on every beat (avoid "Mickey-Mousing").
- **Short-form and social** (the first two seconds decide whether anyone watches):
  - open on the most striking image or line;
  - put captions on (most phone viewing is muted);
  - keep the subject inside the safe area for vertical 9:16;
  - use a hook, a payoff and a loop point if the platform loops.

## Sound in the edit

Sound is half the picture. Murch built the sound design of *Apocalypse Now* and *The Conversation*.
- **Room tone** under every dialogue edit, so there are no dead-silent gaps.
- **Dialogue first.** It must be intelligible above everything. Level it, clean it (`sound-design.md`), and cut on breaths.
- **Ambience** sets place. Change ambience at scene cuts, or carry it across a cut to bridge the scenes.
- **Sound effects** sell action and space (`sound-design.md`).
- **Music** carries emotion. Edit music on its phrases; never cut mid-phrase unless hidden by a hard effect.
- **Silence** is a tool. A sudden drop to silence is one of the strongest cuts available.

## Doing it in code

- **`scripts/edit.py edl.json`** renders an edit decision list. It handles:
  - trims, cuts, and transitions (any ffmpeg xfade type: dissolve, fadeblack, wipes);
  - speed changes, per-clip gain, stills with slow zoom;
  - a music bed ducked under dialogue by sidechain compression;
  - two-pass loudness normalization.

  It prints the record timeline. Revise the EDL and re-render; it's the editor's source of truth, like a timeline. Then check the cut with `contact_sheet.py --video cut.mp4`, at full speed with sound by the user.
- **J- and L-cuts in ffmpeg:** split audio and video. Delay or advance the audio of the next clip (`adelay`, or trimming audio separately from video), and mix it under with `amix`. For dialogue-heavy pieces, build the audio as its own track list in the EDL.
- **Frame accuracy:** trim with `-ss` after `-i` when frame accuracy matters, or re-encode, because stream-copy cuts land on keyframes. Keep one constant frame rate end to end (23.976 versus 24 and 29.97 versus 30 mismatches cause drift).
- **Assisted tools:**
  - Whisper or `whisperx` for transcripts and word timings (paper edits, captions);
  - PySceneDetect for cut detection in existing footage;
  - `auto-editor` for silence removal in talking-head material, reviewed by hand afterward;
  - OpenTimelineIO to exchange timelines with DaVinci Resolve, Premiere or Final Cut;
  - Remotion for programmatic motion graphics (its skills, when present).
- **The user's own editor** (Resolve, Premiere, Final Cut, CapCut): for heavy footage or hands-on finishing, deliver an OpenTimelineIO, EDL or FCPXML timeline plus organized media and notes, rather than rendering it here.

## Deliverables and quality control

- **Specs:** H.264 or H.265 MP4; one constant frame rate; Rec.709, or sRGB for the web; AAC 48 kHz. Use a ProRes or DNxHR master when the user will keep editing.
- **Loudness:**
  - streaming and YouTube: about −14 LUFS integrated, true peak −1 dBTP;
  - podcasts: −16 LUFS;
  - broadcast: −23 LUFS (EBU R128) or −24 LKFS (ATSC A/85);
  - Netflix: dialog-gated −27 LKFS (±2), true peak −2 dBTP;
  - always check the current spec of the destination.
- **Captions:** SRT or VTT, accurate, synced, about 32–42 characters per line, two lines at most, readable at phone size. Burn them in for social; keep them as a sidecar file for platforms that support it.
- **Quality control:**
  - `ffprobe` the result (resolution, frame rate, duration, audio);
  - make a contact sheet of the whole piece (blank frames, flash frames, wrong shots);
  - check for black frames (ffmpeg `blackdetect`) and silence (`silencedetect`);
  - run the loudness report (`ebur128`);
  - spot-check sync at five points;
  - watch the whole thing through at full speed with sound, the user doing it too.

## Checklist

- [ ] Every cut has a motive: emotion first, then story, then rhythm (Murch).
- [ ] Dialogue is intelligible everywhere, with room tone under every edit and no dead gaps.
- [ ] J- and L-cuts carry the conversations; cuts on action hide the joins.
- [ ] Pacing varies with intensity, and the key moment is held.
- [ ] The first and last frames are chosen.
- [ ] Continuity is kept, or broken on purpose.
- [ ] Loudness, true peak, frame rate, captions and contact sheet are checked; the user has watched it with sound.
