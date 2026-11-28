---
name: hildegard-web
description: Use for any web page, site, landing page, portfolio, product page or UI mockup - real HTML and CSS that Hildegard renders at phone, tablet and desktop, light and dark, and audits until it passes.
---

# Designing for the web, in rounds

## In Local Studio

The person's request is at the top of this message and after `</skill>`.

First call the `site_templates` tool, pick the template that fits, and start a site with `site_new`. If you have no Hildegard tools, copy a template folder from `<folder>/templates/` into a new `site/` folder in the working folder and work there, never in `<folder>`.

`<folder>` is the folder on the "References are relative to" line above. Run its scripts as `python3 -B <folder>/scripts/<name>.py`, and a script of yours that imports from `<folder>/scripts` as `python3 -B yours.py`: `-B` keeps Python from writing into the plugin, which would turn Hildegard's tools off until the person allows them again.

Hildegard's tools (`hildegard_status`, `loop_start` and the rest) are here once the person allows the Hildegard plugin in Local Studio's Settings, Plugins. If you don't have them, use this skill's way without Hildegard.

A generated web page is slop when it's the template: a centred hero with a gradient, three icon cards, a testimonial
strip, "Unlock the power of…", and a phone layout nobody looked at. A good page is made the way a designer makes one:
the words first, a system of type, space and colour, the phone and the desktop both designed, and every page looked at
before it ships. Hildegard does the looking with you. Your design is the code itself, so nothing drifts between the
design and what ships.

This skill works alone. With Hildegard linked, the site lives in Hildegard (`site_new`, `site_write`, `loop_start`,
`loop_submit`) and it renders and audits every round. Without Hildegard, the site is a folder of plain files in
your user's project, you render it yourself with Playwright (section 4) and audit it against the check list there.
If you have them, **hildegard-craft** gives the brief and the gates, and **hildegard-loop** the rounds;
`references/slop.md` here is the slop catalogue.

## 0. Start from something good

With Hildegard linked, work in a **site** (`site_new`), so your user sees it live on the Studio's canvas at three widths
while you write, and can retune its words and tokens themselves. Without it, make a `site/` folder and work in files
(`index.html`, `styles.css`; copy a template's folder from `templates/` here, and the tokens from
`references/tokens.css`). Start it from:

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
Without Hildegard there is no import: ask for the Figma frames or the current site as screenshots and build the
markup from them, and hand over the folder (zip it if they want one file).

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
- **Motion:** short (150 to 250 ms), purposeful, `transform` and `opacity` only (never `transition: all` or animating `width`, `height`, `top`, `left`), and off under `prefers-reduced-motion: reduce`.
- **Anti-slop Floor (checked statically before screenshots):** every colour and `font-family` goes through `:root` custom properties; `overflow-x: clip` on `html` and `body` (never `100vw` or `overflow-x: hidden`); `:focus-visible` on every interactive element; no purple-to-blue gradients, emoji icons, single-italic-word headings, or filler copy. Run `python3 -B <folder>/scripts/check_design.py --html site/` (and `--design-md design.md` when a persistent `design.md` exists) until all checks pass.

## 3. Build it

Plain, semantic HTML and CSS first: `header`, `nav`, `main`, `section` with a heading each, `footer`; one `h1`;
headings in order; a `<label>` for every field; `alt` for every image (empty `alt=""` for decoration); buttons that
are `<button>` and links that are `<a href>`. Mobile first: the base CSS is the phone, `min-width` media queries add
the wider layouts. Use `clamp()` for fluid type, grid and flex for layout, `aspect-ratio` and `object-fit` for
images, `:focus-visible` for a visible focus ring. JavaScript only for what needs it.

**Images are yours.** With Hildegard linked, make them on your user's own GPUs (**hildegard-art**: art direction, a
series, then the best one); without it, use the photos your user gives you or the image tool you have. Either way, at
the exact aspect the layout needs (a 16:9 hero, a 4:5 portrait card), so there's no stock
photo and no per-image bill. Export each at two or three widths as WebP or AVIF with a JPEG fallback, with `srcset`,
`sizes`, `width` and `height` (no layout shift), and `loading="lazy"` below the fold. Real product photos beat any
generated image: ask for them first. Never generate a person and pass them off as a customer or a team member.

