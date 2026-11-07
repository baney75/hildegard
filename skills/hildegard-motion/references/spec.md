# The motion spec

A spec is one JSON file. `spec.schema.json` (next to this file) describes every field; `motion.py --check` validates against
it and then runs the checks that need measuring. This page says what each field does. Templates in `../templates/` are
working examples of all of it.

```sh
python3 scripts/motion.py spec.json --check                    # problems in plain words, nothing rendered
python3 scripts/motion.py spec.json out.mp4                    # check, then render (refuses if it fails)
python3 scripts/motion.py spec.json out.mp4 --preview sheet.jpg   # also a contact sheet of 8 frames
python3 scripts/motion.py spec.json --preview sheet.jpg        # the sheet only, no video
python3 scripts/motion.py spec.json out.mp4 --scale 0.5 --fps 15  # a fast half-size draft
python3 scripts/motion.py spec.json out.mp4 --hashes h.txt     # SHA-256 of every frame: same spec, same hashes
python3 scripts/motion.py spec.json --check --json             # the report as JSON
python3 scripts/motion.py --fonts [fetch|json]                 # the pinned fonts, cached or not
```

`--force` renders even if `--check` finds problems. Use it only to look at a draft; never to deliver.

## Units: one rule

- **Positions and boxes are fractions of the frame**: `x`, `w`, `box` are fractions of the width, `y`, `h` fractions of the
  height. `x: 0.5, y: 0.5` is the middle. `0` is the left or top edge, `1` the right or bottom edge.
- **Every other length is `vh`, a percent of the frame height**: `size`, `radius`, stroke `width`, `letter_spacing`, shadow
  `blur`, `pad`. `size: 8` is 8% of the height (86 px at 1080 p). So a spec looks the same at any resolution.
- **Time is seconds.** A layer's `start`, `end`, `at` and `delay` count from the start of its scene (a tween's `at` from
  the start of its layer).
- **Colors** are `#rrggbb`, `#rrggbbaa` (the last pair is opacity) or `#rgb`, or `transparent`. Nothing else.
- **Angles** are degrees. `rotation` is clockwise. Gradient `angle` is CSS style: 0 up, 90 right, 180 down.

## Top level

| Field | Meaning |
|---|---|
| `canvas` | `width`, `height` (even numbers), `fps` (default 30), `background` (a color or a gradient), `safe` (safe margin as a fraction of each side, default 0.05) |
| `duration` | optional total seconds. `--check` confirms it equals the scenes' lengths minus the overlap of each transition |
| `fonts` | names you can use in `font`: `{"display": {"google": "Playfair Display"}}` or `{"mine": {"path": "fonts/My.ttf"}}`. A pinned Google family name works in `font` without declaring it |
| `scenes` | the timeline, in order |
| `fade` | `{"in": 0.6, "out": 0.8, "color": "#000000"}`: open from and close to a color |
| `captions` | subtitles; see below |
| `audio` | a track or a list of tracks; see below |
| `title` | a note for people; ignored |

A **gradient** is `{"type": "linear" | "radial", "angle": 160, "stops": [{"at": 0, "color": "#0b1020"}, {"at": 1, "color": "#231a4f"}]}`.
Radial takes `center` (`[0.5, 0.5]`) and `radius` (a fraction of the larger side). Backgrounds get a one-level dither so
they do not band after encoding.

## Scenes

```json
{"id": "intro", "duration": 5, "background": "#0b1020",
 "transition": {"type": "crossfade", "duration": 0.6},
 "camera": {"preset": "push-in", "amount": 0.1},
 "layers": [ ... ]}
```

- `duration` is required. Scenes play in order. A `transition` on a scene blends from the scene before it, and the two
  overlap for the transition's length, so the video is shorter by that much.
- `transition.type`: `cut` (default), `crossfade`, `slide` (the new scene pushes the old one; `direction` is the way the
  motion goes, `left` means the new scene arrives from the right), `wipe` (`direction` is the way the edge travels), `dip`
  (through `color`, default black). `duration` defaults to 0.6.
- `camera`: a slow move over the scene's whole length. `preset`: `push-in`, `pull-out`, `pan-left`, `pan-right`, `pan-up`,
  `pan-down`, `drift`; `amount` (push: zoom, default 0.12; pans: share of the frame, default 0.08). Or give `from` and `to`
  as `{"zoom": 1.0, "x": 0.5, "y": 0.5}` (`x`, `y` is the point at the center of the view) and an `ease`. By default the
  camera moves **images only**; give another layer `"camera": true` to move with it, or a number like `0.4` for parallax.
  `--check` errors if a camera move shows the edge of a full-frame photo.
- Layers are drawn in order: the **last layer is on top**.

## Layers: what they all share

