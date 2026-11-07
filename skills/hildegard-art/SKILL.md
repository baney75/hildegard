---
name: hildegard-art
description: Use when asked to create art, an image, illustration, key art, mood board or visual style with Hildegard's image models - for posters and covers with words, use hildegard-design.
---

# Making art

If you have **hildegard-craft**, read it first (`references/slop.md` here is its slop catalogue). Art is where slop is
most tempting: one vague prompt, one glossy result, "stunning". Treat the model as a fast, literal studio assistant
and do the art direction yourself.

## 1. What can make it

With Hildegard linked, call `hildegard_status` and `list_presets`. Without Hildegard, use the image tool you have (a
chatbot's own image generation, a model your user runs, or images they bring); sections 2 to 6 work the same, with the
camera and look written in plain words in the prompt, since the preset ids exist only in Hildegard.

- If an **image model** is listed, use it for stills. Hildegard’s own `make_image` tool draws and edits images locally,
  from words or up to four reference images, with the camera and look from `list_presets`. It never makes sexual
  content, and `no_real_person` is yours to set only when the references show no real person.
- If only **video models** are installed (LTX, Wan), make stills from video: direct a short shot that holds still
  (`motion: ["static"]`, `seconds: 2`, `quality: "final"`), review it, then take the sharpest frame from the finished
  file on the computer Hildegard runs on:

  ```sh
  ffmpeg -ss 1.0 -i take.mp4 -frames:v 1 -q:v 1 still.png
  ```

  Tell your user that's how the still was made and that it's limited to the video model's resolution (finals are
  1088 px high with LTX, 704 with Wan): fine for screens, small for print.

## 2. Direct before you generate

Write the brief (hildegard-craft, Gate 1) plus an **art direction** of five lines:

- **Idea:** the one thing it should say. A poster for a bakery's 50th year says "same bread, same hands".
- **Composition:** where the eye lands first, what's in the dark, the horizon line, how much empty space.
- **Palette:** three to five colours by name ("flour white, rye brown, oven red, slate"), or a palette preset.
- **Light:** source, direction, quality, time of day.
- **Material and mark:** what it should feel like it was made with (risograph, gouache, 16mm, linocut), described
  by qualities, never by a living artist's name.

## 3. A series, not a lottery

1. Write **three different prompts** that each answer the direction in a different way (a close detail, a wide
   scene, a symbolic still life). With Hildegard linked, lint each with `review_prompt`. Without it, check each
   against the slop catalogue (`references/slop.md`): no quality words ("8k", "masterpiece", "cinematic"), one idea,
   literal sentences, a concrete detail nobody would guess.
2. Render each as a draft with two takes.
3. Review every result (with Hildegard linked, `review_take`, or `hildegard review <file> --sheet` for stills).
   Without Hildegard, run `echo '{"path": "take-1.png", "sheet": "look-1.jpg"}' > spec.json` then
   `python3 scripts/review_media.py spec.json` for the technical checks, and
   `python3 scripts/contact_sheet.py sheet.png take-*.png --title "Round 1"` to put the takes side by side. Choose the
   one that says the idea most clearly, not the prettiest. Both scripts need Python packages: install them once with
   `python3 -m pip install pillow numpy av`. A still needs only Pillow and numpy for `review_media.py`, and only Pillow for `contact_sheet.py`. Without
   them, look at each image yourself against the critique questions and read its size with `ffprobe`.
4. Refine the chosen one: change one thing per round (the crop, the light, a detail), at most three rounds.

## 4. Critique, out loud

Before you show your user anything, answer in writing:

- What does the viewer see first, second, third? Is that the order the idea needs?
- What would a good human illustrator change? Do it, or say why not.
- What in it is a default the model chose for you (the glow, the centred subject, the generic face)? Replace it.
- Could this have been made for any client? If yes, it isn't finished: add something only this client has.

## 5. Finish

Generated images often need the finishing a designer would give them:

- Crop and straighten, then grade (the **hildegard-photo-edit** skill, if you have it: it is ImageMagick commands).
- **Type is added by hand, never generated.** Set titles in a real typeface with ImageMagick:

  ```sh
  magick art.png -gravity south -font "Source-Sans-3-Semibold" -pointsize 96 -fill "#F4EFE6" \
    -annotate +0+140 "FIFTY YEARS OF BREAD" poster.png
  ```

  Use a font your user has a license for (`magick -list font` shows installed ones). Keep text off faces and off
  the busiest part of the image; give it room.
- Export for where it goes (the hildegard-photo-edit skill, step 5: sRGB, the long side at 2048 px for the web).

## 6. Deliver

Give your user the file, the one-sentence idea, how it was made (model, still from video or not), and what you would
do next with more time. Never say a generated image is hand-made, and keep its AI label when it's published.
