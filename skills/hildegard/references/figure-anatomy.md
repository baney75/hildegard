# The figure: anatomy, proportion, gesture, hands, heads and expression

Load this whenever a person, a hand, a face or an animal body appears, in any medium: painted, drawn, sculpted, rendered in 3D, or reflected in a pupil the size of a thumbnail. Pitfalls 2, 7, 8, 15 and 23 in SKILL.md are the failures this file prevents.

## How the masters studied, and what to take from each

- **Leonardo** (Royal Collection, Windsor; two campaigns, c.1490 and 1506–13, about thirty human dissections): he drew every structure from several directions, borrowing architects' plan, elevation and section. He showed layers stripped away in stages and built back up, used exploded views taken from engineering, and analyzed bones and muscles as machines. His proportion studies of about 1490 tried to force the body into simple fractions. He then measured living models, found the real ratios messier, and abandoned the scheme. *Take:* plan a figure from several views and in layers, think of joints as mechanisms, and trust measurement over theory.
- **Dürer**, *Four Books on Human Proportion* (1528): many body types, each with its own measured canon, rather than one ideal. *Take:* choose a body type on purpose: heavy, slight, old, young.
- **Paul Richer**, *Artistic Anatomy* (1890): the canon in head units, bony landmarks and surface form. It is dense, and it is the reference for proportion.
- **George Bridgman**, *Constructive Anatomy* and *Complete Guide to Drawing from Life*: masses as blocks, wedging and interlocking, with the rhythm of contours passing from one form to the next. It is best for building figures from imagination, as code must.
- **Andrew Loomis**, *Figure Drawing for All It's Worth* (1943) and *Drawing the Head and Hands* (1956): the 8-head ideal canon, the ball-and-plane head, and the mannequin built before the flesh.
- **Kimon Nicolaïdes**, *The Natural Way to Draw* (1941): gesture first. Draw what the pose is doing before what it looks like.
- **Glenn Vilppu**, *Vilppu Drawing Manual*: gesture, then the spiral and cylinder forms that follow it.
- **Michael Hampton**, *Figure Drawing: Design and Invention* (2009): gesture as a design of straights against curves, then simple forms, then anatomy hung on them.
- **Gottfried Bammes**, *Die Gestalt des Menschen*: the deepest constructive treatment of the figure, with superb diagrams of function.
- **Eliot Goldfinger**, *Human Anatomy for Artists* (1991): the contemporary reference, with muscles described one by one and photographs of live models beside dissections. Use it to check what a muscle does to the surface.
- **Stephen Rogers Peck**, *Atlas of Human Anatomy for the Artist* (1951): the clearest beginner's atlas.
- **Valerie Winslow**, *Classic Human Anatomy* (2009): the motion of each muscle group, and how it changes the surface.
- **Uldis Zarins**, *Anatomy for Sculptors* (2014): simplified 3D forms of every region, drawn the way a sculptor builds them. It is the best bridge from anatomy to code and 3D.
- **Gary Faigin**, *The Artist's Complete Guide to Facial Expression* (1990): the muscles of expression and the six universal emotions, each shown with its blends.
- **Paul Ekman and Wallace Friesen**, *Facial Action Coding System* (FACS, 1978): the expression of every face, split into numbered action units.
- **Scott Eaton** (anatomy for artists, digital sculpture): form simplified for sculpting, landmark by landmark. His published review of anatomy books ranks Richer, Peck, Goldfinger, Bammes, Bridgman and the Thieme atlas.

## The order of building, in every medium

1. **Gesture.** Find the line of action, the main curve of the whole pose. Find what the pose is doing: reaching, collapsing, bracing, resting. Design it with straights against curves (Hampton): a straight goes on the side under stress, a curve on the relaxed side.
2. **Balance.** Drop a plumb line from the pit of the neck. In a standing pose it lands on the supporting foot, or between both feet if the weight is split. If it misses, the figure falls over. `scripts/figure_rig.py` draws this line.
3. **The big masses.** The rib cage is an egg, the pelvis a bowl or box, the head a ball with a jaw. They are linked by the flexible spine and neck. In contrapposto, the shoulder line and the hip line tilt in opposite directions. The hip over the supporting leg rises, and the shoulder on that side drops.
4. **Limbs as tapered cylinders.** Put them in perspective, with elliptical cross-sections that show which way each one turns (Robertson). Overlap tells you what is in front of what.
5. **Landmarks.** Place the bony points that show through the skin; they never move with fat or muscle, so everything else is placed relative to them.
6. **Muscles that shape the surface,** only where they show at this size, distance and light.
7. **Contour rhythm.** Across a limb, the high point of the contour on one side sits opposite a low point on the other (Bridgman, Loomis). Two parallel contours look like a tube, not a limb.
8. **Light.** Light gives the planes (Asaro) and the turning edges. Put the hardest contrast at the focal point.

