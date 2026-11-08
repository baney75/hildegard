# Logo craft

Read this before you draw. The steps in SKILL.md say when; this file says how.

## What a logo has to survive

A logo is used more often at 32 px than at 512. It is stitched on a polo, cut from vinyl for a truck door, stamped
in one ink on a kraft bag, engraved on a tag, shown as a favicon in a browser tab. Design for the worst of those
first. The checker measures each one; this list is why:

| Place | What it does to the logo | Rule that survives it |
| --- | --- | --- |
| Favicon, 16 and 32 px | every stroke under 1 px turns to gray mush | strokes and gaps at least 1/16 of the mark's width |
| Embroidery, 1 inch | thread can't hold a line under about 1 mm, or a gap under 1 mm | the same 1/16 rule: 1.6 mm at 1 inch |
| Vinyl, screen print, stamp | one ink, no tints, no gradient, no shadow | flat shapes, one color reads |
| Reversed, on a photo | a background box shows as a block; thin parts vanish | transparent, and the same shape in white |
| Small print, engraving | fine serifs and hairlines fill in | the wordmark has a minimum size, stated on the sheet |

## Kinds of mark, and when each is right

| Kind | Right when | How to build it here |
| --- | --- | --- |
| Monogram | the name is long, or the initials are distinctive | one or two letters drawn from rectangles and arcs on the grid, one stroke weight |
| Pictorial | the business has one object everyone knows it by | that object in 3 to 6 flat shapes, in silhouette, seen from its most telling side |
| Fusion | a letter and an object share a shape | cut the object out of the letter (negative space) or let one stroke be both |
| Emblem | the client is an institution (a school, a parish, a club) | a simple container (circle, shield, arch) with one symbol inside; the name goes outside it at small sizes |
| Wordmark only | the name is short (under 10 letters) and the face can carry it | a wordmark with one drawn detail (a ligature, a cut, a mark in a counter) |

A weak model does best with a monogram or a pictorial mark built from a few primitives. Avoid detailed illustration:
it fails every small-size check.

## Meaning, not a cliche

Before drawing, list twelve nouns from the client's own world: the tools they hold, the materials, the place (a river,
a street, a building), the founding story, the shape of the product, their letters. Then write three concepts, each as
one line: "Mark: a B built from the wooden blocks a printer locks type in, because the shop is a letterpress."

Reject a concept when a competitor could use it unchanged. These are the category cliches; never use one as the mark:

- a swoosh or orbit; a globe; a lightbulb; a generic leaf or sprout; a gear or cog (unless they make gears);
- a house roof over the name (real estate, home services); a map pin; a check mark; a shield with a check;
- abstract people holding hands or arms up; a heart in hands; a speech bubble; a brain; a puzzle piece;
- three mountain peaks (anything outdoors); a coffee bean or cup steam (any cafe); a tooth (any dentist);
- infinity loops, DNA helices, hexagons for "tech", sparkles for "AI".

## Constructing the mark

- `viewBox="0 0 512 512"`. Think in a 16 by 16 grid of 32-unit cells. Put every edge, center and radius on the grid or
  on a half cell.
- Strokes at least 64 units (2 cells), gaps and counters at least 32 (1 cell). That is the 1/16 rule above.
- At most six shapes. Use `fill-rule="evenodd"` on a path to cut counters, rather than a white shape on top: a white
  shape shows when the logo sits on a photo.
- One corner language: all square, or all one radius.
- One color in the mark. A second color is allowed in the lockup (the wordmark in the ink color).
- Optical corrections, which make geometry look right:
  - round and pointed parts overshoot flat ones by 2 to 3% (a circle as tall as a square looks smaller);
  - horizontal strokes about 8% thinner than vertical ones look equal;
  - the optical center is a little above the geometric center: lift a centered shape by about 2%.
- Leave a comment at the top of the SVG with the grid and the idea, so the next person can extend it.

## The wordmark

Set the name with `wordmark.py` in a Google Fonts face (all are free for logos), never with live `<text>`.

| The client feels | Faces to try (Google Fonts) |
| --- | --- |
| established, craft, heritage | Libre Caslon Text, Cormorant Garamond (600+), Spectral, Libre Baskerville |
| warm, local, food, farm | Fraunces, Young Serif, Bitter, Alegreya |
| sturdy, trade, hardware, outdoors | Archivo, Barlow Semi Condensed, Oswald, Roboto Slab |
| professional, finance, law, health | Source Serif 4, IBM Plex Sans, Public Sans, Instrument Sans |
| friendly, kids, community | Nunito, Fredoka, Baloo 2, Quicksand (600+) |
| modern, technical, precise | Space Grotesk, Manrope, DM Sans, Sora |

Weight: 600 or bolder for anything that must read small. Light weights fail at 32 px.

Spacing by hand:

1. Run `wordmark.py ... --report`. It lists every pair whose gap is more than 20% off the font's own HH or nn
   spacing, with a first guess at the kern.
2. Open `<out>-flipped.png`. Upside down you see shapes, not words. Find the widest and the narrowest gap.
3. Kern only the pairs you can see are wrong, with `--kern "LA:-40,To:-30"`, and render again. Round letters (O, C, S)
   need less space than straight ones; diagonal pairs (AV, LT, Ty) need more kerning than the font gives in caps.
4. All caps: add tracking of 40 to 80 (`--tracking 60`). Lowercase: no tracking.

## Lockups

`lockup.py` places the mark and the wordmark by ratio:

- horizontal: mark 1.5 times the cap height, its middle on the middle of the capitals, gap 0.4 of the mark's height;
- stacked: mark 2.5 times the cap height, centered above, gap 0.35 of the mark's height;
- the mark alone: the favicon, the app icon, the social avatar, the embroidered polo.

Clear space is a quarter of the lockup's height on every side unless the client's mark suggests a better unit. The
minimum size is what the checker measures, rounded up.

## Favicon and app icon

The mark at 16 px is about the size of a letter on a page. If the checker's `favicon-16` warns, draw a simpler
favicon: drop the smallest part, thicken the strokes to 1/10 of the width, keep the silhouette. For an app icon, put
the mark on a full square of the accent color with the mark in the paper color, filling about 60% of the square.

## The logo sheet

`logo_check.py` makes it: every lockup with its clear space, the mark at 512, 64, 32 and 16 px and magnified, one
color and reversed, the colors, the minimum sizes, and every measured check. It is the render reviewers judge and
the page the client hands to a sign shop.