**Bring everything in.** Hildegard opens the page with the network cut off, the way a careful reviewer would, so
fonts, images, scripts and styles all come from the site's own folder. A request to anywhere else is named in the
`offline` check. Without Hildegard, run `grep -rnE "(src|href)=.https?:|url\(.?https?:" site/` and move into the
folder anything it finds that the page loads (a link the reader clicks is fine).

## 4. The loop

With Hildegard linked, start it:

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
magenta.

Without Hildegard, make the same screens yourself, then open each image and look at it (needs Node; the first run
may need `npx playwright install chromium`):

```sh
mkdir -p shots
for size in 390,844 820,1180 1440,900; do for scheme in light dark; do
  npx playwright screenshot --viewport-size="$size" --color-scheme="$scheme" --full-page \
    "file://$PWD/site/index.html" "shots/index-${size%,*}-$scheme.png"
done; done
```

Repeat for every page. Then go down the checks below one by one against the screens and the files, as an audit: each
row is a thing to look for, and `fail` rows come first. Write what you find and what you changed in `rounds.md`. The
checks:

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

`loop_finish` on the best round (without Hildegard, the best round is the folder as it last passed your audit). Hand
over the folder as it passed, the tokens, and a note: what was checked (every
page, three widths, two themes, audited offline) and what wasn't (real devices, a screen reader, the content your user
still owes you). Then, if the site lives in a framework, port it **after** it passes, keeping the tokens as CSS
variables and the markup's structure, and send the built output through the loop once more: a port that changes the
render is a regression.

## Never

- Invented testimonials, logos of customers who aren't, statistics, awards or prices.
- A dark pattern: a pre-ticked box, a hidden cost, a cancel that's harder than the sign-up, a fake countdown.
- Someone else's brand, or a page that passes itself off as a real company your user isn't.
- A login or payment form that sends anywhere but your user's own, real service.


## Tactile anime UI VFX controls (sakuga)

When asked for expressive anime-style ("sakuga") UI controls (buttons, toggles, sliders, checkboxes, radios, inputs, tabs, progress bars, ratings, toasts, tooltips), keep the real control semantic and plain at rest, and validate the contract with `python3 -B <folder>/scripts/check_design.py --sakuga control.json --pre-render` before rendering and `python3 -B <folder>/scripts/check_design.py --sakuga control.json` after frame-strip signoff:

- **Semantic control and rest state (`control`, `plain_at_rest`, `immediate_state_change`):** wrap a real native control (`button`, `toggle`, `switch`, `slider`, `checkbox`, `radio`, `input`, `tabs`, `progress`, `rating`, `toast`, `tooltip`). Keep it plain at rest with zero idle clutter (`"plain_at_rest": true`), and update state immediately (`"immediate_state_change": true`) so drawn effects only decorate and never obscure readable labels.
- **Four reaction beats (`beats`):** script the reaction in exact order `anticipation`, `hit`, `follow_through`, `settle`. Give each beat 1 to 2 effects (`settle` may have 0 to 2) and at most one `"sfx_word"` across the entire reaction, placed strictly on `"hit"`.
- **Single shared canvas and clock (`shared_clock_canvas`):** draw all effects on one shared overlay `<canvas>` driven by one shared clock queue (`later(ms, fn)`, never raw `setTimeout`) so stepped frame sheets are deterministic.
- **Visual rules (`visual_rules`):** two flat tones plus an ink outline with no gradients or blur (`"flat_two_tone_outline": true`), effects exit by shrinking or thinning rather than fading opacity (`"exit_by_shrink_not_fade": true`), hand-driven controls move on springs (`"spring_driven": true`), `prefers-reduced-motion` disables drawn VFX while keeping functional state changes (`"reduced_motion_keeps_state": true`), and `"volume_preserving_squash"` keeps `scale_x * scale_y` within `[0.85, 1.15]` (for example `scale_x: 1.25, scale_y: 0.8` or `scale_x: 0.8, scale_y: 1.25`).
- **Host CSS variable theming (`css_vars`):** expose 2 to 8 `--*` CSS custom properties with valid CSS colors (for example `--sk-ink`, `--sk-card`, `--sk-acc`) so host `:root` rules win cleanly.
- **Post-render verification (`verification`):** omit when running `--pre-render`; for full signoff include `>= 4` strictly increasing `"frame_strip_times_s"`, `"widths_px"` covering phone (`<= 390`) and desktop (`>= 1024`), `"horizontal_overflow": false`, and `"keyboard_checked": true`.