## Proportion (head units; head = chin to crown)

| Landmark (standing adult, measured from the ground up) | 7.5-head realistic | 8-head heroic (Loomis) |
|---|---|---|
| Crown | 7.5 | 8 |
| Chin | 6.5 | 7 |
| Shoulder line (acromion) | about 6.1 | about 6.6 |
| Nipples | about 5.4 | 6 |
| Navel and elbows | about 4.5 | 5 |
| Crotch (the midpoint of the height) | about 3.75 | 4 |
| Wrists | about 3.5 | about 3.8 |
| Fingertips (mid-thigh) | about 2.7 | 3 |
| Bottom of the kneecap | about 2.0 | 2 |

- **Widths:**
  - shoulders about 2 heads (men) or 1.7 (women);
  - hips about 1.5 heads at the iliac crest (men), widest at the trochanters for women, about 1.75–2 heads;
  - the head is about ⅔ as wide as it is tall.
- **Lengths:**
  - arm span ≈ height;
  - upper arm ≈ 1.5 heads, forearm ≈ 1.15–1.25, hand ≈ 0.75 (the face from chin to hairline);
  - foot ≈ 1 head (about the length of the forearm);
  - thigh ≈ 2 heads, shin ≈ 1.9.
- **Ages:** a newborn is about 4 heads tall, a 3-year-old 5, a 10-year-old 6, a 15-year-old about 7, an adult 7–8. In children the eye line sits below the middle of the head and the face is small under a large cranium. These ratios, more than any feature, decide whether a figure reads as a child (pitfall 23).
- **Sex differences** are tendencies to use on purpose, not rules:
  - male: a wider shoulder girdle, a narrower pelvis, a thicker neck, a more angular jaw;
  - female: a wider pelvis, a narrower waist, thighs that angle inward more toward the knee, fat padding over the hips and thighs.
- **Body types** (Dürer): set the masses before the details. A heavy figure has more fat over the same landmarks, so the bones still show at the knees, the wrists, the clavicles and the elbows.

## Landmarks that always show

- **Neck and shoulder girdle:** the pit of the neck (sternal notch), the clavicles (an S-curve seen from above), the acromion at the point of the shoulder, the seventh cervical vertebra at the back of the neck, the borders of the shoulder blade (it glides around the rib cage as the arm moves).
- **Rib cage:** its lower arch, and the sternum.
- **Pelvis:** the iliac crest; the front hip points (ASIS), which show as a bump even on heavy figures; the two sacral dimples at the back.
- **Arm:** the olecranon at the elbow; the head of the ulna on the little-finger side of the wrist; the epicondyles.
- **Leg:** the kneecap, with its fat pad below it; the tibial crest down the shin; the inner ankle bone, which sits higher than the outer one; the greater trochanter on the outer hip.

## Muscles that shape the surface

- **Neck:** the sternocleidomastoid, from behind the ear to the pit of the neck (a V on a turned head); the trapezius (the slope from neck to shoulder).
- **Shoulder and chest:** the deltoid wraps the shoulder like a cap and inserts halfway down the outside of the arm. The pectorals fold into the armpit; their lower edge is a strong shadow shape. The serratus shows as "fingers" along the side of the ribs.
- **Abdomen and side:** the rectus abdominis shows in three rows above the navel. The external oblique forms the "flank pad" overhanging the iliac crest.
- **Back:** the latissimus forms the V of the back; the erector muscles form a groove down the spine.
- **Arm:** the biceps and triceps. On the forearm, the flexors swell high on the inside and the extensors on the outside, so the forearm's widest point is near the elbow.
- **Leg:**
  - the gluteals;
  - the quadriceps, whose inner head (vastus medialis) is a teardrop low on the inside of the knee;
  - the sartorius, a diagonal strap across the thigh;
  - the hamstrings;
  - the calf, whose inner head sits lower than the outer one.
