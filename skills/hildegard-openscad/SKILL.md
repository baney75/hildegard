---
name: hildegard-openscad
description: Use when the user says OpenSCAD or .scad, or wants an exact parametric part (bracket, enclosure, box, knob, clip, mount, gear, thread) - code Hildegard renders, measures and draws.
---

# Parts in OpenSCAD

OpenSCAD is code-CAD: the model is a short program of solids, booleans and transforms, so every dimension is a named
number and every round is a small edit you can say in a sentence. That makes it the strongest route for an agent to
make a part that has to fit, and the weakest for anything organic. Sculpt figures and animals with **hildegard-3d**'s
signed-distance route or Blender; build parts here.

Read first: **hildegard-3d** (the brief, the sheet, the checks) and, for a part that has to work, **hildegard-print**
(evidence for every dimension, fits from the printer's clearance).

## 1. What this computer has

```json
openscad_status {}
```

It says the OpenSCAD version, whether it renders with **Manifold** (booleans in seconds) or **CGAL** (2021.01, which
can take minutes on the same model), and which libraries `include <…>` will find. Write for what is there:

- **BOSL2 installed**: use it (section 4). It rounds, chamfers, attaches and threads in one line each.
- **No BOSL2**: plain OpenSCAD. Don't include a library that isn't listed; the render fails.
- **CGAL only**: keep `$fn` at 24 to 32 while blocking out, raise it to 64 to 96 for the final round, and avoid
  `minkowski()`.
- **Not installed**: tell your user how (the tool says), or export STL yourself and send that.
- **Not sandboxed** (Windows, Linux without bubblewrap, or an AppImage; the tool says): a round may be only `.scad`
  files of its own. No libraries, no `import()` or `surface()` at all, and `linear_extrude` and `rotate_extrude` take
  their height by name (`height = h`), not by position. Send the library's files inside the round, beside the `.scad`
  that includes them, or write plain OpenSCAD.

## 2. The file

One file, `main.scad`, in this order. Every number the part is built from is a named parameter at the top, with its
unit and where it came from; the geometry holds no bare numbers but 0, 1, 2 and the small `eps`.

```openscad
// Cable clip for a 6 mm cable, desk edge 18 mm. Millimetres, Z up, standing on z = 0.

/* [Fit] */
cable_d    = 6.0;   // measured, calipers
grip       = 0.3;   // squeeze on the cable, assumed
desk       = 18.0;  // user said
/* [Build] */
wall       = 2.4;   // six perimeters at 0.4 mm
width      = 12;
$fn        = $preview ? 32 : 96;
eps        = 0.01;  // overlap so cuts don't leave skins

slot_d = cable_d - grip;

difference() {
    cube([desk + 2 * wall, width, 20]);
    translate([wall, -eps, -eps]) cube([desk, width + 2 * eps, 20 - wall + eps]);
    translate([-eps, width / 2, 20 + slot_d / 4]) rotate([0, 90, 0]) cylinder(d = slot_d, h = wall + 2 * eps);
}
```

- **Units are millimetres, Z up, the part standing on z = 0** in the pose it prints in. Hildegard's `base` and
  `overhang` checks read it that way.
- **Customizer comments** (`/* [Group] */`, `// note`) make the parameters editable in OpenSCAD's own panel, so your
  user can change the part without you.
- **`eps` overlaps on every cut.** A cut whose face lands exactly on a face leaves a paper-thin skin or a
  non-manifold edge. Make the cutter longer by `eps` on each open side.
- **Echo what you need to check**: `echo(slot = slot_d, inner = desk);`. Hildegard returns every echo with the round,
  so you can read the numbers you built from beside the measurements.

## 3. Habits that make good parts

- **2D first, then extrude.** Most parts are a profile: draw it with `square`, `circle`, `polygon` and `offset`, then
  `linear_extrude` or `rotate_extrude`. `offset(r = 2) offset(delta = -2)` rounds every outside corner of a profile;
  `offset(r = -2) offset(delta = 2)` rounds the inside ones.
- **`hull()` for organic-looking hard surfaces**: two cylinders hulled make a slot or a rounded bar; four spheres make a
  rounded block. Cheap and exact.
- **Modules for repeated features**, with the dimensions as arguments: `module screw_post(d, h) { … }`. A `for` loop
  places them; never copy and paste a feature.
- **Holes for real hardware**: an M3 clearance hole is 3.4 mm, an M3 heat-set insert hole about 4.0 mm, an M3 nut trap
  5.7 mm across the flats (`cylinder(d = 5.7 / cos(30), $fn = 6)`). Check the insert's own sheet when your user names
  one, and say which numbers are assumed.
- **Horizontal holes print oval at the top.** Use a teardrop (a `hull()` of the circle and a point above it at 45°)
  or a flat top, and the part needs no supports.
- **Chamfer the bottom edge** 0.4 to 0.6 mm so elephant's foot doesn't stop a part fitting; round the top edges for
  the hand.
- **Text**: `linear_extrude(0.6) text("A1", size = 6, font = "Liberation Sans:style=Bold", halign = "center");`. At least
  5 mm tall and 0.6 mm deep to print legibly.
- **Expensive operations**: `minkowski()` with a sphere and big `$fn` costs minutes (seconds with Manifold);
  `hull()` over many children and huge `for` unions do too. Round with `offset` in 2D or BOSL2's `rounding=` instead.

## 4. BOSL2, when it's there

`include <BOSL2/std.scad>` once at the top. What it saves you:

| Need | BOSL2 |
| --- | --- |
| A rounded or chamfered block | `cuboid([40, 30, 10], rounding = 2, edges = "Z", anchor = BOTTOM)` |
| Round only some edges | `cuboid(s, rounding = 2, except = BOTTOM)`, `edges = [TOP, "Z"]` |
| A rounded cylinder or tube | `cyl(h = 10, d = 20, rounding2 = 1)`, `tube(h = 10, od = 20, id = 16)` |
| Put one part on another | `cuboid(s) attach(TOP) cyl(h = 5, d = 8, anchor = BOTTOM);` |
| Cut with tags instead of `difference()` | `diff() cuboid(s) tag("remove") attach(TOP) cyl(h = 4, d = 3.4, anchor = TOP);` |
| Rows and grids | `xcopies(spacing = 10, n = 4)`, `grid_copies(spacing = 12, n = [3, 2])` |
| Threads | `include <BOSL2/threading.scad>` then `threaded_rod(d = 10, l = 20, pitch = 1.5)` |
| Screws and their holes | `include <BOSL2/screws.scad>` then `screw("M3", length = 10)`, `screw_hole("M3", length = 10, head = "socket")` |
| Gears | `include <BOSL2/gears.scad>` then `spur_gear(mod = 1, teeth = 20, thickness = 6)` |
| Text on a face | `text3d("A1", h = 0.6, size = 6, anchor = BOTTOM)` |

Anchors (`TOP`, `BOTTOM`, `LEFT`, `FRONT`, `CENTER`) place a shape by a named point instead of by arithmetic, which is
where most hand-written OpenSCAD goes wrong. Use `anchor = BOTTOM` on the base so the part stands on z = 0. For a
printed thread, give it the printer's clearance: `threaded_rod(…, $slop = 0.1)` (BOSL2's `$slop` is clearance per
side; take it from `printer_profile`).