Exact `check_design.py --sakuga` JSON shape (use ONLY these top-level keys; adapt `control`, `beats`, `volume_preserving_squash`, and `verification` to the brief):

```json
{
  "control": "button",
  "plain_at_rest": true,
  "immediate_state_change": true,
  "beats": [
    { "name": "anticipation", "effects": ["press_squash"] },
    { "name": "hit", "effects": ["impact_burst", "invert_frame"], "sfx_word": "DON!" },
    { "name": "follow_through", "effects": ["smoke_puffs"] },
    { "name": "settle", "effects": ["spring_settle"] }
  ],
  "shared_clock_canvas": true,
  "visual_rules": {
    "flat_two_tone_outline": true,
    "exit_by_shrink_not_fade": true,
    "spring_driven": true,
    "reduced_motion_keeps_state": true,
    "volume_preserving_squash": { "scale_x": 1.25, "scale_y": 0.8 }
  },
  "css_vars": { "--sk-ink": "#1a1a1f", "--sk-card": "#ffffff", "--sk-acc": "#e84a7f" },
  "verification": {
    "frame_strip_times_s": [0, 0.05, 0.12, 0.25, 0.45, 0.8],
    "widths_px": [390, 1440],
    "horizontal_overflow": false,
    "keyboard_checked": true
  }
}
```

## Prescriptive self-repair lint and micro-craft parity

Run `python3 -B <folder>/scripts/check_design.py --web-lint site/ --fidelity` after every draft to audit HTML and CSS files (`.html`, `.htm`, `.css`). Every finding prints `[rule] file:line | what | why | Fix:` so you repair all drift in one pass without stripping visual craft:

1. **Four design-system contracts (0 findings):**
   - `no-raw-colors`: never write raw `#hex` or `rgb(...)` anywhere outside `:root` / `@theme` (including added cards, navs, tables, or borders) and never use raw Tailwind palette utilities (`bg-pink-500`, `text-slate-900`). Reference only declared semantic tokens (`var(--bg)`, `var(--ink)`, `var(--surface)`, `var(--hairline)`, `var(--accent)`).
   - `no-arbitrary-values`: never write bracketed arbitrary spacing/type/radius values (`p-[13px]`, `rounded-[7px]`, `z-[999]`); snap to standard scale utilities or declare a token.
   - `no-inline-styles`: scan EVERY tag inside `<body>`, and DELETE the entire `style="..."` attribute whenever it sets any normal CSS property (`color`, `padding`, `margin`, etc.), EVEN if the value uses `var(--...)`. Style the element selector (`h1`, `p`) inside `<style>` instead; NEVER invent a new `class="..."` in `<body>` unless that exact `.class` is already declared in `<style>` above. Keep inline `style` ONLY when every property name starts with `--` (`style="--stagger-index: 2"`).
   - `no-unknown-classes`: because `<style>` is written before `<body>`, EVERY `class="..."` you emit in `<body>` MUST already have a matching `.class` rule in `<style>` above (fix typos like `card-hedaer` -> `card-header`, and never introduce an undeclared class name in `<body>`).
