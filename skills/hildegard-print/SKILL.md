---
name: hildegard-print
description: Design a real, working part to 3D print, from a brief, a photo of the old one or a shop listing, measured and checked in rounds (fits between parts, likeness to the photo, slicing with time, grams and cost) until it prints right, then handed over with a print sheet. Use for replacement parts, brackets, clips, knobs, enclosures, organisers, fixtures, any functional print or product made at home.
---

# Printing things that work

A printed part has one job: to fit and do its work the first time. It fails in three places: a dimension guessed
instead of measured, two parts that won't go together because nobody allowed for the printer's tolerance, and a print
nobody sliced until it was too late. So every number gets a source, every mating feature is sized from this printer's
clearance, every round is sliced, and the part goes out with a sheet that says what is known and what isn't.

This method follows print3d by mfranzon (MIT; see THIRD_PARTY_NOTICES.md), built on Hildegard's loop. Read
**hildegard-3d** for modeling and the sheet, and **hildegard-loop** for the rounds.

## 1. The brief, and the printer

Ask, then write it down: what the part is for and what it touches (the shaft, the rail, the shelf pin, the hand), the
load and the heat it sees, where it lives (indoors, a car in summer, outdoors), how many, and what it replaces. Then:

```json
printer_profile {}
```

It says the build volume, nozzle, layer, filament and its price, the clearance per side for each fit, and whether a
slicer is here. If your user names a printer or a price, set it. If a slicer needs profiles (OrcaSlicer, Bambu
Studio), set them from the computer Hildegard runs on; PrusaSlicer needs none.

**Calibrate fits once per printer.** For anything that fits together, check whether the clearances are calibrated. If
not, offer the fit coupon: `python print_kit.py coupon fit_coupon.obj` writes a strip of eight holes, 0.00 to 0.40 mm
per side from the tab end, and an 8 mm pin. Your user prints it and pushes the pin into each hole; the first that
presses in hard is `press`, the first that holds without play `snug`, the first that slides `slide`, the first that
turns loosely `free`. Set those with `printer_profile {"clearance_mm": {...}}`. Until then the defaults (0.05, 0.10,
0.20, 0.35) are a fair start for a tuned FDM printer.

## 2. Evidence: every number has a source

`scripts/print_kit.py` (`read_skill hildegard-print scripts/print_kit.py`; needs Python with Pillow and numpy) keeps
the evidence in `print-job/spec.json`. Each dimension is one of:

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
  OBJ, a node in GLB (`mesh_kit.write_parts_glb`, `mesh_kit.parts_obj_text`). Hildegard measures fits in that pose.
- **Size every mating feature from the clearance**, never a guessed number: a plug that slides into a 36 mm opening
  is `36 - 2 * slide` wide. Declare each fit in `loop_start` `fits`.
- Say how each part turns to print, if it isn't as assembled: `print_pose {"lid": [180, 0, 0]}`.
- Design for the process: walls a whole number of perimeters (two 0.4 mm lines is 0.8, three is 1.2), holes printed
  vertical where they must be round, no overhang past 45° without a chamfer, the flattest face on the bed, the
  layers running across the load, never along it (a hook printed standing snaps at the bend).

## 4. The loop

```json
loop_start {
  "kind": "model", "title": "Shelf clip",
  "for": "a replacement clip for a bookshelf pin, holding a 18 mm shelf, printed in PETG",
  "what": "a clip with a 5 mm pin that slides into the cabinet side and a lip the shelf rests on",
  "specifics": ["the pin slides in by hand", "the lip carries 10 kg", "no visible seam on the lip"],
  "print": true,
  "fits": [{"a": "pin", "b": "hole_gauge", "kind": "snug"}],
  "views": [ ...from `python print_kit.py loop` ],
  "evidence": { ...from `python print_kit.py loop` }
}
```

Each round comes back with the eight views, the checks, and for a print:

- **interference** and **fits**: parts that overlap (they won't go together), and each declared fit's gap per side
  against this printer's clearance. Parts with no declared fit that come close enough to fuse are named too.
- **likeness**: the model seen along each photographed view, laid over the outline in millimetres. Red is in the
  photo and missing from the model; blue is model the photo doesn't show. It also catches a part turned the wrong way
  (it names the pose that matches) and a shape that's right at the wrong size.
- **slice**: when a slicer is here, every passing round is sliced. The round says the time, the grams, the layers and
  what the filament costs, against the listing's price.
- `print_files`: an STL per part, standing on the bed in its print pose.

Fix failing checks first, then the matters of taste, one change a round. Look at the sheet before you answer.

## 5. Hand it over

`loop_finish` on the best round writes the **print sheet**: one page to print or send to whoever prints the part. It
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
