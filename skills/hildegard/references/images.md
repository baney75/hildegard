# Images: study, structure, then marks; and the image check

Load this for any picture: painting, drawing, print, vector, text art, covers, key art, film frames and 3D renders.
It is step 5a and the image half of step 6 of the method in `SKILL.md`.

## 5a. Building an image

1. **Camera and space first.** Fix the eye level and the vanishing point. Build everything through one projection helper, and give depth to anything that has it.
2. **Thumbnails, value studies, color comps.** Climb the drafting ladder in `references/drafting-storyboards.md`: 12–24 idea thumbnails, then 3 value studies, then 2–4 color comps, laid out on a labeled contact sheet (`scripts/contact_sheet.py`) for one reaction from the user. A composition that doesn't read at 256 px won't read at any size.
3. **Value, color and light.**
   - Three to five value masses.
   - One focal point, at the highest contrast.
   - A list of every light source (where it is, its color, what it falls on). Nothing glows without a source.
   - Color, as below.
4. **The underpainting (the target image).** Sources, best first:
   - the user's photo (5f);
   - a scene constructed in code, measured from references, or a 3D render (5d);
   - an AI base (Hildegard's stills or shots on the user's GPU, or another connected generator), only with the user's okay and disclosed.

   **Figures get a rig, not a doodle** (read `references/figure-anatomy.md`, start from `scripts/figure_rig.py`, and dress them with `references/clothing-drapery.md`; objects follow `references/objects-materials.md`):
   - jointed limbs with inverse kinematics, so hands land exactly on what they touch;
   - sleeves and cuffs;
   - hands per pitfall 7;
   - heads whose expressions can change.

   Check contact (pitfall 8) and which way every prop faces (pitfall 9). Where code anatomy would still look crude, simplify or compose around it, and say so in the delivery. **Tiny figures** (reflections, figures in the distance) read through silhouette, proportion and one light, not through features. Build them from shaded signed-distance shapes at 3–4× supersampling: ellipses, capsules and rounded boxes. Check that the age and the action read (pitfall 23).
5. **The marks.** Render in the medium, coarse to fine:
   - **Brushstrokes:**
     - several passes, from a large brush to a small one;
     - strokes follow edges (perpendicular to the luminance gradient) and a gentle flow field, and stop when the color changes;
     - bristle texture: several thin offset lines with color jitter;
     - later passes paint only where the canvas still differs from the target;
     - tens of thousands of strokes is normal;
     - then the crisp layer on top (pitfall 12).
   - **Dots and stippling:**
     - density and size from value;
     - complementary and neighboring hues placed side by side, so they mix in the eye;
     - dots relaxed toward a weighted Voronoi (Lloyd) distribution.
   - **ASCII:**
     - glyphs chosen by shape and by density: match each cell's sub-block luminance pattern (about 6×5) to each glyph's coverage pattern, after a local-contrast boost so edges get `/ \ | _`;
     - a fixed grid (10×18 px cells at 4800 px wide keep letters legible at 100%);
     - **tone-preserving:** ink brighter than the cell, and a ground solved per cell so the cell's mean equals the target (`bg = (c − cov·ink)/(1 − cov)`). Otherwise code dims glows and kills the focal point. Use hard contrast (bright glyphs on a dark ground) only where the code should read as code;
     - **meaningful fill:** dense fill glyphs are replaced by text or symbols that carry the up-close layer, while edge glyphs keep the drawing. Run the text unbroken through its whole region, so it reads, rather than through scattered cells;
     - symbols spanning 2×2 cells, since a 10×18 symbol is illegible;
     - checked in the target font.
   - **Dissolving one medium into another:** use a field (distance from the subject) plus low-frequency noise stretched horizontally on the cell grid, so the change arrives in runs like lines of code. Force the cells the claim depends on (the focal point, the receiver of the action) to stay in the medium they belong to.
   - **Watercolor:** translucent washes with deformed edges, reserved whites, pigment pooling at the edges.
   - **Vector:** clean geometry, a hierarchy of stroke weights, nothing that turns to mush small.
