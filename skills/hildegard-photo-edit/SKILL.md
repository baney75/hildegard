---
name: hildegard-photo-edit
description: Use when asked to edit, fix, retouch, grade, crop, resize or animate a photo - ImageMagick to a professional standard (straighten, white balance, exposure, colour, sharpen, export).
---

# Editing photos

If you have **hildegard-craft**, read it first (`references/slop.md` here is its slop catalogue). A good photo edit is mostly invisible: straight horizons, true colour, the eye going
where it should. Over-editing (HDR glow, plastic skin, halos, crunchy saturation) is photo slop.

Work on copies in a new folder; never overwrite your user's originals. Commands are ImageMagick 7 (`magick`). With
ImageMagick 6, write `convert` instead of `magick`. Check every result and look at it: with Hildegard installed,
`hildegard review out.jpg --sheet look.jpg`; without it, from this skill's folder (needs `pip install av numpy pillow`)
`echo '{"path": "out.jpg", "sheet": "look.jpg"}' > spec.json && python3 scripts/review_media.py spec.json`. It prints
each check (size, highlights, shadows, contrast, colour) as pass, warn or fail. For before and after side by side,
`python3 scripts/contact_sheet.py compare.png in.jpg out.jpg`.

## 0. Look first

```sh
magick identify -verbose in.jpg | grep -E "Geometry|Colorspace|Quality|Orientation|icc:description"
hildegard review in.jpg          # or the review_media.py spec at the top of this skill
```

Note size, orientation and colour profile. Decide what the photo is *of* and what the edit is for (web, print, a
start frame) before touching it.

## 1. Orientation, straighten, crop

```sh
magick in.jpg -auto-orient step1.jpg                       # apply the camera's rotation flag
magick step1.jpg -background black -rotate -1.5 +repage -gravity center -crop 96%x96%+0+0 +repage straight.jpg
magick straight.jpg -gravity center -crop 4:5 +repage cropped.jpg   # crop to an aspect ratio
magick straight.jpg -crop 2400x3000+310+120 +repage cropped.jpg      # or an exact box
```

Horizons level, verticals upright. Crop to strengthen the subject (on a third, or centred for symmetry), not to
fill a format by habit. Keep enough pixels: 1080 px on the short side for the web, 3000+ for print.

## 2. White balance and exposure

```sh
magick in.jpg -channel RGB -auto-level -channel all -gamma 1.0 leveled.jpg   # stretch to the full range
magick in.jpg -level 3%,98%,1.05 leveled.jpg                                  # black point, white point, midtones
magick in.jpg -color-matrix "1.04 0 0  0 1 0  0 0 0.95" warmer.jpg            # nudge warmer (R up, B down)
```

Neutral greys (concrete, paper, a white shirt in shade) should read neutral unless the light is meant to be warm.
Don't auto-level a night scene or a misty one: its low contrast is the point.

## 3. Contrast and colour

```sh
magick in.jpg -sigmoidal-contrast 3x50% contrast.jpg         # gentle S-curve
magick in.jpg -modulate 100,88,100 calmer.jpg                # brightness, saturation (88%), hue
magick in.jpg -colorspace Gray -sigmoidal-contrast 4x45% bw.jpg   # black and white with body
```

Turn saturation *down* more often than up. The review's `colour` check failing means it's pushed too far.

## 4. Retouch, with restraint

- Remove temporary blemishes and dust; never change the shape of a face or a body, and never smooth skin to plastic.
- Small spots: a tiny local blur is enough:

```sh
magick in.jpg \( +clone -region 24x24+1310+842 -blur 0x3 \) -composite fixed.jpg
```

- Bigger repairs (a sign, a passer-by): say so to your user first. A documentary or news photo is never altered
  beyond exposure, colour and crop.

## 5. Sharpen and export

```sh
# For the web: sRGB, 2048 px long side, sharpened for the screen, metadata kept but GPS removed.
magick in.jpg -colorspace sRGB -resize "2048x2048>" -unsharp 0x0.75+0.6+0.02 -quality 88 \
  -define jpeg:sampling-factor=4:2:0 web.jpg
exiftool -gps:all= -overwrite_original web.jpg   # if exiftool is installed
# For print: full size, light sharpening, TIFF or maximum-quality JPEG.
magick in.jpg -unsharp 0x1+0.5+0.02 -quality 95 print.jpg
```

Sharpen last and once. Halos along edges mean too much.

## 6. Change it with words (Hildegard)

To change a photo with words (a new sky, another colour, an object removed) rather than by hand: with Hildegard
linked, its own `make_image` tool edits up to four reference images locally. Set `no_real_person` only when the photo
shows no real person; a real person is drawn only as a character who has consented. It draws a new image from the
photo, so use steps 1 to 5 when the pixels must stay exactly yours. Without Hildegard, use the image editor or model
you have, with the same caution; steps 1 to 5 need nothing else.

## 7. Bring a photo to life (Hildegard)

A photo can be the first frame of a video shot: the camera starts on exactly that image. This needs a video model:
with Hildegard linked, the steps below; without it, hand your user the edited, cropped photo and one line saying what
moves, for the video tool they have.

1. Edit the photo first (steps 1 to 5): its crop, light and colour become the shot's.
2. Crop to the shot's aspect (16:9, 9:16, 1:1, 4:3, 2.39:1) so nothing is squashed.
3. Follow **hildegard-film**: `direct_shot` with `start_frame_path` set to the edited file's absolute path, a prompt that
   describes the one thing that moves ("steam rises from the cup; her hand turns the page"), a subtle `motion` such as
   `dolly-in` at 0.3, and `takes: 2`. Review both with `review_take`.

Only animate photos of people who agreed to it. Never make someone appear to do or say what they didn't.

## 8. Deliver

Run the review on the export (`--final`, or `"final": true` in the spec, for the delivery bar), look at it at 100% and at phone size, and tell
your user what you changed. If you couldn't fix something (motion blur, focus missed), say so.