- **Tendons and veins** show at the wrist, the back of the hand, the ankle and the front of the neck on lean figures. Draw them only when the lighting and the figure's age call for them.

## Hands

- **The palm** is about as long as the middle finger. Its knuckles form an arc, not a straight line.
- **The fingers** each have three segments, decreasing in length (roughly the golden ratio), tapering, with nails that sit on the top plane. Fingers bend progressively: the little finger curls more than the index. Gaps between them are never equal.
- **The thumb** has three bones, including its metacarpal, which sits inside the palm. Its base, the ball of the thumb (thenar mass), is the largest form on the palm. The thumb opposes the fingers at an angle, not in the same plane.
- **A gripping hand** wraps around the object: the fingertips disappear behind it, and the object deforms the soft pads (pitfall 8).
- **Gesture reads in the wrist.** A bent wrist with relaxed fingers is gentle; a straight wrist with flexed fingers is tense.
- **In code,** build every finger as three tapered capsules on a curved knuckle line, then a palm mass and a thumb with its metacarpal. Check at 100% against a photograph of a real hand in the same pose (pitfall 7).

## Feet

- The **inner arch** is high and the outer edge touches the ground.
- The **inner ankle bone** is higher than the outer one.
- The **toes** step down in height from the big toe outward. The big toe is separated and points straight ahead; the others curl.
- Feet planted on a surface flatten slightly at the heel and the ball of the foot, and cast a contact shadow (the darkest value in the area).

## The head

- **Loomis's ball and plane.** The cranium is a ball, sliced flat at the sides. The brow line crosses the ball at its middle. The jaw hangs below it. Divide the face into thirds: hairline to brow, brow to the base of the nose, the base of the nose to the chin.
- **Placement:**
  - the eyes on the half-height of the head (lower in children);
  - one eye-width between the eyes;
  - the mouth's corners under the pupils;
  - the ears between the brow line and the base of the nose, set behind the head's midline in profile.
- **Planes (Asaro head):** the front plane of the face, the side planes of the cheeks, the under-plane of the nose and jaw, the brow ridge plane. Light describes these planes; shading follows them, not the outline.
- **Eyes:** see "Faces and eyes" in `images.md` (5a). The eyeball is a sphere, so the lids wrap it, and a lid's edge has thickness.
- **Nose:** the bridge, the ball, and the two wings with their nostrils. Its under-plane is in shadow under top light.
- **Mouth:** the upper lip overhangs. The lower lip has a lit top plane and a shadow underneath it. The corners sit deep in the face, with a small fold of muscle at each.
- **Neck:** it rises from the shoulders at a forward angle. The head sits on its top, set back over the spine, not centered over it.

## Expression

Decide the emotion before building the face. Then set the brow, the lids and the mouth together. A single mismatched part (smiling mouth, flat lids) reads as false.

| Emotion | Brow | Lids | Mouth and cheeks | FACS units |
|---|---|---|---|---|
| Sorrow | inner ends raised and drawn together (an oblique brow) | upper lids droop at the outer corners | corners pulled down; chin puckered | 1+4, 15, 17 |
| Joy, genuine | relaxed | lower lids pushed up by raised cheeks; crow's feet | corners pulled up and back | 6+12 |
| Social smile | relaxed | unchanged | corners up only | 12 (with no 6, it reads as polite or false) |
| Anger | lowered and drawn together | upper lids raised and lower lids tensed; a hard stare | lips pressed thin, or open and squared | 4+5+7, 23/24 |
| Fear | raised and drawn together | the whites show above the iris | lips stretched sideways | 1+2+4+5, 20 |
| Surprise | raised and arched | wide open | jaw dropped, relaxed | 1+2, 5, 26 |
| Disgust | lowered | narrowed | nose wrinkled; upper lip raised | 9, 10 |
| Contempt | neutral | neutral | one corner tightened | one-sided 14 |
| Tenderness or compassion | inner ends slightly raised | soft lower lids slightly raised; pupils dilated | a slight lift at the corners | 1 (light) + 6 (light) + 12 (light) |
| Concentration | lowered | slightly narrowed | lips pressed | 4, 7, 24 |

