---
name: hildegard-design
description: Use for a poster, flyer, social post, album or book cover, invitation, menu, sign, banner or logo - built in HTML and SVG at its exact size, rendered, and read back line by line.
---

# Design

A poster or post that a person would print, pin or share. It is built as one HTML file at its exact size (inline CSS
and SVG, fonts from Google Fonts), rendered to an image, and checked line by line before you hand it over. This skill
is all you need for it.

## Fast path

1. **Copy deck first.** Before any layout, write out every piece of text that will appear, copied from the brief:
   names, date, times, address, prices, lines the person wrote. Nothing else goes on the design. No tagline, slogan,
   "3 days only", "thank you for 70 years", year range, hashtag, web address or count that the person didn't give.
   Fix spelling, keep their words. If the brief gives too much text to fit, keep what a passer-by needs (what, when,
   where, the one reason to come) and put the rest in your reply as a suggestion.
2. **Find the idea.** Safe and tidy loses to a design with a point of view. Take the brief's tone words and its
   subject, and choose one treatment that makes it unmistakably this thing, then carry it through type, color,
   texture and the picture: a farmers' market board can feel hand-lettered in chalk; a jazz night can borrow a 1950s
   record sleeve; a library book sale can look like a card catalog. Texture is allowed and often right: paper grain
   or worn ink with an SVG noise filter, a printed border, a stamp. If the reason to come is a number (a price, a
   count, a date), make the numbers the feature: big, in a row, each with a short label. Write the idea in one line
   before you lay anything out.
3. **Rank it.** One headline, the thing someone must read from across the room. Two or three supporting lines. Then
   the details, small. Write the ranking next to the copy deck.
4. **Set the canvas.** The exact size asked for (a phone post 1080 x 1350, a square 1080 x 1080, a letter-size flyer
   1275 x 1650 at 150 dpi). Keep every word inside a safe margin of at least 6% of the short side.
5. **Pick two typefaces** and nothing more: one for the headline, one for everything else. Choose for the subject, and
   check the family is on Google Fonts:
   | Feel | Headline | Text |
   |---|---|---|
   | Church, community, heritage | Libre Caslon Display or Cormorant | Libre Franklin or Source Sans 3 |
   | Hardware, sale, sports, loud | Anton or Oswald | Archivo or Roboto Condensed |
   | Folk, farm, bluegrass, rustic | Alfa Slab One or Rye | Bitter or Cabin |
   | Wedding, formal, gala | Cormorant Garamond (600 or bolder) | Montserrat |
   | Kids, playful | Fredoka | Nunito |
   | Modern, tech, clean | DM Serif Display or Syne | Manrope or IBM Plex Sans |
6. **Pick three or four colors** from the subject's own world (harvest gold and barn red, hymnal navy and candle
   cream), plus one dark and one light for text. Text must stand out: dark on light or light on dark, never mid on mid.
7. **Size for a phone.** Most people see it as a thumbnail. Set the headline in a bold or heavier weight (never a
   thin or light display face), spanning at least 60% of the canvas width, at least three times the body text. The
   when and where (date, time, place) come second in size, never small. Body text at least 2.5% of the canvas
   height. Give the headline `text-wrap: balance`.
8. **Lay it out on a grid.** Use CSS grid or flex with `gap`, never absolute positions for text. Space separates the
   groups (headline, the when and where, the details); it never sits as an empty band. If a third of the canvas is
   empty, make the headline or the picture bigger.
9. **One picture, big, or none.** A picture earns its place at a real size: at least a third of the canvas, part of
   the layout, never a small icon floating in a frame. A simple SVG scene or shape that belongs to the subject (a lantern on a porch rail, a sheaf of wheat, a sun over a field) beats a busy illustration; no stick figures or faces
   drawn in code. Never put text over a busy picture.
10. **Render and read it back** (next section). Fix, render again, until every check passes.
11. **Deliver** the HTML file, the rendered PNG, and the copy deck. Say which typefaces and colors you used, and list
   anything from the brief you left off and why.

## Render and read it back

Render at the exact size:

```sh
chromium --headless=new --hide-scrollbars --window-size=1080,1350 --screenshot=design.png design.html
# or google-chrome / chrome / msedge with the same flags; or Playwright's page.screenshot()
npx playwright screenshot --viewport-size=1080,1350 "file://$PWD/design.html" design.png   # if no browser is installed
```

No browser and no Node (a chatbot)? Use the code tool's Chromium or Playwright if it has one. If nothing can render,
hand over the HTML, say plainly that it is unrendered and unchecked, and ask your user to open it and tell you what
they see.

Open `design.png` and look at it at full size. Then check each line, one at a time, against the copy deck:

- **Every line is whole.** No word cut off at an edge or behind another element (a line that ends "REGULAR-PR" is
  cut). No word broken across two lines unless it has a hyphen in the copy deck.
- **No stray characters.** No `&amp;`, `&`, `·`, quotes or bullets that aren't in the copy deck. An ampersand in a
  headline ("Fall & Festival") that the brief doesn't have is a bug.
- **Every copy-deck line appears once,** spelled the same, and nothing appears that isn't in the copy deck.
- **Inside the margin.** Nothing touches or crosses the safe margin.
- **The squint test.** Shrink the PNG to a quarter of its size: the headline, the date and the place must still read.
- **Contrast.** Small text at least 4.5 to 1 against what's behind it; large text at least 3 to 1.

If any check fails, fix the HTML (wider box, smaller size, shorter line, remove the extra) and render again. Never hand
over a design you haven't rendered and read.

## Craft that makes it good

- **One idea.** The design says one thing at a glance: what's happening, and why someone should care.
- **Alignment.** Pick one alignment (left is easiest to do well) and keep to it. Centered everything looks generic.
- **Scale contrast.** A big, confident headline and small, calm details. Medium-size everything is the mark of a
  template.
- **Specific over generic.** A real detail from the subject (the shop's founding year if the brief gives it, the
  barn's name, the street) beats a stock flourish. Leaves, sunbursts and swooshes are the clip art of 2026.
- **Numbers that matter, big.** A sale's "20%" or an event's date can be the headline if it is the reason to come.
- **Print and screen.** For print, keep 0.125 in bleed past the trim if asked and no text near it; for screen, check
  the design still reads at phone size.

## With Hildegard

With Hildegard linked, its image models can make a picture for the design (the **hildegard-art** skill): ask for the
picture alone, with room left for text, and place the text in HTML. Without Hildegard, use the image tool you have, or
your user's own picture, or an SVG shape (step 7). Either way, never ask an image model to write the words; it
misspells them.
