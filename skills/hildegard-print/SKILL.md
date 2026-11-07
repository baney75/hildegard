---
name: hildegard-print
description: Use for a functional 3D print (replacement part, bracket, clip, knob, enclosure, fixture) from a brief, photo or listing - fits checked, sliced with time, grams and cost, with a print sheet.
---

# Printing things that work

A printed part has one job: to fit and do its work the first time. It fails in three places: a dimension guessed
instead of measured, two parts that won't go together because nobody allowed for the printer's tolerance, and a print
nobody sliced until it was too late. So every number gets a source, every mating feature is sized from this printer's
clearance, every round is sliced, and the part goes out with a sheet that says what is known and what isn't.

This method follows print3d by mfranzon (MIT; see `references/print3d-license.md`), built on Hildegard's loop. It works
alone: `scripts/print_kit.py` keeps the evidence, `scripts/mesh_kit.py` builds the part, and `scripts/review_mesh.py`
measures and draws each round (Python with numpy and Pillow: `python3 -m pip install pillow numpy av`; `mesh_sdf` also needs `scikit-image`).
Without them, take the sizes from the slicer and look at its renders. With Hildegard linked, `printer_profile`, `loop_start`,
`loop_submit` and `loop_finish` do the measuring, slicing and the print sheet for you. If you have them, the
**hildegard-3d** skill covers modeling and the sheet, **hildegard-openscad** building the part as parametric code (the
strongest route for a part that has to fit), and **hildegard-loop** the rounds.

## 1. The brief, and the printer

Ask, then write it down: what the part is for and what it touches (the shaft, the rail, the shelf pin, the hand), the
load and the heat it sees, where it lives (indoors, a car in summer, outdoors), how many, and what it replaces. Then
the printer. With Hildegard linked:

```json
printer_profile {}
```

It says the build volume, nozzle, layer, filament and its price, the clearance per side for each fit, and whether a
slicer is here. If your user names a printer or a price, set it. If a slicer needs profiles (OrcaSlicer, Bambu
Studio), set them from the computer Hildegard runs on; PrusaSlicer needs none.

Without Hildegard, get these from your user and write them in `print-job/printer.json`: the printer's model, bed size,
nozzle, layer height, filament and its price per kilogram, and which slicer they use. Use the clearances below (0.05, 0.10,
0.20, 0.35 mm per side) until the fit coupon says otherwise.

**Calibrate fits once per printer.** For anything that fits together, check whether the clearances are calibrated. If
not, offer the fit coupon: `python scripts/print_kit.py coupon fit_coupon.obj` writes a strip of eight holes, 0.00 to 0.40 mm
per side from the tab end, and an 8 mm pin. Your user prints it and pushes the pin into each hole; the first that
presses in hard is `press`, the first that holds without play `snug`, the first that slides `slide`, the first that
turns loosely `free`. Set those with `printer_profile {"clearance_mm": {...}}` (without Hildegard, in
`print-job/printer.json`). Until then the defaults (0.05, 0.10, 0.20, 0.35) are a fair start for a tuned FDM printer.

## 2. Evidence: every number has a source

`scripts/print_kit.py` (needs Pillow and numpy, installed as above; with Hildegard linked and no files, `read_skill
hildegard-print scripts/print_kit.py` shows it) keeps the evidence in `print-job/spec.json`. Each dimension is one of:

| Source | How | Example |
| --- | --- | --- |
| `measured` | read off a scaled photo; it carries its tolerance | `dim width front 860,700,1410,702` |
| `user` | your user measured or said it (calipers are best) | `give bore 10.2 --source user` |
| `listing` | the shop's own words, quoted | `listed hole 5 --quote "fits 5 mm shelf pins"` |
| `assumed` | you chose it, and say why | `give wall 2.4 --source assumed --why "six perimeters"` |

The model script reads these and holds no number of its own. Read `references/measuring.md` before measuring a
photo or a listing: scale, rectifying a photo taken at an angle, reading points off grid crops, outlines, and what
to do when a tolerance is wider than the part can afford.

What no photo shows (a depth, a thread pitch, the inside of a slot) goes in with `unknown "..."`. Those are the
first things your user checks on the print, and the sheet says so.

## 3. Model it assembled, from the clearances

