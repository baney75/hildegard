# Film and animation production

Loaded by Hildegard step 5b. Editing craft is in `video-editing.md`, sound in `sound-design.md`, grading in `color.md`, boards and animatics in `drafting-storyboards.md`.

## Production (from the original 5b)

**Plan the shots before code or cuts.** One row per shot:
- duration;
- camera (vanishing point; wide, close or POV; movement);
- action;
- wardrobe and grade;
- color-script swatch;
- where the motif hides and what event reveals it;
- sound cues.

Check every row against the standing requirements. After every note, re-check all shots, not just the one mentioned.

**Composition inside the frame:**
- the rule of thirds as a starting point;
- headroom, and lead room in the direction of a look or movement;
- leading lines;
- layered depth (foreground, middle ground, background);
- frames within frames (doors, windows);
- negative space for loneliness;
- symmetry for order or confinement.

**Continuity and cutting:**
- **Continuity:** the 180-degree rule, matching eyelines, consistent screen direction.
- **Cutting:** cut on action; motivate every cut; use match cuts to link ideas; use J- and L-cuts so sound leads or trails the picture.
- **Meaning by juxtaposition (Kuleshov).** The meaning lives between shots.
- **Murch's priorities:** emotion, then story, then rhythm, before continuity.
- **Rhythm:** vary shot length with tension; hold on the moment that matters; accelerate into a montage.
- **Camera moves need a motive.** A slow push-in means intimacy or dread.
- **Titles:** inside the safe area, on screen for at least (words ÷ 3) + 1 seconds.

**Arc in the grade.** Wardrobe and grade darken until the turn, then light with a source (for example dawn through a window) at the resolution. Use wide shots for isolation, close-ups for pressure, and POV for the personal turn. Reveal hidden things with motivated events (lightning, headlights, a car horn, dawn), following pitfalls 11 and 12.

**Screens look real:** a status bar, real app layouts, avatars, timestamps, notification cards. Use the user's text word for word.

**Modesty:** cover nudity deliberately by staging (frosted glass high enough, framing, steam), and check every frame of those shots.

**Architecture** (one self-contained HTML file):
- a deterministic `render(t)`, seeded, with no `Math.random()` at draw time;
- a play loop, a seek bar and a poster frame;
- a `window.__render(t)` hook that the idle loop can't overwrite (set a `started` flag inside it);
- backgrounds pre-painted once into offscreen canvases, with figures and crisp details drawn every frame;
- figures lit through an offscreen layer composited with `source-atop`.

**Sound for film:** sound effects only, unless the user wants speech. Synthesize them with Web Audio from per-shot event lists on the picture's timeline, with ambience per scene and a quiet pad under the turn. Render the MP4's audio with `OfflineAudioContext`. 5c's craft applies.

**Encode:**
- Playwright frames at 30 fps;
- `libx264 -preset veryfast -crf 18 -pix_fmt yuv420p`;
- two-pass `loudnorm` (I=-16, TP=-1.5, LRA=14, using the measured values);
- then `alimiter=limit=0.6:attack=1:release=60:level=false`, because AAC overshoots the true peak;
- write ffmpeg durations as `0.8`, never `.8`.



## Checks (from the original step 6)

1. A contact sheet (a frame every one to two seconds, plus every shot boundary), checked against all the standing requirements and the color script.
2. 100% crops of hands, contact points, faces, light sources and text.
3. A "weird things" pass: blobs, stamped shapes, floating or intersecting limbs, stray dots, props facing the wrong way, sourceless light, painted shadows, continuity breaks (the 180-degree rule, screen direction).
4. Checks on the final MP4 itself: frames at key timestamps, sync (thunder on the flash), duration, loudness.
