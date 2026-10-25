# Measuring a real object: photos and listings

Adapted from print3d's from-photo and from-listing guides by mfranzon (MIT; see THIRD_PARTY_NOTICES.md).

The photo is evidence, and so is a shop's listing. `print_kit.py` writes the evidence down in `print-job/spec.json`:
every number the model uses is measured off a photo, given by your user, quoted from a listing, or assumed with a
reason, and a measured one keeps its pixels and the reference it was scaled from, so a wrong number can be traced and
measured again instead of argued over.

The photo has to be a file on the computer the script runs on. In a chatbot, run the script in the app's code tool
with the photo uploaded there.

## 1. Scale each photo

Every view needs a known length in the same plane as the object: a bank card (`card`), a coin (`euro-1`,
`us-quarter`, `uk-pound`…), an A4 or letter sheet, a ruler (`100` for 100 mm), or a dimension your user gave or the
listing states (`dim:length`). With none in the photo, that's the one question to ask: "Could you take it again with a
bank card beside it, square-on?"

```sh
python print_kit.py grid photo.jpg                               # the whole photo, labelled in pixels
python print_kit.py grid photo.jpg --crop 120,340,260,420        # zoom on one end of the reference
python print_kit.py scale front photo.jpg card 132,388,948,392   # its two ends, read off the crops
```

Read every point off a **crop**. At full size a guessed pixel is millimetres off; a crop's labels are photo pixels,
so what you read goes straight into the command. Look at the grid image each time (it's a PNG beside the photo).

**Taken at an angle** (most photos are): rectify instead. Pick the four corners of a flat face of known size, in the
order they'd appear square-on (top-left, top-right, bottom-right, bottom-left):

```sh
python print_kit.py meet 100,100,400,110,390,500,380,900         # a corner hidden behind something
python print_kit.py rectify top photo.jpg 410,300,1620,340,1580,1100,380,1050 297x210
python print_kit.py grid print-job/top.rectified.png --crop ...  # read every later point for `top` off this
```

For a hidden corner, find two points on each edge that meets there and let `meet` cross them. Only what lies in the
rectified face measures true: anything standing off it (a stud, a boss) shifts with the viewing angle. Measure such
features where they meet the face, and get the rest from symmetry or record it as assumed.

View names `front back left right top bottom` set the camera's axes in the part **as printed** (z up off the bed).
When the part prints in another pose (a bracket laid on its side), pass `--look` and `--up` in the printed frame.

## 2. Measure the dimensions that drive the model

```sh
python print_kit.py dim width front 860,700,1410,702
python print_kit.py give depth 15 --source assumed --why "the back isn't photographed; the shelf is 15 mm"
python print_kit.py unknown "wall thickness: no section shows"
```

Each measurement comes back with `tolerance_mm`: the picking error of its own two points, plus the reference's,
plus the reference's rounding. When it's wider than the part can afford (a fit, a hole for a screw), crop tighter, ask
for a closer photo with the reference beside the feature, or ask your user to measure it with calipers (`give ...
--source user`). A dimension a fit depends on wants calipers.

## 3. Outline each view

Trace the object's outer edge in photo pixels: corners first, then enough points along curves to follow them (8 to
30 points). Or cut the object out (Hildegard's background removal, or any cut-out tool) and give the mask:

```sh
python print_kit.py outline front 860,700,1410,702,1408,1210,862,1208
python print_kit.py outline top --mask top-cutout.png     # opaque or white on the object, the photo's size
```

`python print_kit.py loop` then prints `views` (each outline in millimetres) and `evidence` for `loop_start`. Each
round, the likeness check lays the model's silhouette over each outline: red is in the photo and missing from the
model, blue is model the photo doesn't show. If it says the part matches better seen another way, turn the part, or
fix that view's `--look` and `--up`. If the shape is right and the size isn't, fix the dimension that drives it, or
measure it again.

## 4. From a shop listing

When your user would otherwise buy the part, the listing stands in for the object: its stated dimensions are
evidence, like a ruler in the photo, and its product photos are the views. Fetch the page yourself; if it blocks you,
ask your user to paste the dimensions and save the photos.

```sh
python print_kit.py listing https://shop.example/hook --title "Wall hook, brushed steel" --price 4.99 --currency EUR
python print_kit.py listed length 120 --quote "Dimensions: 120 x 45 x 30 mm"
python print_kit.py listed height 50 --quote "Height: 5 cm" --tolerance 5
python print_kit.py scale front hook-side.jpg dim:length 210,400,1730,402
```

- Quote every stated dimension in the listing's own words. A spec table, a dimensioned drawing and the description
  count; reviews don't. `--tolerance` is how coarsely it rounds: 0.5 mm by default, 5 for centimetres, 12.7 for half
  inches. Convert inches to millimetres and keep the inch figure in the quote.
- **Product, not the box.** "Package dimensions" describe the carton. When the listed sizes disagree with a photo's
  proportions by more than their rounding, record it as an unknown and ask which to trust.
- Pick the photos closest to square-on (a plain side, front or top, not the lifestyle shot), and scale each from the
  **longest** listed dimension in its plane: its rounding costs the least.
- **Check the scale**: measure a second listed dimension off the photo under another name (`length_measured`). If
  the two disagree by more than both tolerances together, the photo is in perspective or shows another variant: use
  another photo, or rectify. When they agree, model from the tighter of the two, and say so.
- What a shop part has that a print doesn't goes in as unknowns: metal parts (say what to buy: "M4 × 12 screw", "6 × 3
  mm magnet"), loads the original carries by its material (a PLA copy at the same section is weaker; thicken it and
  say so), and mating features the listing doesn't give to a tenth of a millimetre (print a test piece of just that
  feature first).

## Done when

Every dimension the model reads has a source, every photographed view has a scale and an outline, the likeness check
passes, and for a listing, every stated dimension is quoted and one was measured back off a photo within tolerance.
The print sheet lists which dimensions are measured, given, listed or assumed, and the unknowns: those are what your
user checks first on the print.
