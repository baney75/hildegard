---
name: hildegard-3d
description: Use for any 3D model, sculpture, figurine, game asset, relief or lithophane, in Blender, OpenSCAD or code. Hildegard measures and draws each round (views, watertight, size) until it passes.
---

# Modeling in 3D, in rounds

A 3D model made in one shot is slop: it reads from the front and collapses from the side, it has holes a slicer
chokes on, and it is the wrong size. Make it the way a sculptor does: big masses first, turned and checked from every
side, detail last. Hildegard's loop does the turning and the measuring; you do the looking and the deciding.

This skill works alone. With Hildegard linked, `loop_start`, `loop_submit`, `loop_critique` and `loop_finish` run the
rounds, and measure and draw each one. Without Hildegard, you run the same rounds yourself: build with
`scripts/mesh_kit.py` or Blender, then measure and draw each round with `scripts/review_mesh.py` (section 3). Both
need Python with numpy and Pillow: install them once with `python3 -m pip install pillow numpy av` (`av` is for the media checker; the
mesher `mesh_sdf` also needs `scikit-image`). Without them, take the size from the exporter and look at renders.

If you have them, the **hildegard** skill (its sculpture and figure-anatomy references) gives the method and the
anatomy for any figure, face, hand or animal, and **hildegard-craft** the brief and the slop to avoid. Here,
`references/slop.md` is the slop catalogue.

## 1. The brief, then the loop

Write the brief before any geometry: who it's for and where it goes, what it is, three specifics, constraints, and
references (qualities, not names). Decide what the model is **for**, since that sets every target:

| For | Format | Units and up | Targets |
| --- | --- | --- | --- |
| A 3D print | STL (or GLB) | millimetres, Z up | watertight, one body (or parts on purpose), fits the bed, a base, few overhangs |
| Viewing, AR, the web | GLB | metres, Y up | silhouette from every side, a sensible triangle budget, PBR materials |
| A game | GLB | metres, Y up | a hard triangle budget, clean silhouette at small size |
| A render or turntable | GLB or the Blender file | as authored | form and surface under raking light |

Then start the loop with those targets. With Hildegard linked, call `loop_start`:

```json
loop_start {
  "kind": "model", "title": "Heron finial",
  "for": "a 3D print for the end of a curtain rod, FDM, PLA",
  "what": "a standing heron, neck folded, on a round plinth that fits a 25 mm rod",
  "specifics": ["the S of the folded neck", "one leg lifted", "feather tracts as planes, not noise"],
  "print": true, "size_mm": [40, 40, 120]
}
```

Without Hildegard, write the same brief and targets into `brief.md` in the project folder, and keep one line per
round in `rounds.md`: what you changed, what the checks said, what you will change next.

## 2. Choose how to build it

Pick the route that fits the subject and what this computer has. Keep the build in **one script with named
parameters** (`build.py`, `model.scad`), seeded, so each round is a small edit you can name, never a hand-patched mesh.

| Subject | Route | Notes |
| --- | --- | --- |
| Organic: figures, animals, drapery, rocks | Signed-distance fields + smooth union, meshed with marching cubes | `scripts/mesh_kit.py` has the primitives, `smin`, and the mesher (needs scikit-image) |
| Organic, with Blender here | Blender headless: `blender -b -P build.py` | primitives, Subdivision, Remesh, Sculpt by script, Geometry Nodes; export with `bpy.ops.export_scene.gltf` or `wm.stl_export` |
| Hard-surface, functional, printable parts | OpenSCAD (the **hildegard-openscad** skill; with Hildegard linked, send the `.scad` itself and it renders it); or build123d / CadQuery | exact dimensions, fillets, clearances, parts that fit |
| Booleans and extrusions in Python | trimesh + manifold3d | `manifold3d` keeps booleans watertight |
| Reliefs, coins, lithophanes | A heightmap image turned into a mesh | lithophanes 0.6 mm (light) to 3 mm (dark) thick |
| No code here (a chatbot) | Write a blockout as OBJ text and send it as `text`; or run Python in the app's code tool and send the file as base64 `data` | keep text models to a few thousand faces |

