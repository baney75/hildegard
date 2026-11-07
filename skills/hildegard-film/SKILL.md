---
name: hildegard-film
description: Use when asked to make a video, scene, short film, ad, music video or animated photo on the user's own GPU with Hildegard's tools (direct_shot, make_sequence, review_take, export_film).
---

# Directing a film with Hildegard

## Fast path: a production plan someone can shoot

When the request is a plan (a shot list, prompts, an edit and a sound plan) rather than rendering right now:

1. **Facts first.** List every fact the brief gives: names, what happens, numbers, places, lines to be spoken. The
   voice-over and on-screen text use only these, in the person's own words. "About three cars a day" stays "about
   three cars a day"; don't turn an estimate into a promise or add a claim.
2. **Set the limits once, then obey them.** Write the total length, the aspect, and the longest single generation the
   model makes (`list_presets` gives each model's `maxSeconds`: LTX-2.5 and LTX-2 make up to 10 s, Wan 2.2 up to 5 s;
   a longer shot is two generations joined on a cut or a match). Every shot in
   the list must fit them; add the shot lengths and check they sum to the total.
3. **One shot, one idea.** For each shot: what we see, the camera (body, lens, height, move), the light, the length,
   and the prompt for the model, written as one concrete paragraph: subject, action, place, light, camera, then what
   is heard. No "cinematic", "stunning", "epic".
4. **An arc, not a row of shots.** Open, build, peak, close. Vary the shot size (wide, medium, close), the angle and
   the move from shot to shot, and let the lengths vary with what each shot holds (a reveal longer, a beat shorter).
   Every shot changes something: a new action, a new place, a new light. The last shot moves or lands; it doesn't
   just hold still.
5. **Continuity.** The same person, clothes, place and time of day carry from shot to shot unless the story changes
   them; name them the same way in every prompt.
6. **Edit and sound.** Cuts in order with their reason (on action, on a look), the music's shape against the cuts,
   the voice-over timed to shots, and the ambience under each place.
7. **Check before you hand it over:** every spoken line and on-screen fact is in the facts list; every shot is within
   the model's limit; the lengths add up; nothing contradicts an earlier rule in your own plan.


You direct; Hildegard renders on your user's GPU through ComfyUI. If you have **hildegard-craft**, read it first: its
gates apply to every step here (`references/slop.md` here is its slop catalogue). Tools are Hildegard's MCP tools; if
they aren't available, tell your user to run `hildegard connect <your app>` (see the hildegard-setup skill).

**Without Hildegard** nothing here renders, but the work is still useful. Do the Fast path above and hand over the
plan: the facts list, the shot list with a prompt for each shot, the cut and the sound plan. Name the prompts' camera
and light in plain words, since the preset ids exist only in Hildegard. Your user pastes the prompts into whatever
video tool they have, or installs Hildegard. For each clip they bring back, run the checks in step 6 below and answer
the same questions. For cutting and sound, the **hildegard-video-edit** skill.
## 1. Find out what you have

1. With Hildegard linked: `hildegard_status`, which models are installed and what's rendering. No model installed:
   offer `install_model` and show the license it returns word for word; install only on a clear yes from your user.
2. `list_presets`: camera bodies, lenses, focal lengths, moves, lighting, palettes, genres, eras, aspects. Use only
   ids from this list.

## 2. Brief and shot list (Gate 1)

Write the brief from hildegard-craft. Then a shot list, one line per shot:

```
1. WIDE, static, 28mm f/8. The empty bakery before dawn; one light on behind the counter. (4 s)
2. MEDIUM, dolly-in 0.4, 50mm f/2. Mara ties her apron and looks at the clock. (4 s)
3. CLOSE, static, 85mm f/1.8. Her floury hands press dough on the dark wood counter. (3 s)
```

- Each shot has one action and a reason to exist. Vary size between consecutive shots (wide, medium, close).
- Keep `lighting`, `palette`, `camera_body` and `era` the same across a scene unless the story changes.
- Write a continuity list (people, places, light) and paste it into every prompt word for word.
- People who appear in more than one shot should be characters (step 2a), not just words.
- Length: as short as the idea allows. Three good shots beat ten average ones.

