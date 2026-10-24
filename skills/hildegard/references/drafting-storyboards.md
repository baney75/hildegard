# Drafting, contact sheets, storyboards and animatics

Load this for any visual piece before the final render, and for any film, animation or music video before production. The rule: **explore cheaply and wide, then commit narrowly.** Each rung below is a gate where the user can steer for the price of one reaction (pitfall 27).

## The drafting ladder (stills: paintings, posters, covers, designs)

| Rung | What | Size | How many | Gate |
|---|---|---|---|---|
| 1. Idea thumbnails | composition only, in 2–3 values; vary placement, scale, horizon, crop | about 200 px | 12–24 | pick 3; contact sheet to the user if they want a say |
| 2. Value studies | 3–5 value masses, with the light logic decided | about 400 px | 3 | it must read in grayscale (Livingstone: value carries form and depth) |
| 3. Color comps | the chosen value study in 2–4 palettes (dominant, support, accent) | about 400 px | 2–4 | **contact sheet to the user: one reaction** |
| 4. Underpainting | the full scene at final composition | about ⅓ of final | 1 | image checks at thumbnail and feed size; fix structure here |
| 5. Final | all marks at full size, the crisp layers, the finish | final | 1 | the full check in SKILL.md step 6 |

- **Generate the thumbnails in code.** Make one parameterized composition function (subject position, scale, horizon height, light direction, crop). Sample it across a grid, then lay the results out with `scripts/contact_sheet.py`. Every cell gets a code (A1, B3), so "B3 but with the horizon lower" is a complete instruction.
- **Value before color, always.** If a comp doesn't read in gray, a palette won't save it.
- **Keep the losers.** Note in `decisions.md` why each one lost. When the user dislikes the final, the second-best thumbnail is often the fix.
- **Thumbnails are for decisions, not polish.** Spend no time on detail below rung 4.
- **The masters worked this way.** Leonardo, Rembrandt and Degas made many small studies: compositional sketches, studies of single figures, of drapery (Leonardo's linen studies), of hands. Loomis's *Creative Illustration* (1947) teaches thumbnailing as the first stage of every picture.

## Contact sheets

`scripts/contact_sheet.py` makes one labeled grid from:
- **drafts and variants:** `contact_sheet.py sheet.png drafts/*.png --title "Comps v2"`;
- **a film or animation:** `contact_sheet.py sheet.png --video cut.mp4 --every 2 --scenes 0.3`. This samples every N seconds plus every detected cut, labeled with timecode and shot number;
- **storyboard panels:** one cell per panel, labeled in shot order.

Use a contact sheet:
- to show the user options (one reaction, not an essay);
- to give a blind critic the whole work at once;
- to check a film for continuity, color-script drift, blank frames and escalation;
- to compare takes or seeds of generative work.

## Storyboards (film, animation, music video, motion pieces)

**The ladder:**
1. **Beat board** (Gnomon: "the concept art before the concept art"). Make 6–12 key frames that tell the whole piece: the opening image, the turn, the climax, the final image. Render them to roughly color-comp level. This is the pitch, and the user approves it before shot-by-shot work begins.
2. **Thumbnail boards.** Draw every shot roughly, at small size, in sequence. Check continuity (screen direction, the 180-degree line, eyelines) and rhythm here.
3. **Clean boards.** For each panel:
   - the shot number, the duration, and the song-map time or script line;
   - the framing (wide, medium or close-up; the lens);
   - arrows for camera moves (push, pan, track) and for subject motion;
   - the transition out (cut, dissolve, match cut);
   - sound or lyric cues.
4. **Animatic.** The panels timed to the soundtrack. `scripts/animatic.py board.json out.mp4` holds each panel for its exact song-map duration, with optional simple camera moves, labels and burned-in timecode. Watch it with sound. This is where timing, pacing and clarity get fixed: the cheapest place to fix them.
5. **Previs (optional).** Block 3D scenes with primitives and the real camera lens in Blender, to test staging, scale and camera moves before final production.

**Principles for the boards:**
- **Bruce Block, *The Visual Story* (2nd ed., 2008).** The seven visual components (space, line, shape, tone, color, movement, rhythm) are controlled by the principle of contrast and affinity: contrast raises visual intensity, affinity lowers it. Plot planned visual intensity against the story's (or the song's) intensity curve. They should rise and fall together, with the peak shot on the peak.
- **Steven Katz, *Film Directing Shot by Shot* (1991):** staging in depth, coverage, and how storyboards serve each.
- **Joseph Mascelli, *The Five C's of Cinematography* (1965):** camera angles, continuity, cutting, close-ups, composition.
- **Mark Simon, *Storyboards: Motion in Art*:** professional board conventions, arrows, numbering and pacing.
- **From the masters:**
  - Hitchcock boarded whole films before shooting;
  - Kurosawa painted his storyboards as finished images;
  - Ridley Scott's quick "Ridleygrams" show that boards are for thinking, not for display.
- **Every panel must change something:** framing, subject, action or information. If two consecutive panels say the same thing, cut one.
- **Read the boards as the audience will.** Can a stranger follow the story from the panels alone? Show the beat board to a blind critic and ask them to retell it.

## Gates and what goes to the user

| Gate | Send | Ask for |
|---|---|---|
| After thumbnails or comps | contact sheet | one pick plus one change |
| After the beat board | contact sheet plus a one-sentence pitch | go / no-go |
| After the animatic | the MP4 | timing notes cited by timecode |
| After the underpainting or rough cut | a feed-size preview | anything structural before polish |

When the user is away (unattended), pick at each gate yourself, say which cell or version you picked and why, and keep the contact sheets in the delivery so they can redirect later.
