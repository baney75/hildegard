# Objects, perspective and materials

Load this whenever an object carries meaning or must be exactly right: hardware, tools, vessels, furniture, books, phones, weapons in historical scenes, vehicles, architecture.

## Sources

- **Scott Robertson and Thomas Bertling, *How to Draw* (2013) and *How to Render* (2014):** perspective grids, ellipses, construction through sections, and form rendered by light and material. These are the industrial-design method for drawing anything from imagination.
- **Andrew Loomis, *Successful Drawing* (1951):** perspective and form for illustrators.
- **James Gurney, *Color and Light* (2010) and *Imaginative Realism* (2009):** how light behaves on materials, and how to make invented things believable with maquettes and references.
- **Harold Speed, *The Practice and Science of Drawing* (1913):** line versus mass, and seeing in values.
- **Margaret Livingstone, *Vision and Art: The Biology of Seeing* (2002):**
  - value (luminance) gives depth and form, through a color-blind "where" pathway;
  - color carries identity, through the "what" pathway;
  - shading at constant luminance looks flat;
  - two equally bright colors next to each other shimmer, because the edge between them is lost (Monet's sun in *Impression, Sunrise*).

  *Take:* get the values right first, and put equal-luminance colors side by side only when you want them to vibrate.
- **The glTF 2.0 metallic-roughness PBR model,** and Disney's principled BRDF (Burley, 2012): the standard vocabulary for materials in 3D. It is also useful in 2D painting.

## Construction

- **Measure the real thing.** Research the object's real dimensions, proportions, materials and details: ports, screws, seams, labels, wear (pitfalls 1 and 6). Save photos from several angles. Never draw a generic version of a specific object.
- **Box first.** Put every object in a bounding box drawn in correct perspective, then carve it. Cylinders start as boxes with their ellipses inscribed.
- **Ellipses:**
  - an ellipse's minor axis lines up with the axis of the cylinder it belongs to;
  - ellipses open up (become rounder) the further they are from the horizon line;
  - all the ellipses on one cylinder share the same minor axis.
- **Sections.** Cross-section lines (cross-contours) wrapped over the form show its curvature. Draw them in planning even if they don't appear in the final.
- **Mirror and repeat.** Symmetric objects are built from a centerline. Repeated parts (keys, spokes, columns) are spaced in perspective with diagonals, not with equal screen distances.
- **Scale cues.** A known object (a hand, a door, a coin) sets the scale of an unknown one. Objects handled by a figure are sized against the hand.
- **Use and orientation.** Objects face the person using them (pitfall 9). A held object is gripped where it is meant to be gripped, and its weight shows in the hand and arm.

## Light on materials

Every surface has a lit side, a terminator (the turning edge), a core shadow just past it, reflected light within the shadow, and a cast shadow. The cast shadow is darkest and sharpest at the contact point (the occlusion shadow).

| Material | Diffuse | Specular and reflection | Signature |
|---|---|---|---|
| Matte (plaster, unglazed clay, chalk) | strong; soft terminator | almost none | pure value modeling |
| Plastic and paint | colored | white highlight, moderately sharp | glossy plastic shows the light's shape |
| Metal | almost none | reflections tinted by the metal's color (gold reflects gold) | high contrast; reflects its surroundings; dark where it reflects the dark |
| Glass and water | none | reflections stronger at grazing angles (Fresnel) | refraction distorts what's behind it; bright edges, caustics |
| Skin, wax, marble, jade, leaves | soft | soft sheen | subsurface scattering: light enters, scatters and comes out redder or warmer at the terminator and in thin parts such as ears and fingers |
| Wood | colored, following the grain | a sheen depending on finish | the grain follows the form and the cut |
| Cloth | see `clothing-drapery.md` | | |
| Screens | emitted light; set the content's brightness separately | the glass on top reflects the room | emitted light lights faces and hands with its color (Who Do You Say That I Am?) |

- **Fresnel applies to everything.** Every surface reflects more at grazing angles, which gives the edges of objects their rim of sheen.
- **Roughness spreads highlights.** A rough surface has a large, dim highlight; a polished one has a small, bright one.
- **Color temperature.** The light's color tints the lit side; the sky or the ambient light tints the shadows. Warm light gives cool shadows (Gurney).

## Wear, history and truth

Objects tell where they have been:
- worn edges and corners;
- dirt and grime in the crevices;
- polish where hands touch them;
- scratches around keyholes and screws;
- labels, fading and repairs.

Put the wear where use would put it, and use it to tell the object's story. Clean, new, perfect objects read as renders, not as things.

## Objects in code

- **Simple objects** (boxes, cylinders, panels): draw them through one projection helper (5a step 1), as polygons with face shading computed from each face's normal and the light.
- **Complex objects** (hardware, vehicles, anything with curved, joined surfaces): model them in Blender, or with trimesh and manifold3d. Render with the scene's light and camera, then paint over or composite. A real 3D model gives correct perspective, occlusion and reflections for free.
- **Text on objects** (labels, screens, inscriptions): render it into the object's surface with the object's perspective transform, then check it at 100% (pitfall 20).
- **Fine details** (ports, screws, LEDs) go on the crisp layer (pitfall 12), drawn in the object's perspective.

## Checklist

- [ ] The object is a specific, researched one, with its dimensions and details right.
- [ ] Perspective is consistent: one horizon, the ellipses agree with their axes, and repeated parts are spaced by diagonals.
- [ ] The material is identifiable from its highlight, reflection and shadow.
- [ ] Contact shadows and occlusion are present wherever it touches something.
- [ ] It faces its user and is held where it is meant to be held.
- [ ] Wear and history sit where use would put them.