| Field | Meaning |
|---|---|
| `type` | `text`, `shape`, `image` or `bars` |
| `id` | a name used in messages |
| `start`, `end` | seconds into the scene when it appears and goes (default: the whole scene) |
| `x`, `y` | where the layer's anchor point sits (default 0.5, 0.5) |
| `anchor` | which point of the layer is at `x`, `y`: `center` (default), `left`, `right`, `top`, `bottom`, `topleft`, `topright`, `bottomleft`, `bottomright`. Scale and rotation pivot on the anchor |
| `scale`, `rotation`, `opacity` | 1, 0 and 1 by default |
| `enter`, `exit` | a named entrance or exit; below |
| `animate` | your own moves; below |
| `reveal` | 0 to 1: how much is shown (typed letters, a wipe, a drawn line). Usually set by `enter` |
| `direction` | `left`, `right`, `up`, `down`: which way a wipe or a grow travels (default `right`) |
| `camera` | `true`, `false` or a number: follow the scene camera |
| `safe` | `false` allows this layer in the safe margin or off an edge, on purpose |

### `enter` and `exit`

`{"type": "rise", "duration": 0.7, "delay": 0.3, "ease": "easeOutCubic"}`. Every field but `type` is optional.

| Enter | What it does | Notes |
|---|---|---|
| `fade` | opacity 0 to 1 | 0.6 s |
| `rise` | fades in while moving up 4% of the frame | `distance` changes the travel |
| `drop` | fades in while moving down | |
| `slide-from-left`, `slide-from-right` | fades in while moving 8% sideways | |
| `zoom` | fades in while growing from 90% | |
| `pop` | grows from 60% with a small overshoot (`easeOutBack`) | for badges, buttons, big words |
| `type` | letters appear one by one | text only; duration is about 0.045 s a letter |
| `wipe` | revealed by an edge moving along `direction` | any layer |
| `grow` | width (or height, with `direction` `up` or `down`) grows from 0 at the anchor | rect, rounded, circle, ellipse |
| `draw` | the stroke draws itself along its length | line, polygon, path |

Text only: `"split": "word" | "line" | "char"` with `"stagger"` (seconds between pieces, default 0.08) animates each piece
in turn for `fade`, `rise`, `drop`, `slide-from-*`, `zoom` and `pop`.