## 5. Parts that fit together

For a print with more than one part (a box and its lid, a pin and its sleeve), declare the parts at the top level and
draw each one when `part` names it. Hildegard renders every part on its own and measures the fits between them:

```openscad
parts = ["box", "lid"];   // Hildegard renders each with part set to its name
part  = "all";
fit   = 0.2;              // slide clearance per side, from printer_profile

module box() { … }
module lid() translate([0, 0, box_h]) { … }   // where it sits assembled

if (part == "all" || part == "box") box();
if (part == "all" || part == "lid") lid();
```

Model the parts **assembled**, where they sit together; say how each pair mates in the loop's `fits`
(`{"a": "lid", "b": "box", "kind": "slide"}`) and how each prints in `print_pose`. Size every mating feature from the
printer's clearance, never a guessed number: a 20 mm boss in a slide fit gets a hole of `20 + 2 * fit`.

## 6. The loop

Start it as **hildegard-3d** says (`loop_start` with kind `model`, `print: true` for a print), then send the source
itself:

- **One file**: `loop_submit {"text": "<the source>"}`, or `file_path` to the `.scad`.
- **Several files** (main.scad with `use <parts/hinge.scad>`, an SVG to import): `file_path` to the folder, or `data`
  as a base64 ZIP. The file rendered is `main.scad`.

