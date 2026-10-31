---
name: hildegard-web
description: Use for any web page, site, landing page, portfolio, product page or UI mockup - real HTML and CSS that Hildegard renders at phone, tablet and desktop, light and dark, and audits until it passes.
---

# Designing for the web, in rounds

A generated web page is slop when it's the template: a centred hero with a gradient, three icon cards, a testimonial
strip, "Unlock the power of…", and a phone layout nobody looked at. A good page is made the way a designer makes one:
the words first, a system of type, space and colour, the phone and the desktop both designed, and every page looked at
before it ships. Hildegard does the looking with you. Your design is the code itself, so nothing drifts between the
design and what ships.

Read **hildegard-craft** first (the brief and the gates), and **hildegard-loop** for the rounds.

## 0. Start from something good

Work in a **site** (`site_new`), so your user sees it live on the Studio's canvas at three widths while you write,
and can retune its words and tokens themselves. Start it from:

- **A template** when one fits (`site_templates` lists them; each is in `templates/` beside this skill): Hearth
  (bakery, café, shop), Atelier (architecture or design studio), Ledger (software product with pricing), Practice
  (clinic, appointment-led service), Gathering (conference, festival), Parish (parish, congregation), Manual
  (documentation), Journal (long-form essay, newsletter). Each already passes every check. Replace every word with
  the real ones first; its `template.json` gives each picture's aspect and a prompt to render it on your user's GPUs.
  Keep the system (the tokens) unless the brand says otherwise, and keep what makes it pass.
- **Their Figma** (`from: "figma"`, a file or frame link) or **pen.dev file** (`from: "pen"`): the import writes
  semantic HTML and CSS with the styles as tokens and keeps a render of each frame. Read the site's notes: they say
  what the import couldn't carry over. Then improve the markup (real headings, real buttons, real copy) without
  changing the look.
- **Their current site** (`from: "url"`): a redesign starts from what's there, with a screenshot of it kept.

Read files with `site_files` and `site_read`; write with `site_write`. Start the loop with `site_id` (and no
`file_path`): each round checks the site as it stands, and an imported site is held to its design image too, so
"matches the Figma" is measured, not claimed. `site_tokens` lists and sets the system; `site_export` hands over a ZIP.

## 1. Brief and words before layout

Ask, then write it down:

- **For:** who visits, from where (a search, a QR code on a box, a link from a friend), on what (a phone, mostly).
- **The sentence:** what they should do or know after this page. One sentence. The first screen serves it.
- **The real material:** the product's own names, prices, numbers, places, photos, quotes from real people with
  their permission. Ask for it. Never invent a testimonial, a customer logo, a statistic or a price.
- **Constraints:** the brand (colours, type, logo, voice), the stack it ships in (plain HTML, a static site
  generator, React, Astro, a CMS), languages, and what must work without JavaScript.

Write the copy before the layout, in the reader's words. Every section answers a question the reader has, in the
order they have it. A section you can't say the purpose of goes.

## 2. A system, not a page

Before any section, set the system as CSS custom properties, light and dark (`references/tokens.css` is a skeleton to
fill from the brand; Hildegard's own design system is the worked example):

- **Type:** one family for text and at most one for display. A scale (16, 20, 25, 31, 39, 49 at 1.25), body 16 px or
  more, line-height about 1.5, paragraphs at most about 65 characters wide. Load fonts from your own site, not a
  third party, and subset them.
- **Space:** one scale (4, 8, 12, 16, 24, 32, 48, 64, 96) and a grid. Every margin and gap is a step of it.
- **Colour:** by role, not by name: ground, panel, ink, muted ink, hairline, one accent, and states (focus, error,
  success). Text passes WCAG AA (4.5:1, 3:1 for large text). Dark is designed, not inverted: lift the ground a little
  off black, lower the accent's brightness, keep contrast.
- **Motion:** short (150 to 250 ms), purposeful, and off under `prefers-reduced-motion`.

## 3. Build it

Plain, semantic HTML and CSS first: `header`, `nav`, `main`, `section` with a heading each, `footer`; one `h1`;
headings in order; a `<label>` for every field; `alt` for every image (empty `alt=""` for decoration); buttons that
are `<button>` and links that are `<a href>`. Mobile first: the base CSS is the phone, `min-width` media queries add
the wider layouts. Use `clamp()` for fluid type, grid and flex for layout, `aspect-ratio` and `object-fit` for
images, `:focus-visible` for a visible focus ring. JavaScript only for what needs it.

**Images are yours.** Make them with Hildegard on your user's own GPUs (**hildegard-art**: art direction, a series,
then the best one), at the exact aspect the layout needs (a 16:9 hero, a 4:5 portrait card), so there's no stock
photo and no per-image bill. Export each at two or three widths as WebP or AVIF with a JPEG fallback, with `srcset`,
`sizes`, `width` and `height` (no layout shift), and `loading="lazy"` below the fold. Real product photos beat any
generated image: ask for them first. Never generate a person and pass them off as a customer or a team member.

