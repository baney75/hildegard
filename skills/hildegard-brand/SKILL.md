---
name: hildegard-brand
description: Use for a logo, wordmark, monogram, favicon or app icon, or a brand system (palette, type, voice, a one-page brand guide), built as SVG and JSON and checked at 16 px and in one ink.
---

# Logos and brands

A logo is a small drawing that has to survive a favicon, a polo shirt, a truck door and a rubber stamp. A brand is the
logo plus the rules that make everything else look like the same client. Both are built here in code (SVG and JSON),
measured by scripts, and judged blind before anyone sees them. This skill is all you need; the scripts use Python's
standard library, Pillow, and a rasterizer (rsvg-convert, cairosvg or Chromium) when one is there.

| File | What it does |
| --- | --- |
| `scripts/wordmark.py` | sets the name in a Google Fonts face as SVG paths, with the font's kerning and yours, and measures the spacing |
| `scripts/lockup.py` | puts the mark and the wordmark together (horizontal, stacked) by ratio |
| `scripts/logo_check.py` | renders at 16, 32, 64 and 512 px, measures hairlines, embroidery, one-color loss, colors and live text; makes the logo sheet |
| `scripts/brand_guide.py` | checks `brand.json`, works out every contrast pair, and lays out the one-page guide (HTML, PNG, PDF) |
| `scripts/council.py`, `references/rubrics.md` | the design council: six blind critics (the **hildegard-council** skill) |
| `references/logo.md` | how to find the idea, build the mark on a grid, choose and kern the face, lock it up |
| `references/brand-system.md` | color by role, type pairing and scale, voice in three lines, imagery rules |
| `templates/example/` | a finished logo set and `brand.json` (Brickyard Press, a letterpress shop) to copy the shape of |

Run every script from this skill's folder, or give its full path. Each prints what failed and how to fix it.

## A logo

1. **Brief card.** Write `brief.md`: the name exactly as the client spells it; what they do, for whom, where; every
   place the logo will live (sign, favicon, truck, shirt, cup, app icon); competitors or neighbors named in the brief;
   anything they ruled out. A tagline appears only if the client gave one. Done when every line comes from the brief.
2. **Find the idea.** Read `references/logo.md`. List twelve nouns from the client's own world, then write three
   concepts as one line each: "Mark: <shape>, because <true thing about this client>." Strike any concept a competitor
   could use unchanged and anything on the cliche list (swoosh, globe, lightbulb, generic leaf, gear, roof, map pin).
   Choose the kind of mark from the table in `logo.md`. Done when one concept is left and you can say why it is theirs.
3. **Draw it on the grid.** `mark.svg`, `viewBox="0 0 512 512"`, a 32-unit grid, flat fills in one color, at most six
   shapes, strokes at least 64 units and gaps at least 32, counters cut with `fill-rule="evenodd"`, transparent
   background. Copy the shape of `templates/example/mark.svg`. Done when it opens and has no `<text>`.
4. **Set the wordmark.** Pick a face from the table in `logo.md`, weight 600 or more, then:

   ```sh
   python3 scripts/wordmark.py "Client Name" --family "Fraunces" --weight 600 --color "#2b211c" --out wordmark.svg --report
   ```

   Open `wordmark-flipped.png`, find the widest and tightest gaps, and kern only the pairs you can see are wrong
   (`--kern "LA:-40"`). Caps get `--tracking 60`. Done when the gaps look even upside down.
5. **Lock up.**

   ```sh
   python3 scripts/lockup.py mark.svg wordmark.svg --layout horizontal --out logo-horizontal.svg
   python3 scripts/lockup.py mark.svg wordmark.svg --layout stacked --out logo-stacked.svg
   ```

6. **Check and make the sheet.**

   ```sh
   python3 scripts/logo_check.py mark.svg logo-horizontal.svg logo-stacked.svg --name "Client Name" --dark "#2b211c" --out logo-check
   ```

   Fix every FAIL and run it again: thicken what the magenta shows, outline live text, remove gradients, cut colors to
   three. A `favicon-16` warning means drawing a simpler favicon (`logo.md`). Then open `logo-check/sheet.png` at full
   size and look at the 16 and 32 px views: is it the same shape as at 512? Done when no check fails and you have looked.
<!-- council:start -->
7. **Council.** Run the **hildegard-council** protocol on `logo-check/sheet.png` with `--medium logo` (its six roles,
   each blind; `scripts/council.py` and `references/rubrics.md` are here too, so it works without that skill). Fix
   every hard fail and every area two critics flag, re-run step 6, and hold a second round only if the tally says so.
   Done when the tally's must-fix list is empty or each item is answered.
<!-- council:end -->
8. **Deliver**: `mark.svg`, `logo-horizontal.svg`, `logo-stacked.svg`, the one-color and reversed files from
   `logo-check/`, the PNGs at 16, 32, 64 and 512 px for the favicon and app icon, and `sheet.png`. Say the idea in one
   sentence, the face and its license (Google Fonts, free for logos), the minimum sizes from the sheet<!-- council:start -->, and the council's
   scores and what you changed<!-- council:end -->.

## A brand system

1. **Logo first.** Use the client's logo, or make one with the steps above.
2. **Fill `brand.json`.** Copy `templates/example/brand.json` and replace every value; read
   `references/brand-system.md` as you go. Colors by role from the client's world (ground, surface, ink, muted,
   accent, on-accent; six at most), the logo face as the display face plus a text face, a six-step scale, three voice
   lines, one to three say/not examples using only facts from the brief, and imagery rules. Done when no value is the
   example's.
3. **Check and lay out.**

   ```sh
   python3 scripts/brand_guide.py brand.json --out guide
   ```

   Every FAIL names the fix (a failing color pair prints the nearest color that passes). Run it until it writes
   `guide/guide.png`, then look at the whole page: does every section look like the same client? Done when it passes
   and you have looked.
<!-- council:start -->
4. **Council** on `guide/guide.png` with `--medium brand`, as in logo step 7.
<!-- council:end -->
5. **Deliver** `brand.json`, `guide/guide.pdf`, `guide/guide.png`, `guide/guide.html` and the logo files.

## Rules that are never relaxed

- Every word on a logo or guide is from the brief. No invented tagline, year, award, slogan or claim.
- No gradient, shadow, glow or transparency needed to read the logo. No live `<text>` in a delivered logo.
- Fonts only from Google Fonts or a license the client names. Never a real company's logo or a lookalike of one.
- An image model never draws the logo or its letters; with **hildegard-art** (or any image tool) make imagery for the
  brand only. Without one, describe the imagery rules and leave the pictures to the client's photographer.
- Never say a logo passes a check you didn't run. If no rasterizer is available, say the pixel checks didn't run.
