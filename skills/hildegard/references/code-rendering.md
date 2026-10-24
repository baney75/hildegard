# Rendering convincing forms in code

Load this when a figure, hand, face, cloth or object must look real (or convincingly painted) and is being built in code rather than in a 3D app or from a photo. These techniques come from *Making an Icon of the Word*, in which the agent rebuilt a capsule-and-polygon hand, sticker nails, a floating arm and a helmet of hair until each one passed at 100%. They also come from *Who Do You Say That I Am?*, where a procedural eye had to sit inside a painted face.

## Decide the realism level first

The brief sets it. "Look like Christ… as though God is truly among us" implies naturalism, and so does "the hand must look real." A flat or symbolic figure is a valid choice only when it is chosen and said; never fall into one because it is quick to code (pitfall 28).

Decide in the interview how each body part will be made: SDF model, height field, the user's photo as underpainting, a 3D app, or an AI base with the user's okay. Then **build the hardest part first, alone, and judge it at 100%** before anything else is built around it. A good halo around a bad hand is a bad picture.

## Signed-distance ray-marching in NumPy (hands, sleeves, small 3D forms)

- **Primitives:**
  - tapered capsules for the phalanges and limbs;
  - rounded boxes for the palm, with the thenar and hypothenar pads as ellipsoids;
  - all joined with smooth minimum (Inigo Quilez's `smin`), so forms blend at the joints.
- **The march:** step 0.7–0.85 of the distance each iteration (a full step overshoots thin parts). Normals come from the central difference of the SDF.
- **Lighting:**
  - wrap diffuse;
  - soft shadows by marching from the hit point toward the light, keeping the minimum of k·d/t;
  - ambient occlusion from 4–5 offsets along the normal;
  - a red subsurface term at the terminator for skin;
  - a sharp specular for nails and wet surfaces.
- **Return depth** with every render, so separately rendered models (a hand, a sleeve, a book) can be depth-sorted and composited: a cuff closing around a wrist, fingertips over a book's edge.
- **Debug render colored by part id.** It is the only way to see which capsule is which when a finger bends wrong. Make one before the first lit render.

## Surface detail in the same local frame

Compute a local frame once per part (t along the bone, φ around it). Use it for **both** displacement and albedo, so creases, knuckle wrinkles and nails stay aligned in geometry and color.

**Nails, built from their anatomy, not as stickers** (pitfall 29):
1. a plate displaced slightly above the skin, set into lateral folds;
2. an arched cuticle;
3. a paler lunula;
4. a pink bed with faint lengthwise ridges;
5. a translucent free edge;
6. a sharp specular.

The same rule applies to every feature: list its parts before modeling it, and research the parts if you can't list them.

## Height-field faces and drapery

- **The face:**
  - sum Gaussian forms: skull ellipsoid, brow ridge, sockets, cheekbones, the nose's bridge, ball and wings, lips, chin;
  - take the gradient for normals, and light with **the same light vector as everything else**;
  - cavity occlusion = blur(z) − z;
  - cheap cast shadows by marching the height field toward the light (Who Do You Say That I Am? used this for the brow's shadow on the lid).
- **Measure it against the canon** (`scripts/canon_check.py`): equal facial thirds, one eye-width between the eyes, the mouth's corners under the pupils. In *Making an Icon of the Word*, the thirds measured 288 / 458 / 382 px: a forehead far too short, visible all along, found only by measuring.
- **Drapery as a height field:** folds as elongated ridges running from tension points (`clothing-drapery.md`). Diaper folds sag between two supports; pipe folds fall from one. Never place folds at random.
- **Eyes:** model the lids around a real eyeball sphere: lid thickness, a shadow band on the sclera, the caruncle, a refraction pool and tinted catchlight. The eye in *Making an Icon of the Word* stayed weak until this was done.

## Hair and beards

- **Strands, not a shape.** Draw thousands of streamlines along a flow field. Distance-transform tangents work for hair falling from the scalp; convergent fields work for a forked beard.
- **Clump the strands into locks** (groups that share a direction and a highlight). A smooth curtain of hair reads as a helmet; this was still the weak point in *Making an Icon of the Word*.
- **Sheen:** Kajiya-Kay-style anisotropic highlights across the strand direction. Bucket the strands into brightness layers, and draw dark underlayers first.
- **Brows and lashes** are separate strand sets with their own directions (`figure-anatomy.md`).

## Text that follows form (words as the medium)

- **Evenly spaced streamlines** (Jobard and Lefer, 1997) over a direction field give lines of text that follow the forms:
  - rings around a halo;
  - cross-contour lines on a face;
  - strand-parallel lines in hair;
  - fold-parallel lines in robes;
  - lines along fingers.

  Interpolate the direction field from a few guide curves (KD-tree, with doubled-angle averaging so axial directions don't cancel).
- **Shape each word once, cache it,** rotate it to the local tangent, and max-composite it into a coverage mask.
- **Tone-preserving text,** so the painting survives at any distance while each word stays legible up close. With target tone t, coverage c and contrast d: `ink = t + d·(1−c)·tint` and `ground = t − d·c`. The local mean then equals the painting. (The ASCII form in `images.md` (5a), `bg = (c − cov·ink)/(1 − cov)`, is the same idea.)
- **Rings need a random start angle and a fixed reading direction** (pitfall 34). Starting every ring at angle 0 leaves a dark radial seam where all the line ends meet. Rings whose direction flips from run to run read as errors.
- **Text infrastructure first** (pitfall 20): before any image, prove every script that will appear. Pull the fonts (`@fontsource` on npm), merge subsets with fontTools if needed, and render a test sheet with HarfBuzz/Raqm shaping. Arabic and Syriac must join; Hebrew must run right to left. A wrong glyph in a sacred text is a silent, permanent defect.

## Memory on 8 GB machines

A full-size underpainting at 4800×6000 can need more than 5 GB at half size. Paint at half size, upscale, then re-render only the parts that must be sharp (skin, eyes, hands, lettering) at full size into their region masks. Draw words and lettering at full size directly. See also "Large renders" in `images.md` (5a).

## Joining realism to a tradition

When a naturalistic method meets a stylized tradition (an icon, a woodcut, a mosaic), make them meet rather than compete. Keep the tradition's grammar: gold ground, frontality, inscriptions, the icon painter's gold highlight lines (assist) along fold ridges, the canonical colors (the red chiton of divinity, the blue himation of the humanity He put on). Let the realism live inside that grammar: the hands, the face, the weight of the cloth. Research the tradition's canon (the painter's manuals such as Dionysius of Fourna's *Hermeneia*; the Sinai Pantocrator; Rublev; the Monreale and Cefalù mosaics) as hard as the anatomy.

## Checklist

- [ ] The realism level was set in the interview, and the method for every body part is chosen.
- [ ] The hardest part was built first, alone, and passed at 100% before the rest.
- [ ] A part-id debug render exists for every multi-part model.
- [ ] Every feature is built from its anatomical parts, not as a symbol.
- [ ] Faces and limbs are measured against the canon (`canon_check.py`), with the numbers recorded.
- [ ] After any part becomes more real, its neighbors were re-audited (pitfall 33).
- [ ] Hair is in locks with anisotropic sheen; eyes have lids built around a sphere.
- [ ] Text rings have random starts and a fixed reading direction, and every script was proven on a test sheet first.