2. **Micro-craft and anti-regression fidelity (`--fidelity`):**
   - **No `ease-in` on entrances and no `scale(0)`:** use `ease-out` or `cubic-bezier(0.22, 1, 0.36, 1)` under `300ms` (never `transition: all`), start pops from `transform: scale(0.95); opacity: 0`, give buttons `transform: scale(0.97)` on `:active`, use `h-dvh` / `min-h-dvh` instead of `h-screen` / `min-h-screen`, use `font-variant-numeric: tabular-nums` on numbers, and ALWAYS include `@media (prefers-reduced-motion: reduce)` whenever any `transition` or `animation` exists.
   - **Never pass by stripping styles:** keep `>= 4` `:root` semantic tokens (`--bg`, `--ink`, `--hairline`, `--accent`), explicit bare `body` (`font-size: 16px`) and bare `h1` (`font-size: >= 36px`, display/body ratio `>= 2.0`), responsive `@media` or `clamp()`, semantic `<header>`, `<main>`, `<h1>`, `overflow-x: clip` (never `100vw` or `overflow-x: hidden`), and `:focus-visible`.

Minimal clean studio HTML skeleton passing `--web-lint --fidelity` with 0 findings (keep all `:root` tokens, bare `body`/`h1` sizes, `:focus-visible`, `@media`, and `prefers-reduced-motion`; never add raw colors or undeclared classes when adapting):

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Brand</title>
<style>
:root {
  --bg: #f6f1e7;
  --surface: #ffffff;
  --ink: #1e1b18;
  --hairline: rgba(30, 27, 24, 0.12);
  --accent: #a63d28;
}
html, body { overflow-x: clip; background: var(--bg); color: var(--ink); font-size: 16px; line-height: 1.5; margin: 0; }
header, main { max-width: 65ch; margin: 0 auto; padding: 24px; }
h1 { font-size: 40px; letter-spacing: -0.02em; text-wrap: balance; }
.card { background: var(--surface); border: 1px solid var(--hairline); padding: 20px; }
.btn { background: var(--accent); color: var(--surface); border: 0; padding: 10px 18px; transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.btn:active { transform: scale(0.97); }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (min-width: 768px) { header, main { padding: 48px; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none; animation: none; } }
</style></head>
<body><header><h1>Brand</h1></header><main><section class="card"><p>Concrete facts.</p><button class="btn" type="button">Action</button></section></main></body>
</html>
```

**1-Pass Self-Repair Map (edit BOTH `<style>` AND every tag in `<body>`; keep every semantic landmark and `:root` token):**

| Diagnostic rule | Broken pattern | Exact 1-pass replacement |
| --- | --- | --- |
| `no-raw-colors` | raw `#hex` or `rgb(...)` outside `:root` | replace with a declared `:root` token such as `var(--accent)` |
| `no-arbitrary-values` | `p-[13px]` / `rounded-[7px]` / `z-[999]` | snap to a standard scale utility or declare a named token in `:root` / `@theme` |
| `no-inline-styles` | `style="padding: 13px"` / `style="color: #999"` | edit `<body>` to DELETE the entire `style` attribute and style the tag selector in `<style>` (never invent an undeclared `class="..."` in `<body>`); keep ONLY `style="--custom-var: ..."` |
| `no-unknown-classes` | HTML class missing from `<style>` | fix spelling in `<body>` to the declared `.class` in `<style>` (or declare `.class` in `<style>` first) |
| `micro-craft` / `no-transition-all` | `transition: all 300ms ease-in` / `scale(0)` / `h-screen` | `transition: transform 180ms ease-out` / `scale(0.95); opacity: 0` / `h-dvh` |
| `safe-overflow` / `no-slop-patterns` | `width: 100vw` / `overflow-x: hidden` / purple-blue gradient / hype copy | `width: 100%` / `overflow-x: clip` / solid `var(--surface)` / concrete facts |
| `focus-visible` / `reduced-motion` | missing focus or motion fallback | add `a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` and `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none; animation: none; } }` |