Read `references/parts-and-fits.md`. In short:

- Build every part **where it sits assembled** (the lid on the box, the pin in its hole), each named: `o lid` in
  OBJ, a node in GLB (`mesh_kit.write_parts_glb`, `mesh_kit.parts_obj_text`). The fits are measured in that pose.
- **Size every mating feature from the clearance**, never a guessed number: a plug that slides into a 36 mm opening
  is `36 - 2 * slide` wide. Declare each fit in `fits`, in `loop_start` or in the review spec (section 4).
- Say how each part turns to print, if it isn't as assembled: `print_pose {"lid": [180, 0, 0]}`.
- Design for the process: walls a whole number of perimeters (two 0.4 mm lines is 0.8, three is 1.2), holes printed
  vertical where they must be round, no overhang past 45° without a chamfer, the flattest face on the bed, the
  layers running across the load, never along it (a hook printed standing snaps at the bend).

## 4. The loop

With Hildegard linked, start it:

```json
loop_start {
  "kind": "model", "title": "Shelf clip",
  "for": "a replacement clip for a bookshelf pin, holding a 18 mm shelf, printed in PETG",
  "what": "a clip with a 5 mm pin that slides into the cabinet side and a lip the shelf rests on",
  "specifics": ["the pin slides in by hand", "the lip carries 10 kg", "no visible seam on the lip"],
  "print": true,
  "fits": [{"a": "pin", "b": "hole_gauge", "kind": "snug"}],
  "views": [ ...from `python scripts/print_kit.py loop` ],
  "evidence": { ...from `python scripts/print_kit.py loop` }
}
```

Without Hildegard, run the same measuring on each round's model with `scripts/review_mesh.py`. Write `spec.json` with
the model's `path`, a `sheet` file name, `"print": true`, `size_mm`, `bed_mm` from the printer, the `fits`
(`[{"a": "pin", "b": "sleeve", "kind": "slide"}]`), the printer's `clearance` per side, the `views` that
`python scripts/print_kit.py loop` prints, optionally `print_pose` and an `export_dir` for the STLs:

```sh
python3 scripts/review_mesh.py spec.json
```

It prints the checks below as JSON and writes the sheet image: open the image and look at it. It does not slice:
slice the STLs in your user's slicer (PrusaSlicer: `prusa-slicer --export-gcode part.stl`) or ask them to, and note
the time, the grams and the cost for the print sheet.

Each round comes back with the eight views, the checks, and for a print:

- **interference** and **fits**: parts that overlap (they won't go together), and each declared fit's gap per side
  against this printer's clearance. Parts with no declared fit that come close enough to fuse are named too.
- **likeness**: the model seen along each photographed view, laid over the outline in millimetres. Red is in the
  photo and missing from the model; blue is model the photo doesn't show. It also catches a part turned the wrong way
  (it names the pose that matches) and a shape that's right at the wrong size.
- **slice** (with Hildegard linked and a slicer here): every passing round is sliced. The round says the time, the
  grams, the layers and what the filament costs, against the listing's price.
- `print_files`: an STL per part, standing on the bed in its print pose.

Fix failing checks first, then the matters of taste, one change a round. Look at the sheet before you answer.

## 5. Hand it over

`loop_finish` on the best round (with Hildegard linked) writes the **print sheet**; without it, write the same page
yourself as `print-sheet.md` and the sheet image beside it: one page to print or send to whoever prints the part. It
has the brief, the part from every side, time, filament and money (and what it saves against buying it), how the
parts fit, the likeness, every dimension with its source, the unknowns to check first, and whatever still fails.
Give your user the sheet, the STLs (or the G-code), and the build script, and say plainly: checked and sliced, not
yet printed. Ask them to tell you how it fit; a fit that's off is a clearance to calibrate, not a guess to repeat.

## Never

- Weapons or parts of one, in any form, whatever it's called.
- Anything a life or a limb depends on: climbing gear, car brakes or steering, child seats, medical devices, pressure
  vessels, ladders, load-bearing parts over people. Say why, and suggest buying the certified part.
- Someone else's trademark or logo on a part, or a copy of a product sold under a design patent, for sale. A
  replacement part for your user's own thing is fine.
- A number with no source. "About 20 mm" from a photo with no scale is a guess: get a scale or ask.
