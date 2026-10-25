# Making things: parts to print, and websites

Hildegard makes products, not only pictures. Two kinds of work go through the same loop as a 3D model or a film
(generate, render, critique, refine), each with its own checks, so an AI app that's linked to Hildegard can make
something that works and prove it before anyone builds or ships it.

## Parts to print

Ask any linked app for a part ("a replacement clip for my bookshelf, here's a photo of the broken one beside a bank
card"). The **hildegard-print** skill leads it through:

1. **Your printer.** `printer_profile` keeps its build volume, nozzle, layer height, filament and its price, and the
   clearance per side for each fit (press, snug, slide, free). The skill's fit coupon calibrates those once: a strip
   of holes from 0.00 to 0.40 mm and a pin you print and try. A slicer on the computer Hildegard runs on is found by
   itself: PrusaSlicer works with no setup; OrcaSlicer and Bambu Studio need your printer's exported profiles.
2. **Evidence.** `print_kit.py` measures a photo against a reference in it (a bank card, a coin, an A4 sheet, a
   dimension you give), straightens a photo taken at an angle, reads points off zoomed grids instead of guessing, and
   quotes a shop listing's dimensions. Every number keeps its source and its tolerance, and what no photo shows is
   written down as an unknown.
3. **Rounds.** The part is modelled assembled, each piece named, every mating feature sized from your printer's
   clearance. Each round Hildegard checks the mesh (watertight, size, bed, base, overhangs), measures the gap between
   every two parts against the fit declared for them, lays the model's silhouette over the photo's outline (and says
   when the part is turned the wrong way or the right shape at the wrong size), and slices it: time, grams, layers,
   and what the filament costs against what the part costs to buy.
4. **The print sheet.** One page to print or send to whoever prints it: the brief, the part from every side, what it
   takes and what it saves, how the parts fit, every dimension and where it came from, the unknowns to check first,
   and whatever still fails. With it, an STL per part standing on the bed, and the G-code.

Hildegard never talks to the printer. Nothing is printed until you print it. No weapons, and nothing a life or a limb
depends on.

The parts, fits, likeness, coupon and print sheet follow [print3d](https://github.com/mfranzon/print3d) by mfranzon
(MIT), adapted to Hildegard's loop and to any slicer and printer; its license is in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Websites

Ask for a site ("a one-page site for my bakery: today's bread, prices, order for pickup"). The **hildegard-web**
skill has the app write the words first, set a system (type scale, spacing scale, colour by role, light and dark) as
CSS variables, and build plain, semantic HTML and CSS, phone first. Images come from your own GPUs at the exact aspect
the layout needs, not from a stock library.

Each round, Hildegard opens every page in a browser cut off from the network, at phone (390 px), tablet (820 px) and
desktop (1440 px), in light and dark, and returns one sheet with every problem outlined in magenta and checks for
what a careful reviewer looks for: text contrast (WCAG AA), sideways scrolling on a phone, images without alt text,
buttons and fields without names or labels, tap targets too small for a thumb, body text under 16 px, lines too long
to read, too many fonts, skipped headings, a missing viewport or title, lorem ipsum and stand-in copy, stock marketing
phrases, emoji used as icons, requests to other sites, a heavy page or oversized images, a dark theme asked for and
not designed, animation that ignores reduced motion, and focus outlines removed with nothing in their place. The app
answers the web questions (who it's for, hierarchy, real content, type, space, colour, the one idea only this product
has, the phone layout, images, states, themes) from the sheet, one change a round.

Send a single page as text, or a site as a folder or a ZIP (up to five pages are checked per round). When it passes,
port it to your framework and send the built site once more, so the port can't change what you approved.

### Against pen.dev

[pen.dev](https://pen.dev) is a good agentic design canvas: designs in an open JSON format (`.pen`) that
agents edit over MCP, with Figma import and export to HTML and React. As of October 2026 it's closed source, the free
tier has a monthly allowance of agent days and image generations, the paid plans are monthly subscriptions, and the
design and the code it exports are two things that can drift apart.

Hildegard takes the other road:

| | Hildegard | pen.dev |
| --- | --- | --- |
| What you design in | the real HTML and CSS that ships | a canvas file, exported to code |
| How it's checked | every page rendered at three widths, light and dark, and audited (accessibility, layout, copy, weight, offline) each round | by eye on the canvas |
| Images | made on your own GPUs, as many as you like | a monthly allowance |
| Where it runs | your own computers; any AI app or model, local ones included | its desktop app and services |
| Cost | free | free tier, then monthly plans |
| Source | AGPL-3.0, yours to read and change | closed |

What pen.dev has that Hildegard doesn't yet: a visual canvas you can drag things around on, and Figma import. If you
work visually, use both: design there, export, and send the export through Hildegard's loop before it ships.
