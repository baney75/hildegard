---
name: hildegard-film
description: Use when asked to make a video, scene, short film, ad, music video or animated photo on the user's own GPU with Hildegard's tools (direct_shot, make_sequence, review_take, export_film).
---

# Directing a film with Hildegard

You direct; Hildegard renders on your user's GPU through ComfyUI. Read **hildegard-craft** first: its gates apply to
every step here. Tools are Hildegard's MCP tools; if they aren't available, tell your user to run
`hildegard connect <your app>` (see hildegard-setup).

## 1. Find out what you have

1. `hildegard_status`: which models are installed, what's rendering. No model installed: offer `install_model` and
   show the license it returns word for word; install only on a clear yes from your user.
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
4. If your agent runs on the computer Hildegard runs on: `hildegard review <file> --film --final --sheet sheet.jpg`
   on the exported file, and look at the sheet.
5. Tell your user: the film's path, its length, what each shot is, and anything still imperfect.

Sound: LTX makes sound with the picture; Wan doesn't. For music, voice-over or a mix, continue with
**hildegard-video-edit**.

## Never

- Never put a real, identifiable person into a shot without their consent; never make a fake of a real event.
- Never describe a take you haven't reviewed.
- Never queue dozens of takes hoping one works. Two per shot, then think.