For more than one shot, show your user the brief and shot list before rendering, unless they told you to go ahead.

## 2a. Characters, for anyone seen twice

`list_characters` first: your user may already have them. Otherwise, for each person in more than one shot:

1. `create_character` with a concrete description (age, build, face, hair, marks) and the outfit they wear throughout,
   `wait_seconds: 120`. It draws four portraits.
2. Look at each portrait. `keep_still` the one that best fits the description: it becomes their face.
3. `make_character_stills` with `view: "sheet"`, `wait_seconds: 180`, then keep the angles that match the face.
4. In `direct_shot`, pass `characters` (ids or names) and still name them in the prompt. Not with a start frame: the
   characters draw it.

Only invented people. A character of a real person needs that person's own consent, which they give themselves on a
link from the Studio; you can't make one or give it for them.

## 3. Prompts (Gate 2)

Write each prompt per hildegard-craft's prompting guide, then `review_prompt`. Fix every `FIX`.

## 4. Drafts

- One shot: `direct_shot` with `quality: "draft"`, `takes: 2`, `wait: true`.
- A sequence: `make_sequence` with every shot, `wait: true`. It makes a new film; for more shots in the same film, use
  `direct_shot` with `film` set to its id.
- For continuity between shots, use a frame of the previous shot as the next one's `start_frame_path` when the shots
  are continuous in time.

## 5. Review every take (Gate 3)

For each finished take: `review_take`, look at the contact sheet, answer every question. Pick the best take per shot.
Anything failing: change one thing and re-render that shot only (`direct_shot` into the same `film`). At most three
rounds per shot, then report honestly.

Common fixes:

| Problem | Change |
| --- | --- |
| Hands or faces break | Lower `motion_strength`; simpler action; frame tighter or wider; another seed |
| Flicker or morphing | Another seed; shorter `seconds`; less motion; a start frame |
| Looks generic | Add one specific detail to the prompt |
| Oversaturated | Remove quality words; palette `faded-print` or `silver`; grade later |
| Continuity breaks | Paste the continuity lines word for word; same presets; cast the same characters; start frame from the previous shot |
| A character drifts | Keep a clearer face and a full-body reference; shorter shot; less motion |

## 6. Finals and export (Gate 4)

1. Re-render each chosen take with `quality: "final"` and its **seed**. Review each final with `review_take`.
2. Export uses each shot's kept take (the star in the Studio), or else its newest finished one, so a final you just
   rendered is used unless an older take is kept.
3. `export_film` with the film id. It joins each shot's kept (or newest finished) take into one MP4.
4. Check the exported file (or any clip your user brings). With Hildegard installed on this computer:
   `hildegard review <file> --film --final --sheet sheet.jpg`. Without Hildegard, from this skill's folder
   (install the packages once with `python3 -m pip install pillow numpy av`; without them FFmpeg still gives length, size, loudness and black frames, and you look at the sheet yourself):

   ```sh
   echo '{"path": "film.mp4", "sheet": "sheet.jpg", "final": true, "film": true, "audio": true}' > spec.json
   python3 scripts/review_media.py spec.json
   ```

   It prints each check (exposure, frozen frames, flicker, colour, black frames, sound) as pass, warn or fail, and
   writes a sheet of nine frames. `python3 scripts/contact_sheet.py sheet.png --video film.mp4 --every 2` makes a
   denser, time-labelled sheet. Look at the sheet.
5. Tell your user: the film's path, its length, what each shot is, and anything still imperfect.

Sound: LTX makes sound with the picture; Wan doesn't. For a voice-over, **hildegard-sound** has the steps: a person
records it through `record_link`, `clean_voice` cleans it, and `export_film` takes it as `voiceover`. For music or a
mix, continue with **hildegard-video-edit**.

## Never

- Never put a real, identifiable person into a shot without their consent; never make a fake of a real event.
- Never describe a take you haven't reviewed.
- Never queue dozens of takes hoping one works. Two per shot, then think.
