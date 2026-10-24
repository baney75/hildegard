# Sculpture and 3D: sculpting, modeling, printing, rendering

Load this for any 3D work: digital sculpture, models for viewing, AR or games, 3D printing, reliefs, renders, turntables, photogrammetry. The original 5d guidance and the 3D check script follow the new material at the end of this file.

## Sources

- **Uldis Zarins and Sandis Kondrats, *Anatomy for Sculptors: Understanding the Human Figure* (2014):** anatomy simplified into sculptable 3D forms, region by region. It is the first book to open for figures in 3D.
- **Scott Eaton** (anatomy and figure sculpture courses; écorché work): forms as simplified planes and masses; landmarks before muscles.
- **Rafael Grassetti, and the ZBrush and Blender character-art community** (ArtStation breakdowns, The Rookies, Gnomon workshops): the blockout-to-detail pipeline used in film and games.
- **Michelangelo:** freeing the form from the block. *Take:* work from the largest masses inward. Bernini (*Apollo and Daphne*, *The Ecstasy of Saint Teresa*): stone made soft, captured motion, theatrical light.
- **Rodin:** surface as light-catcher, modeled in profiles. He turned the clay to check the contour from every angle, the silhouette method in physical form.
- **Classical sculpture's contrapposto** (Polykleitos's *Doryphoros* and the canon) and its wet drapery (`clothing-drapery.md`).
- **Blender documentation** (Sculpt Mode, Multires, Remesh, Geometry Nodes, Cycles and Eevee) and the Blender Conference talks, such as "Construction of the Human Head: Blockouts, Landmarks, Phenotypes" (2023).
- **Inigo Quilez's articles** on signed distance fields and smooth minimum (`smin`): the math for building organic forms in code.

## The sculpting pipeline (the same in clay, ZBrush, Blender or code)

1. **Reference sheet.** Front, side and back orthographic views (drawn, or photographed with a long lens), plus detail photos. Measure in a unit (head units for figures, `figure-anatomy.md`).
2. **Armature and gesture.** The pose's line of action and its proportions first, as a stick figure or `scripts/figure_rig.py` joints.
3. **Blockout (primary forms).** Big, simple masses: spheres, boxes, cylinders, capsules. Get proportion, gesture and silhouette right from **every** side before any detail. Check eight views. Stay low-resolution; detail locks in mistakes.
4. **Secondary forms:** major muscle groups, fat pads, main fold forms of the drapery, facial features as planes (Asaro head). Remesh or dynamesh as the form changes.
5. **Tertiary detail:** wrinkles, pores, fabric weave, bark grain, inscriptions. Only after the larger forms pass the silhouette and proportion checks, and only where they'll be seen (normal maps for viewing models).
6. **Break the symmetry:** turn off symmetry and adjust for life: a tilt of the head, uneven shoulders, a weight shift. Perfect symmetry reads as dead.
7. **Retopology and UVs** (for animation, games or texturing): clean quad topology following the muscle flow, loops around the eyes and mouth. Bake the high-poly detail to normal and displacement maps.
8. **Materials:** PBR (base color, roughness, metallic, normal). Use real references for each material (`objects-materials.md`).
9. **Light and render:** key, fill and rim lights, a contact shadow, and the camera lens chosen on purpose (longer lenses flatter figures). Then turntables and beauty shots.

## Building in code

- **Signed-distance modeling:** build each form as an SDF (sphere, capsule, ellipsoid, rounded box). Join them with smooth minimum (`smin(a, b, k)`) so they blend organically; subtract with smooth max. Evaluate on a grid, then extract a mesh with `skimage.measure.marching_cubes`; smooth and decimate it. This is the best route for organic sculpture without a sculpting app.
- **Blender, headless** (`blender -b -P build.py`, or `pip install bpy` for the matching Python version):
  - primitives, modifiers (Subdivision, Multires, Remesh, Displace, Boolean, Solidify);
  - Geometry Nodes;
  - the Cloth modifier for drapery;
  - Cycles or Eevee for renders.

  Script a turntable: an empty at the origin, the camera parented to it, rotating 360° over N frames, rendered to PNGs, then ffmpeg to MP4.
- **trimesh + manifold3d:** booleans, extrusions of SVG outlines (through shapely), and print-ready solid geometry.
- **Reliefs, coins and lithophanes:** a heightmap image converted to a mesh. Lithophane thickness maps from 0.6 mm (light) to about 3 mm (dark).
- **Photogrammetry and depth to mesh** (turning images into geometry): photogrammetry from 40 or more overlapping photos (Meshroom or COLMAP), or monocular depth estimation turned into a displaced plane for 2.5D parallax. Clean up the mesh and fill holes afterward.

## Checks specific to sculpture

- **The silhouette** reads from eight views: as black shapes on a contact sheet (`scripts/contact_sheet.py` over the turntable frames).
- **Proportion** is measured against the reference in units, not judged by eye.
- **Weight:** the plumb line from the pit of the neck lands on the supporting foot. The base makes physical sense: the center of mass sits over the footprint, or the piece will tip when printed.
- **Form hierarchy:** primary forms still read with detail turned off; the details don't break up the big planes.
- **Light test:** a single raking light reveals lumps, flat spots and noise that a frontal light hides.