Exits: `fade`, `rise` (up), `drop` (down), `slide-to-left`, `slide-to-right`, `zoom` (grows and fades), `wipe`. An exit ends
when the layer ends (its `end`, or the scene's end).

### `animate`: your own moves

```json
"animate": [{"prop": "y", "from": 0.6, "to": 0.5, "at": 0.2, "duration": 0.8, "ease": "easeOutCubic"}]
```

`prop`: `x`, `y`, `w`, `h`, `scale`, `rotation`, `opacity`, `color`, `reveal`. `from` is optional (it starts from the layer's
own value). `at` is seconds after the layer starts. Before a move starts the property holds its `from`; after it ends it
holds its `to`. Several moves on one property chain by time. `color` takes color strings and works on text and on shapes
with a solid fill.

### Easings

`linear`, `easeInSine`, `easeOutSine`, `easeInOutSine`, `easeInQuad`, `easeOutQuad`, `easeInOutQuad`, `easeInCubic`,
`easeOutCubic`, `easeInOutCubic`, `easeInQuart`, `easeOutQuart`, `easeInOutQuart`, `easeInExpo`, `easeOutExpo`,
`easeInOutExpo`, `easeInBack`, `easeOutBack`, `easeInOutBack`, `spring`, `bounce`.
Things arriving use `easeOut...`, things leaving use `easeIn...`, things that go and return use `easeInOut...`.
`spring` and the `Back` eases overshoot; use them on small things only.

## text

```json
{"type": "text", "text": "Harvest Night", "font": "Montserrat", "size": 12, "weight": 800, "color": "#ffffff",
 "x": 0.5, "y": 0.77, "align": "center", "box": 0.7, "line_height": 1.2, "letter_spacing": 0.2,
 "shadow": true, "backing": {"color": "#000000b3", "pad": 1.6, "radius": 1.2}, "outline": {"color": "#000", "width": 0.3}}
```

| Field | Meaning |
|---|---|
| `text` | the words. `\n` is a line break. `{n}` is where a counting number goes |
| `font` | a name from `fonts` or a pinned Google family (default Inter) |
| `size` | percent of the frame height. See SKILL.md for the scale |
| `weight` | 100 to 900 (variable fonts follow it; static ones such as Bebas Neue ignore it) |
| `italic` | uses the italic file where the family has one (Inter, Montserrat, Playfair Display, Lora, EB Garamond, DM Serif Display) |
| `align` | `left`, `center`, `right`, inside the box |
| `box` | wrap width as a fraction of the frame width. Without it the text is one line per `\n` |
| `max_lines` | `--check` errors if the text wraps to more lines |
| `line_height` | multiple of `size` (default 1.2) |
| `letter_spacing` | percent of the height; 0.2 to 0.5 for small caps labels, negative to tighten |
| `shadow` | `true` or `{"color", "blur", "dx", "dy"}`: a soft shadow. It does not count toward contrast |
| `backing` | a rounded box behind the text. Contrast is measured against it |
| `outline` | a stroke around the letters |
| `count` | makes `{n}` count: `{"from": 0, "to": 81, "decimals": 0, "thousands": true, "at": 0.3, "duration": 1.2, "ease": "easeOutCubic"}`. Digits are tabular so the number does not jitter |

`reveal` on text is typewriter by default; `"reveal_style": "wipe"` wipes instead.

## shape

`"shape"`: `rect`, `rounded`, `circle`, `ellipse`, `line`, `polygon`, `path`.

- **rect, rounded, ellipse**: `w` (fraction of the width) and `h` (fraction of the height). `rounded` takes `radius` (vh).
- **circle**: `w` only; it stays round at any frame shape.
- **line**: `from` and `to`, each `[x, y]` in fractions of the frame.
- **polygon**: `points`, a list of `[x, y]` (3 or more).
- **path**: `d`, like an SVG path in frame fractions, absolute upper-case commands only: `M x y`, `L x y`,
  `C x1 y1 x2 y2 x y`, `Q x1 y1 x y`, `Z`. Example: `"M 0.2 0.8 C 0.4 0.6 0.6 1.0 0.8 0.8"`.

For line, polygon and path, `x` and `y` are offsets (default 0) added to every point, and `scale` and `rotation` pivot on
the middle of the shape.

`fill` is a color or a gradient (default white; none for a line). `stroke` is `{"color", "width", "round"}` (width in vh,
default 0.4).

## image

`{"type": "image", "file": "photos/one.jpg", "fit": "cover"}`

- `file`: a path relative to the spec file (JPEG, PNG, WebP), or a built-in placeholder: `sample:dusk`, `sample:dawn`,
  `sample:moss`, `sample:night`, `sample:sand` (landscapes drawn in code, for trying a layout with no photos).
- `fit`: `cover` (fills the box, crops the rest; default) or `contain` (shows all of it). `focus: [fx, fy]` picks the part
  that survives a crop (`[0.5, 0.3]` keeps the top-middle).
- `w`, `h`: the box as fractions of the frame (default 1 and 1: the whole frame). `x`, `y`, `anchor` place the box.
- `dim`: darken, 0 to 1. `radius`: rounded corners (vh).
- Photos are read with their camera rotation applied. A photo under half the frame width gets a softness warning.

## bars: a chart from real numbers

```json
{"type": "bars", "x": 0.4, "y": 0.58, "w": 0.62, "h": 0.66, "color": "#4f8cff",
 "data": [{"label": "Jan", "value": 112}, {"label": "May", "value": 203, "color": "#f2b84b"}],
 "grow": {"at": 0.5, "duration": 1.2, "stagger": 0.35}}
```

Bar height is `value` over the largest value (or `max`) times the chart's room, so heights are proportional to the numbers.
Each value label counts up as its bar grows. Other fields: `prefix`, `suffix`, `decimals`, `gap`, `radius`, `font`,
`label_color`, `value_color`, `axis_color`, `label_size`, `value_size`, and `color` per datum. Up to 12 bars. A chart is
expanded into ordinary shape and text layers, so every check applies to its labels.

## captions

```json
"captions": {"srt": "lines.srt", "cues": [{"start": 1.2, "end": 4.0, "text": "First light"}],
             "position": "bottom", "size": 3.9, "font": "Inter", "color": "#ffffff", "box": 0.8}
```

`srt` is a SubRip file relative to the spec; `cues` are the same thing inline; use either or both. Times are in the final
video. Captions are drawn on top of everything, with a dark backing and a short fade. Cues are checked for reading time
(as warnings), overlap with scene text, and contrast.

## audio

```json
"audio": {"file": "music.mp3", "start": 0, "volume_db": -3, "fade_in": 1, "fade_out": 2, "lufs": -14}
```

A list of such objects mixes several tracks (a voice and music under it: give the music `volume_db: -14`). The mix is
trimmed to the video, padded with silence if shorter, and normalized to -14 LUFS (two passes: it measures, then applies a
linear gain) unless `"loudnorm": false`. Audio needs `ffmpeg` on PATH. The audio file must be one the user may use.

## What --check measures

Unknown fields and wrong values (with a "did you mean"); missing image, audio and SRT files; missing fonts; scene lengths
against their transitions; `duration` against the scenes; any animation that runs past its scene; layers that never
appear; text that overflows its box (a word wider than the box, more than `max_lines`); text that runs off the frame or into
the safe margin at any time it is readable; text under size 2; text on screen less than 0.25 s per word (minimum 1.2 s);
text blocks that overlap each other or a caption; a later layer drawn over text; contrast under 4.5:1 for small text
(under 5 vh) or 3:1 for large, measured on the pixels behind the text; a camera move that uncovers a photo's edge; more
than 3.6 words per second in a scene; a last frame that is still moving. Warnings do not stop a render; problems do.
