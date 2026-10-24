# Clothing and drapery

Load this whenever cloth appears: garments, curtains, flags, tablecloths, shrouds, veils, banners.

## Sources

- **Leonardo's drapery studies:** brush and tempera on linen, gray and white heightened. Vasari reports that Leonardo set clay figures under soft cloth dipped in clay slip and drew the folds from them. *Take:* study the drapery separately from the figure, on a still model, in one light.
- **Dürer** made drapery studies that followed the folds' logic rigorously.
- **George Bridgman, *Drawing the Draped Figure*:** folds follow the forms underneath and radiate from points of support.
- **Burne Hogarth, *Dynamic Wrinkles and Drapery* (1992):** a vocabulary of fold types and the forces that cause them (below).
- **Classical sculpture's wet drapery** (the Parthenon goddesses, the Nike of Samothrace): cloth clings to show the form underneath and flies free where it is released. *Take:* drapery can reveal the body or hide it; decide which, part by part.
- **Period dress:** research it (pitfall 6). Garments, closures and how they are worn change by era, region and class. A first-century Judean man wears a linen or wool tunic (*chiton*) and an outer mantle (*himation*), with sandals. Never put a modern hem, zip or seam on a period figure.

## The physics in four rules

1. **Support points.** Cloth hangs from where it is held up: the shoulders, the hips, the bent elbows and knees, a hand, a nail. Folds radiate from those points.
2. **Tension and compression.** Between two support points under stretch, folds run straight and the cloth is taut. Where a joint bends, the cloth compresses and folds pile up on the inside of the bend. Find the tension lines first; they define the pose of the cloth.
3. **Gravity.** Free cloth falls straight down from its last support, in vertical tubes. Folds always describe which way is down.
4. **Material.** Weight and stiffness decide fold size and sharpness:
   - **Silk and satin:** many small, quick folds; sharp, bright highlights; deep shadows.
   - **Fine cotton and linen:** crisp, angular creases that stay put.
   - **Wool:** fewer, broader, rounder folds; soft highlights.
   - **Denim and canvas:** stiff tubes with ridged compression folds at the joints; few drape lines.
   - **Leather:** few heavy folds with bunched creases; specular highlights; worn and lighter at the edges.
   - **Knits:** they stretch over forms, hug the body, and fold softly.

## Hogarth's seven folds

| Fold | Cause | Where it appears | How to draw it |
|---|---|---|---|
| **Pipe** | cloth hanging from one support point or line | curtains, skirts, the hem of a robe, a hanging sleeve | parallel tubes widening as they fall, each lit as a cylinder |
| **Diaper** | cloth suspended between two support points | a cowl neck, a sling, the drape between two hands, a hammock | sagging catenary curves, deepest a little off-center; often contains pipe and drop folds |
| **Drop** | cloth falling over a form or edge | a tablecloth's corner, a cape off a shoulder, a scarf | cascading cone shapes from the edge downward |
| **Zigzag** | a tube of cloth buckled by compression, with no pinch point | the inside of a bent elbow, a trouser bottom on the shoe, a sleeve pushed up | alternating diagonal folds snaking toward the viewer |
| **Spiral** | cloth wrapped and twisted around a cylinder | a sleeve on a raised arm, a towel wrapped around something, a twisted waistband | diagonal folds winding around the form. Loosen tight spirals, or they read as stripes |
| **Half-lock** | a tube of cloth bending sharply, so the fold locks on itself | behind the knee, the inside of a sharply bent elbow, a trouser leg kinking at the knee | a closed, flattened fold where the tube changes direction; open it into a zigzag if it reads badly |
| **Inert** | cloth at rest on a surface with no tension | a garment pooled on the floor, a dropped cloak | soft, random, low folds. It reads as weak, so use it sparingly, where stillness is the point |

## Garments are built objects

- **Flat patterns.** Garments are sewn from flat pieces. Seams follow the body, and they reveal form: a side seam turns around the torso, a shoulder seam runs over the top of the shoulder.
- **Hems, cuffs and necklines** are ellipses in perspective. Their curvature shows the angle of the form they wrap.
- **Stripes, plaids and patterns** act as cross-contour lines. They curve over forms, compress in folds, and break at seams. They show more form than shading does.
- **Closures, layers and thickness.** Buttons pull the cloth in tension lines between them. A coat is thick at its edges. Layered garments overlap in order, and each casts a shadow on the one below.
- **Wear tells history.** Cloth wears lighter at the knees, elbows and edges, and stains, frays or creases where it is handled. A garment carries the story of its wearer.

## Light on cloth

- **Each fold is a cylinder or a cone.** Give it a lit side, a core shadow, reflected light, and a cast shadow where it overhangs the next fold.
- **Highlights** are broad and soft on matte cloth, and narrow and bright on silk and satin. Velvet is the reverse: its highlights sit at the silhouette edges, not facing the light.
- **The deepest darks** are in the hollows of compression folds and under overhanging folds (occlusion).
- **Translucent cloth** (a linen veil, gauze) shows the form beneath through its value, and glows where the light passes through it.

## Building drapery in code

- **Simulate when you can.** In Blender, use the Cloth modifier with a collision body (the figure) and pin groups for support points. Set the mass and stiffness for the material, simulate, then apply and render or sculpt over it.
- **Draw it in 2D or as a heightfield:**
  1. Mark the support points on the figure rig.
  2. Draw tension lines between support points (straight under stress) and gravity lines from free edges (vertical).
  3. Build each fold as an elongated ridge along those lines, with its width and spacing set by the material. Silk is narrow and dense; wool is broad and sparse.
  4. Pile the folds into zigzags on the inside of bent joints.
  5. Light the heightfield with the scene's light, using cylinder shading for each fold.
  6. Draw the hem as an ellipse that waves with the folds that end at it.
- **Check the silhouette.** Clothes change the silhouette. Loose cloth hides the body's line, and the pose must still read through it.

## Checklist

- [ ] Each fold radiates from a support point, or piles up at a compression point, or falls by gravity. No fold appears for no reason.
- [ ] The material is identifiable from fold size, sharpness and highlight.
- [ ] Hems and cuffs are ellipses that agree with the form's angle.
- [ ] Patterns and seams follow the form and break at folds.
- [ ] The garment is correct for the era, region and role, with its research noted.
- [ ] Fold shadows and cast shadows obey the scene's single light logic.