## Original 5d notes: models, printables, renders

**Decide what the model is for:**
- **To view:** GLB with PBR materials (base color, roughness, metallic, normal), Y-up, meters, centered. Put detail in normal maps.
- **To print:** STL or 3MF in millimeters, Z-up, a flat base, a watertight manifold body (or deliberately separate parts), sized to the bed.
  - FDM: walls ≥ 1.2 mm, details ≥ 0.4 mm, overhangs ≤ 45° or supports planned, engraved text ≥ 0.6 mm deep and 5 mm tall.
  - Resin: walls ≥ 0.8 mm, with drain holes in hollow parts.
- **To render:** 5a and 5b apply, with key, fill and rim lights and a contact shadow.

**Build, best first:**
- Blender headless (`blender -b -P build.py`, or `pip install bpy` for the matching Python version);
- trimesh + manifold3d for booleans and extrusions of SVG outlines (via shapely);
- signed-distance fields + `skimage.measure.marching_cubes` for organic forms, then smooth and decimate;
- a heightmap turned into a mesh for reliefs, lithophanes and coins;
- `<model-viewer>` or three.js, pinned to an exact version, in an artifact for viewing.

**Sculptural craft:**
- a silhouette that reads from eight views;
- proportions taken from reference;
- weight and gesture (contrapposto, a clear line of action);
- the base as part of the work, with real contact (pitfall 8);
- hands per pitfall 7;
- detail scaled to the nozzle or the viewer's zoom;
- the up-close layer: an inscription under the base, or a motif in a hollow.


## Checks (from the original step 6)

**3D.** Run this on the final GLB, STL or 3MF (add `--print` for printables), then also make real renders:

```python
# usage: python3 inspect_3d.py model.glb [--print]   -> prints facts, writes inspect/views.png (4 views)
import sys, os, numpy as np, trimesh
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d.art3d import Poly3DCollection
s = trimesh.load(sys.argv[1], force="scene"); mesh = s.to_geometry() if hasattr(s, "to_geometry") else s.dump(concatenate=True)
e = mesh.extents
print(f"faces {len(mesh.faces)}  vertices {len(mesh.vertices)}  extents {e.round(2)} (units as authored; print = mm)")
print(f"watertight {mesh.is_watertight}  winding consistent {mesh.is_winding_consistent}  bodies {len(mesh.split(only_watertight=False))}")
if mesh.is_watertight: print(f"volume {mesh.volume:.1f}  (negative = inverted normals)")
if "--print" in sys.argv:
    n = mesh.face_normals; over = (n[:, 2] < -np.cos(np.radians(45))) & (mesh.triangles_center[:, 2] > mesh.bounds[0, 2] + 0.5)
    print(f"overhang >45deg area {mesh.area_faces[over].sum()/mesh.area*100:.1f}% of surface  base z {mesh.bounds[0, 2]:.2f}")
os.makedirs("inspect", exist_ok=True)
f = mesh.faces if len(mesh.faces) <= 60000 else mesh.faces[np.random.default_rng(0).choice(len(mesh.faces), 60000, replace=False)]
tri = mesh.vertices[f]; light = np.array([.4, -.5, .75]); light /= np.linalg.norm(light)
nn = np.cross(tri[:, 1]-tri[:, 0], tri[:, 2]-tri[:, 0]); nn /= np.linalg.norm(nn, axis=1, keepdims=True) + 1e-12
shade = np.clip(.25 + .75*np.abs(nn @ light), 0, 1)
fig = plt.figure(figsize=(14, 4)); c, r = mesh.bounds.mean(0), e.max()/2
for i, (el, az, name) in enumerate([(0, -90, "front"), (0, 0, "side"), (90, -90, "top"), (25, -55, "3/4")]):
    ax = fig.add_subplot(1, 4, i+1, projection="3d"); ax.add_collection3d(Poly3DCollection(tri, facecolors=plt.cm.gray(shade), linewidths=0))
    for setl, k in ((ax.set_xlim, 0), (ax.set_ylim, 1), (ax.set_zlim, 2)): setl(c[k]-r, c[k]+r)
    ax.view_init(el, az); ax.set_box_aspect((1, 1, 1)); ax.set_axis_off(); ax.set_title(name)
plt.tight_layout(); plt.savefig("inspect/views.png", dpi=110); print("wrote inspect/views.png: view it (silhouette check only; judge surfaces in real renders)")
```

Pass when:
- **For printing:** the mesh is watertight, has the intended number of bodies and a positive volume, measures in millimeters, fits the bed, has its base at z = 0 and a low overhang share, and walls checked by cross-section (`mesh.section`).
- **Renders:** proper renders from four to eight angles, plus a 100% close-up.
- **Viewer:** the GLB loads in the viewer artifact, confirmed with a screenshot.