- **Blends tell the story.** Grief that is still loving is sorrow's brow with tenderness's lids (Faigin's blends).
- **Intensity scales** from a trace to the extreme. Hold the extremes for the moments that need them.
- **The eyes alone carry most of it.** A covered mouth still reads; covered eyes don't.

## Gesture, weight and motion

- **Weight goes somewhere.** A standing figure shifts its weight onto one leg (contrapposto). A seated figure's weight sits on the sitting bones, with the thighs on the seat (pitfall 8). A leaning figure needs something to lean against.
- **Pinch and stretch.** One side of the torso compresses while the other stretches. Folds of flesh and cloth gather on the compressed side.
- **Twist** between the rib cage and the pelvis gives a figure life. A figure with its rib cage, pelvis and head all facing square to the viewer looks like a mannequin.
- **For animation,** apply Thomas and Johnston's twelve principles from *The Illusion of Life* (1981): squash and stretch, anticipation, staging, straight-ahead versus pose-to-pose, follow-through and overlapping action, slow in and slow out, arcs, secondary action, timing, exaggeration, solid drawing, appeal. Richard Williams's *The Animator's Survival Kit* (2001) shows them applied to walk cycles and weight shifts.

## Building figures in code

Read `code-rendering.md` for the techniques that make code figures look real: SDF ray-marching with part-id debug renders; nails and creases in a local frame; height-field faces; hair as clumped strands; lids around a real eyeball. Measure every face and limb with `scripts/canon_check.py`. These measured rules caught real errors in Making an Icon of the Word:
- **face thirds** equal (Leonardo, Codex Atlanticus; Loomis). The measured 288 / 458 / 382 px meant a forehead too short, corrected to about 390 / 400 / 390;
- **the space between the eyes** = one eye width (Leonardo, Ms. A);
- **elbow to fingertip** = ¼ of the height; **forearm** = 1.5 hand lengths (Leonardo). A forearm foreshortened toward the viewer keeps its length as depth: 1302 px on the picture plane against about 1570 needed, so the hand sits about 880 px forward of the elbow;
- **the wrist** is twice as wide as it is thick (Bridgman), so build it as a flattened capsule, not a round one;
- **the elbow at the waist** when the arm hangs (the academic canon);
- **trace every limb from its root joint** (shoulder, elbow, wrist, hand), even under cloth (pitfall 30).

1. **Rig first.** `scripts/figure_rig.py` places a proportioned, posable mannequin in head units: posed by joint angles, checked for balance by its plumb line, and written out as a JSON of 2D joint positions. Pose it, view it from front, side and three-quarter (Leonardo's multiple views), and only then hang the flesh on it.
2. **Flesh as volumes.** Use tapered capsules and ellipsoids joined with a smooth minimum (Inigo Quilez's `smin`), so masses blend at the joints instead of meeting at seams. Draw from back to front, sorted by depth.
3. **Overlap and silhouette.** Check the silhouette alone, as a black shape: does the pose read? Where limbs cross the body, the near one overlaps with a clean edge.
4. **Contact.** Hands wrap, feet plant, and bodies sit with real weight (pitfall 8). Every contact gets a dark contact shadow.
5. **Clothing next** (see `clothing-drapery.md`), then light.
6. **Small figures** need proportion, silhouette and one motivated light, not features (pitfall 23). **Large figures** need landmarks, contour rhythm and correct hands, or they become the weak point in an otherwise strong piece (pitfall 2).
7. **When code anatomy would still be crude,** say so in the interview and offer options: the user's own photo as reference, a rig built from real reference photos, an AI base with the user's okay, or a style that hides what code can't draw (backlit silhouette, tenebrist shadow, distance).

## Checklist (run on every figure before delivery)

- [ ] The plumb line lands on the supporting foot or feet.
- [ ] The proportions match the intended age and body type, and are measured, not eyeballed.
- [ ] The rib cage and pelvis tilt and turn against each other; the pose isn't square-on.
- [ ] Each landmark visible at this size is in place: clavicles, the pit of the neck, the knees, the ankles, the wrists.
- [ ] Contours alternate in rhythm; there are no parallel-tube limbs.
- [ ] Each hand has its palm mass, three-segment fingers and a thumb rooted low, and is checked at 100% against a photo.
- [ ] Each contact point has weight and a contact shadow.
- [ ] Brow, lids and mouth agree on one emotion, and that emotion is the one the claim needs.
- [ ] A fresh eye, asked "who is this, how old, what are they doing?", answers as intended.