6. **The up-close layer.** Hide the second reading in the real structure of the scene, such as window mullions, a pole and its crossarm, door panels or a Bible under the mail. It must be findable but not stamped, and it must never fight the far image.
7. **Finish.** One restrained ground: paper grain, canvas weave, varnish or a vignette. A signature only if the user wants one.

**Faces and eyes** (when a face or an eye carries the claim):
- **The sclera is never white.** It is warm mid-gray to ivory. The upper lid casts a shadow band across its top third, and it darkens toward both corners.
- **The iris:** a dark limbal ring at the edge, radial fibers, a lighter collarette, crypts. Light passing through the cornea makes the iris brighter on the side opposite the light (a caustic crescent). The lid's shadow darkens the top of the iris.
- **Wet surfaces:** the catchlight takes the real light's shape (a window, a lamp) and is the brightest point in the picture. The lower lid has a visible margin with a wet highlight line. The inner corner is a rounded pink caruncle; the outer corner is a point.
- **The lids and brow carry the expression:**
  - a relaxed upper lid covering the top of the iris, plus a slightly raised lower lid, reads as kind;
  - sclera showing above the iris reads as alarm or a stare;
  - a raised inner brow reads as sorrow;
  - a dilated pupil reads as warmth.

  Decide the emotion first, then set these four.
- **Hair** (brows, lashes, beard) is hundreds of individually drawn tapered strands. It is thicker and more upright at the inner brow and sweeps outward. Fade its opacity toward the edges of the mass so it doesn't sit on the skin like a strip.

**Layer stack** (for painted pieces with fine detail):
1. **Underpainting:** the full scene, plus faint versions (about 60% opacity) of the hair, lashes and blood, so the strokes pick up their tone.
2. **Strokes:** start from a heavily blurred copy of the underpainting (σ ≈ 45 px), or the first, coarsest pass lays no strokes. Raise the error threshold on the finest pass, or it resamples everything into a filter.
3. **The crisp focal region:** the iris, the reflection, screens, text. Feather its mask inside the object.
4. **Overlays,** back to front: fluids, then hard props such as thorn tips, then hair, then lashes.
5. **Title or text,** then the ground and grain.

Save each overlay as RGBA so that every pass can be re-run alone.

**Text on curves, and non-Latin scripts:**
- Shape the text with RAQM (`ImageFont.Layout.RAQM`, `direction='rtl'` for Syriac, Hebrew and Arabic), and render a test strip and view it before you use it.
- Fit a whole number of repeats to the circumference, then scale the strip to fit. Never stretch one copy around the ring.
- Letters stand upright with their tops pointing outward. Read the result at 100% to make sure it is text, not scribble.
- Check glyph coverage (pitfall 20).
- **Prove text infrastructure first:** before any image, fetch every font needed (`@fontsource` on npm), merge subsets with fontTools if needed, and render one test sheet of every script in shaped form.
- Start each ring at a random angle and keep one reading direction (pitfall 34). Text that follows faces, folds, hair and fingers uses evenly spaced streamlines and tone-preserving ink (`references/code-rendering.md`).

**Large renders:**
- Before the full-size render, measure peak memory at preview size (`resource.getrusage(...).ru_maxrss`) and scale by pixel count, against `free -m`. A 4800×6000 scene build ran out of memory (exit 137) twice on an 8 GB machine.
- If memory is short, build the underpainting at half size and upscale it, but draw every mark (strokes, glyphs, dots) at full size, and composite small focal details crisp from a full-size layer.
- Iterate at about a third of the final size (seconds rather than minutes), with brush and cell sizes scaled in proportion. Some failures only show at 100%, so always view full-size crops of the focal point before delivery.
- Run long renders in the background with a log and a monitor that matches both success and failure lines. Never `pkill -f` with a pattern your own command line contains, because it kills its own shell.
- **Keep the geometry in final-pixel units with one scale factor `S`.** Then a reframe is free: render at `S = 1.3` and crop a 1620×2025 window to zoom 30% with nothing rewritten. Every pixel-unit parameter (noise sigmas, blurs, stroke widths, font sizes) has to be multiplied by `S`, or zoomed renders change character.