Hildegard renders it with OpenSCAD and checks the mesh like any other round: eight views, silhouettes, watertight,
size, base, overhangs, the fits. The round keeps your source, so the owner can open it.

What it refuses, before anything runs (no round is used, so fix it and send again):

- `include` or `use` of anything but a `.scad` file (lowercase), of an absolute path, or of one with `..`. Paths are
  read from the folder of the file that includes them: the round's own files by that path, and libraries by their own
  (`include <BOSL2/std.scad>`), only where OpenSCAD runs sandboxed. More than 4 MB of source, or brackets nested
  deeper than 256, are refused too.
- `include` or `use` written any other way than `include <file.scad>`, such as with a comment before the `<`.
- `import()` or `surface()` with anything but one plain string naming a file sent with the round, from the folder of
  the file that reads it. Send the SVG or STL beside the `.scad` that imports it. Its other strings (a DXF layer, an
  SVG id) can't look like paths. Data files are read only where OpenSCAD runs sandboxed.
- `import_stl`, `import_off`, `import_dxf`, any `dxf_…`, `file = …` on any call but `import()` and `surface()`, and a
  string given by position to `linear_extrude` or `rotate_extrude` (that's a file to them).
- Files or folders in the round whose names start with a dot.

OpenSCAD then runs sandboxed where it can be (sandbox-exec on macOS, bubblewrap on Linux): no network; it reads only
the system, its own files, fonts, the libraries and the round; and it writes only in the round. It gets no
environment beyond what it needs, and one render runs at a time on the computer (a few more wait; past that, "busy":
send again in a few minutes). The whole round, every part of it, shares one time limit, counted while OpenSCAD runs
(180 s, or `HILDEGARD_OPENSCAD_TIMEOUT` seconds). Paths in OpenSCAD's messages come back as round-relative names,
`<library>/…` or `<path>`. A mesh over 256 MB, as STL or as the parts' OBJ, is refused: lower `$fn`.

What fails at render, with OpenSCAD's own message (no round is used):

| It says | It means |
| --- | --- |
| `Parser error … line N` | A missing `;`, `)` or `}` on or just before line N |
| `The model is empty` | A module defined and never called, or a `difference()` whose first child is empty |
| `The model is 2D` | A profile never extruded |
| `took longer than` | `$fn` too high, `minkowski()`, or a huge `for` union; block out lower |

And **warnings come back as a check** (`openscad` warns). `Ignoring unknown variable` or `unknown module` means a part
is missing from the model while the render looks fine: fix every one before you answer the rubric.

## 7. Things that go wrong

- **Faces exactly coincident.** A lid resting on a box at the same z, a cutter flush with a face: Z-fighting in the
  preview, skins and non-manifold edges in the mesh (`manifold` and `debris` catch them). Overlap by `eps`, or keep a
  real gap between separate parts.
- **Thin walls from subtraction.** Two cuts that come within a millimetre leave a wall the printer can't make. Echo the
  wall you meant (`echo(wall = outer - inner)`) and keep it above 1.2 mm for FDM.
- **The part made at the origin's corner but meant centred**, or the other way. `cube(s, center = true)` and BOSL2's
  anchors say which; pick one and keep it for the whole file.
- **A preview that lies.** `$preview` geometry and `%` or `#` modifiers don't export. Hildegard checks the rendered
  mesh, not the preview; trust the sheet.
- **Polygon winding and `polyhedron()`.** Faces must list points clockwise seen from outside; a wrong one shows magenta
  on the sheet. Prefer `hull()` or `linear_extrude` to hand-written polyhedra.
- **Detail before the masses are right.** Get the outline, the fits and the size passing first; text, knurling and
  fillets come last.

## 8. Deliver

The finished round's file and its `main.scad` (with the parameters your user can change and where each came from),
the sheet, and for a print the print sheet `loop_finish` writes. Say which numbers were measured and which assumed.
No weapons or weapon parts, in any form.
