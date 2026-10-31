---
name: hildegard-art
description: Use when asked to create art, an image, poster, cover, key art, illustration, mood board or visual style - art direction, variations, honest critique and finishing with Hildegard's image models.
---

# Making art

Read **hildegard-craft** first. Art is where slop is most tempting: one vague prompt, one glossy result, "stunning".
Treat the model as a fast, literal studio assistant and do the art direction yourself.

## 1. What can make it

Call `hildegard_status` and `list_presets`.

- If an **image model** is listed, use it for stills.
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
   scene, a symbolic still life). Lint each with `review_prompt`.
2. Render each as a draft with two takes.
3. Review every result (`review_take`, or `hildegard review <file> --sheet` for stills). Put the best of each side
   by side and choose the one that says the idea most clearly, not the prettiest.
4. Refine the chosen one: change one thing per round (the crop, the light, a detail), at most three rounds.

## 4. Critique, out loud

Before you show your user anything, answer in writing:

- What does the viewer see first, second, third? Is that the order the idea needs?
- What would a good human illustrator change? Do it, or say why not.
- What in it is a default the model chose for you (the glow, the centred subject, the generic face)? Replace it.
- Could this have been made for any client? If yes, it isn't finished: add something only this client has.

## 5. Finish

Generated images often need the finishing a designer would give them:

- Crop and straighten, then grade (see **hildegard-photo-edit**).
- **Type is added by hand, never generated.** Set titles in a real typeface with ImageMagick:

  ```sh
  magick art.png -gravity south -font "Source-Sans-3-Semibold" -pointsize 96 -fill "#F4EFE6" \
    -annotate +0+140 "FIFTY YEARS OF BREAD" poster.png
  ```

  Use a font your user has a license for (`magick -list font` shows installed ones). Keep text off faces and off
  the busiest part of the image; give it room.
- Export for where it goes (hildegard-photo-edit, step 5).

## 6. Deliver

Give your user the file, the one-sentence idea, how it was made (model, still from video or not), and what you would
do next with more time. Never say a generated image is hand-made, and keep its AI label when it's published.