**Bring everything in.** Hildegard opens the page with the network cut off, the way a careful reviewer would, so
fonts, images, scripts and styles all come from the site's own folder. A request to anywhere else is named in the
`offline` check.

## 4. The loop

```json
loop_start {
  "kind": "web", "title": "Rye & Salt bakery",
  "for": "neighbours who find the bakery on their phone, to see today's bread and order for pickup",
  "what": "a one-page site: today's bakes with prices, how to order, hours and the map",
  "specifics": ["the 6 a.m. bake photographed on the actual counter", "prices in the first screen", "order in two taps"],
  "pages": ["index.html"], "dark": true
}
```

Send the site with `loop_submit`: `file_path` to the folder (Hildegard packs it) or its `index.html`, a ZIP, or the
HTML as `text` for a single page. Each round comes back as one sheet: every page's first screen at phone (390 px),
tablet (820 px) and desktop (1440 px), then each whole page, in light and in dark, with every problem outlined in
magenta. And the checks:

| Check | What fails it |
| --- | --- |
| `loads`, `errors` | the page didn't settle, or a script threw |
| `overflow` | something wider than the screen: sideways scrolling on a phone |
| `contrast` | text below WCAG AA against what's behind it |
| `alt`, `images` | an image with no `alt`; a broken image |
| `names`, `labels` | a button or link with no name; a field with no label |
| `targets` | tap targets under 44 × 44 px on a phone (warn) |
| `text-size`, `measure` | body text under 16 px; lines over about 80 characters (warn) |
| `fonts`, `headings` | more than three families; skipped heading levels or no `h1` (warn) |
| `head` | no viewport meta or no title (fail); no description or language (warn) |
| `placeholder`, `stock-copy`, `emoji-icons` | lorem ipsum and stand-ins; "unlock the power of"-style copy; emoji used as icons |
| `offline`, `weight`, `image-size` | requests off the site; a heavy page; images far bigger than they're shown |
| `dark`, `motion`, `focus` | dark asked for and not designed; animation that ignores reduced motion; focus outlines removed with nothing in their place |

Then critique with the web questions (intent, hierarchy, content, type, space, colour, specific, responsive, images,
states, themes), each with the screen and the width that shows it. Failing checks first, then the worst "no", one
change a round. Five rounds is the default.

**Variants.** To compare directions (a quiet, typographic page against an image-led one), start one loop per
direction with the same brief and a different `what`, take each two or three rounds, and put the two sheets in front
of your user. Choose by the sentence, not by which is prettier.

## 5. Ship it

`loop_finish` on the best round. Hand over the folder as it passed, the tokens, and a note: what was checked (every
page, three widths, two themes, audited offline) and what wasn't (real devices, a screen reader, the content your user
still owes you). Then, if the site lives in a framework, port it **after** it passes, keeping the tokens as CSS
variables and the markup's structure, and send the built output through the loop once more: a port that changes the
render is a regression.

## Never

- Invented testimonials, logos of customers who aren't, statistics, awards or prices.
- A dark pattern: a pre-ticked box, a hidden cost, a cancel that's harder than the sign-up, a fake countdown.
- Someone else's brand, or a page that passes itself off as a real company your user isn't.
- A login or payment form that sends anywhere but your user's own, real service.