`scripts/mesh_kit.py` (read it from this skill's folder; with Hildegard linked and no files, `read_skill hildegard-3d
scripts/mesh_kit.py`) is plain numpy: watertight
primitives (box, sphere, cylinder), transforms, signed-distance modeling, and writers for OBJ, STL and GLB, so a
model can be made and sent from any Python, including a chatbot's.

## 3. Rounds: big to small, one change each

1. **Blockout.** Primary masses only (spheres, capsules, boxes), at low resolution. Get proportion, gesture and the
   silhouette right from all eight views. With Hildegard linked, send it: `loop_submit` with `file_path` (a coding
   agent) or `text`/`data` (a chatbot), and a `note` on how you built it; OpenSCAD source goes in as it is and
   Hildegard renders it. Without Hildegard, write a spec and run the checker:

   ```sh
   echo '{"path": "heron.stl", "sheet": "round-1.png", "print": true, "size_mm": [40, 40, 120]}' > spec.json
   python3 scripts/review_mesh.py spec.json
   ```

   (`print` and `size_mm` only for a print; `"up": "y"` for a GLB; `bed_mm` and `max_triangles` are optional.) It
   prints the checks as JSON and writes the sheet to `round-1.png`: open that image and look at it.
2. **Look at the sheet.** Eight views at 45° steps, one above (or below, for a print, where the base is), and a row of
   black silhouettes. Grey clay is the surface; **magenta is a back face showing**: a hole, or faces turned inside
   out. Read the checks: `watertight`, `manifold`, `winding`, `volume`, `bodies`, `debris`, `size`, and for prints
   `units`, `bed`, `base`, `overhang`, `balance`.
3. **Critique honestly** (with Hildegard linked, `loop_critique`): answer every question, each with the view or check
   that shows it (`silhouette: no, back-left view reads as a blob; the neck and body merge`). Name one change. The
   questions, when you have no tool to ask: is the silhouette readable from every side, are the proportions right,
   does the back match the front's quality, is the base real, does it read at the size it will be seen, and which
   check failed. Write the answers in `rounds.md`.
4. **Change that one thing** in the script, rebuild, send the next round. Secondary forms (major muscle groups, fold
   forms, planes of the face) come only after the silhouette passes; tertiary detail (feathers, texture,
   inscriptions) last, and only where it will be seen.
5. **Finish** (with Hildegard linked, `loop_finish`) on the best round, which is not always the last, with a note that
   says what it is and what still fails. Without it, deliver that round's file and say the same.

Six rounds is the default for a model. If a check still fails at the end, say so; never call a model printable when
`watertight` or `bed` fails.

## 4. Getting a print right

- **Walls:** FDM at least 1.2 mm, resin 0.8 mm; details at least 0.4 mm; engraved text 0.6 mm deep and 5 mm tall.
- **Parts that fit together:** size them from the printer's clearance for the fit (`printer_profile` with Hildegard
  linked; otherwise ask your user what they measured, or use 0.2 mm per side for a sliding fit), never a guessed
  number.
  A part that has to work (a replacement, a bracket, a clip, anything measured off a photo or a listing) follows
  **hildegard-print**: evidence for every dimension, fits measured, every round sliced, a print sheet at the end.
- **Overhangs:** at most 45° from vertical, or plan supports, or chamfer the undersides. Reorient before redesigning.
- **The base** is part of the work: a plinth, real contact, the centre of mass over it (`balance`).
- **Hollow parts** (resin): drain holes.
- **Units:** if `units` warns, the model was made in metres or centimetres. Scale it, don't change the target.

## 5. Things that go wrong

- **Front-only modeling.** It looks right in the front view and is a slab from the side. Judge the side and back
  views first; they're where blockouts fail.
- **Symmetry left on.** A figure mirrored perfectly reads as dead. Break it once the masses are right: a turn of the
  head, a weight shift, uneven shoulders. A made object keeps its symmetry when it has a reason.
- **Detail too early.** Detail on a bad blockout locks the mistake in and makes the next round harder.
- **Noise as detail.** Random displacement isn't texture. Use form: planes, folds, grooves you could carve.
- **Booleans that leave slivers.** `debris` and `manifold` catch them; union with manifold3d, or remesh.
- **Marching cubes upside down.** A mesher can emit faces inside out: `volume` goes negative and the views go magenta.
  `mesh_kit.mesh_sdf` orients them; anything else, flip the faces.

## 6. Deliver

The chosen round's file (with Hildegard linked, the link `loop_finish` gives), the sheet, and the build script so the
user can change it.
For viewing, offer a turntable (Blender: an empty at the origin, the camera parented to it, 360° over 96 frames) or a
`<model-viewer>` page pinned to an exact version. State plainly what was measured (Hildegard's checks) and what wasn't
(it hasn't been printed or held). No weapons or weapon parts, in any form.