**Color** (in every visual medium):
- **Value carries the image; color carries the mood.** Check a grayscale version: if it doesn't read in gray, color won't save it.
- **Temperature contrast follows the light sources.** Warm light means cool shadows, and the reverse, consistently.
- **A dominant hue, a supporting hue and an accent.** Analogous, complementary, split and triad schemes are tools, not rules.
- **Color is relative (Albers).** Judge every swatch in context, never alone. Simultaneous contrast changes neighboring colors.
- **Spend saturation like money.** Keep most of the piece muted, and put saturation where the eye should go.
- **Symbolic color comes from the research.** For example:
  - liturgical colors: white and gold for feasts, violet for penance, red for martyrs and Pentecost, green for Ordinary Time;
  - icon blues and reds;
  - a brand's or object's real colors.
- **Across a film or series, write a color script:** one swatch strip per shot or scene, showing the arc.
- **Accessibility.** Never carry meaning by red versus green alone, and keep text contrast readable.
- **Print.** Proof in CMYK, use rich black for large areas, and avoid neon RGB colors that print as mud.

## The image check (step 6)

**Images, prints, vector, text art.** Run this on the final raster, or on a raster render of an SVG, TXT or HTML piece:

```python
# usage: python3 inspect_art.py art.png [name=u,v ...]   -> facts, thumb, grayscale, 100% crops (add named focal points as fractions)
import sys, os
from PIL import Image, ImageStat
Image.MAX_IMAGE_PIXELS = None
im = Image.open(sys.argv[1]).convert("RGB"); w, h = im.size
os.makedirs("inspect", exist_ok=True)
print(f"{w}x{h}px  print at 300dpi: {w/300:.1f}x{h/300:.1f} in  file {os.path.getsize(sys.argv[1])/1e6:.1f} MB")
st = ImageStat.Stat(im.convert("L"))
print(f"value mean {st.mean[0]:.0f}/255, spread (stdev) {st.stddev[0]:.0f}  (<35 usually reads flat)")
t = im.copy(); t.thumbnail((256, 256)); t.save("inspect/thumb_256.png"); t.convert("L").save("inspect/thumb_gray.png")
c = min(w, h) // 5
spots = {"center": (w//2, h//2), "upper_left": (w//4, h//4), "lower_right": (3*w//4, 3*h//4)}
for a in sys.argv[2:]:
    k, uv = a.split("="); u, v = map(float, uv.split(",")); spots[k] = (int(u*w), int(v*h))
for name, (x, y) in spots.items():
    x, y = min(max(x, c//2), w - c//2), min(max(y, c//2), h - c//2)
    im.crop((x - c//2, y - c//2, x + c//2, y + c//2)).save(f"inspect/crop_{name}.png")
f = im.copy(); f.thumbnail((420, 525)); f.save("inspect/feed_420.png")   # about what a phone feed shows
print(f"wrote inspect/thumb_256.png, thumb_gray.png, feed_420.png and {len(spots)} 100% crops: view them all, focal points first")
```

Always name the focal point and the element the claim hinges on as extra crops (for example `brand=.32,.78`).

Pass when:
- the thumbnail reads as one clear image;
- at feed size (`inspect/feed_420.png`), the element the claim hinges on still reads, at about 40 px tall or more (pitfall 18);
- nothing in the frame is dead space, and no speck is an unexplained highlight (pitfalls 25 and 26);
- every glyph renders, with no boxes (pitfall 20);
- the focal point is the brightest area with room around it, and the element the claim hinges on reads at 100%;
- the grayscale version still reads;
- every crop holds real marks, not mush;
- the file size fits the destination.
