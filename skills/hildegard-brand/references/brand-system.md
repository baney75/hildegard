# The brand system

A brand is the logo plus the rules that make everything else look and sound like the same client: color by role, a
type pairing and scale, a voice, and how pictures look. Fill `brand.json` (start from `templates/example/brand.json`)
and let `brand_guide.py` do the contrast arithmetic and the layout.

## Color, by role

Pick colors from the client's own world first: the brick of the building, the river at dusk, the enamel of their
tools, the paper they print on. Name each one for that thing ("Brick", "Newsprint"), not "Primary Red".

| Role | What it is for | Rule |
| --- | --- | --- |
| `ground` | the page or screen behind everything | a tinted light (warm or cool), rarely pure white |
| `surface` | cards, panels, sheets | a step lighter or darker than ground |
| `ink` | body text, the wordmark | near-black with the brand's tint; at least 4.5:1 on ground and surface (aim for 10:1) |
| `muted` | captions, dates, labels | at least 4.5:1 on ground; it is still text |
| `accent` | the mark, the one primary action, one word per page | the brand's own color; at least 3:1 on ground |
| `on-accent` | text on accent (button labels) | at least 4.5:1 on accent |
| `support` | an optional second color for charts, tags or illustration | never a second accent |

About 60% ground and surface, 30% ink, 10% accent. Two saturated colors fighting is the most common brand-guide
failure; one accent wins.

`brand_guide.py` checks these pairs and any you add under `pairs` (`"use"`: body, small, large or ui). When a pair
fails it prints the nearest color in the same hue that passes. Use it, then look again: a darker accent may need a
lighter surface to stay in character.

## Type

One display face and one text face, both from Google Fonts. Pair by contrast of structure with a shared mood: a serif
display with a sans text, or a heavy grotesque display with a humanist text. The logo's face is usually the display
face. `references/logo.md` has a table of faces by feeling.

The scale runs largest first, with a ratio of about 1.25 (screens) to 1.333 (print) between steps, and nothing under 12
px. Six steps cover almost every client: Display, Headline, Title, Lead, Body, Caption. Body is 16 px on screens.

## Voice in three lines

Each line is a rule a writer can follow, in the client's own register, not a list of adjectives. Formula: what we
sound like, what we always do, what we never do.

- "We talk like printers at the counter: plain, warm, a little proud of the work." (what we sound like)
- "We name the paper, the ink and the press; specifics beat adjectives." (what we always do)
- "We give the price and the wait up front, and never rush a couple." (what we never do)

Then one to three examples, each a pair: a sentence the client would say (`do`) beside the generic sentence a template
would say (`dont`). The `do` uses only facts from the brief. Never invent a price, a year, an award or a promise to
make an example vivid.

## Imagery

Three or four rules each for do and don't, concrete enough to judge a photo against: the subject (real work, real
people with their permission, the place), the light (window light, overcast), the distance (close enough to see the
material), what never appears (stock, mockups passed off as real, filters that fake age). Generated images follow the
same rules and are never passed off as photographs of the client's work.

## The guide

`brand_guide.py brand.json` writes `guide/guide.html` on one US letter page, `guide.png` (1275 x 1650) and
`guide.pdf`, and fails if anything runs into the footer. Reviewers judge `guide.png`.
