# Parts, fits and print pose

Adapted from print3d's parts-and-fits and modelling guides by mfranzon (MIT; see THIRD_PARTY_NOTICES.md).

For anything that's more than one solid: a box and its lid, a case in two halves, a pin in a hole, a knob on a
shaft.

## Model it assembled, each part named

Build every part **where it sits when the thing is put together**. That pose is where Hildegard measures fits, what
the likeness check compares with a photo, and what the print sheet shows. Name each part: `o name` in OBJ, a node in
GLB, `solid name` in an ASCII STL.

```python
from mesh_kit import *        # hildegard-3d's scripts/mesh_kit.py

slide = 0.20                  # from printer_profile: never a guessed number
bore = 10.0                   # spec: measured, ± 0.2
sleeve = tube(r_in=bore / 2, r_out=bore / 2 + 4, h=20)
pin = cylinder(r=bore / 2 - slide, h=24, base=(0, 0, -2))
open("hinge.obj", "w").write(parts_obj_text({"sleeve": sleeve, "pin": pin}))
```

Then in `loop_start`: `"fits": [{"a": "pin", "b": "sleeve", "kind": "slide"}]`, and if a part prints in another pose,
`"print_pose": {"lid": [180, 0, 0]}` (degrees about x, y and z from assembled to printed). The STLs Hildegard writes
for a passing round stand on the bed in that pose.

## Fits

| Fit | Feels like | Default per side |
| --- | --- | --- |
| `press` | pressed or tapped in, stays put | 0.05 mm |
| `snug` | pushes in by hand, holds | 0.10 mm |
| `slide` | moves without play | 0.20 mm |
| `free` | turns or drops in loosely | 0.35 mm |

Read this printer's from `printer_profile`; calibrate them once with the fit coupon (SKILL.md). Size the mating
feature from the fit: a lid plug that slides into a 36 mm opening is `36 - 2 * slide` wide; a hole for a 5 mm pin that
must be snug is `5 + 2 * snug` across.

What each round measures between every two parts that come within 2 mm:

- **interference** (fails): one part pokes into the other. They won't go together.
- **fits** (warns): a declared fit whose gap is tighter or looser than its clearance, a declared pair that wasn't
  modelled together, or two undeclared parts closer than a press fit but not touching, which fuse in the print.

Touching faces (a lid resting on a rim) are contact, not a fit. The gap is read from each part's vertices to the
other's surface, so a curved fit needs enough segments to be read to a hundredth: 64 or more on a 10 mm bore.

## The move each check asks for

| Check | It means | The fix |
| --- | --- | --- |
| `overhang` | undersides shallower than 45° that will droop without supports | chamfer them to 45°, or turn the part so they face up; turning is usually cheaper than redesigning |
| `base` | too little on the bed | widen the base, add a foot, or lay the part down |
| `slender` | tall and narrow; the nozzle can knock it off | lay it down, or give it a foot or a brim |
| `interference` | parts overlap as assembled | cut one back by the fit's clearance per side |
| `fits` | a gap off its clearance, or parts about to fuse | size the feature from the clearance; make parts touch, or open a real fit and declare it |
| `likeness` | the model doesn't match the photographed outline | turn it as named, fix the dimension that drives the size, or follow the red and blue on the sheet |
| `slice` | the slicer refused it | read why: off the bed, too tall, or a broken mesh |

Choosing the orientation first is the biggest single decision: the flattest large face on the bed, and most overhang,
base and slender failures go at once. Then think about strength: layers are weakest pulled apart, so a hook, a clip or
a bracket prints so its bend runs across the layers, not along them.

## Gotchas that cost a round

- **Coplanar faces in a boolean.** Overlap the cutter by 0.2 mm past the surface, or the solver leaves a skin or
  junk; `manifold` and `watertight` catch it. With trimesh, use the manifold3d engine.
- **A pocket cutter that ends flush** with a surface leaves a sealed void under an unbroken skin. Make cutters taller
  than what they cut.
- **Text extrudes both ways** in Blender: `extrude = t` makes a solid `2t` thick, centred on its origin.
- **Apply transforms before you measure** in Blender (`transform_apply`), or you read the unscaled mesh.
- **A round hole printed lying down** comes out egg-shaped and its top droops. Print holes that must be round
  vertical, or give a horizontal one a teardrop or a flat top.
- **The first layer squishes out** (elephant's foot): a feature that fits at the bed wants a 0.3 to 0.5 mm chamfer at
  its base.
- **Threads** under M8 rarely print well on FDM: model a hole for a heat-set insert or a nut trap, and say which to buy.
