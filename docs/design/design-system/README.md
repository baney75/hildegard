Hildegard is an open-source, self-hosted generative studio named for Saint Hildegard of Bingen (1098–1179): abbess, composer, visionary, naturalist, inventor of a language. One person, every medium. Build every surface as a modern, premium creative tool first, with a quiet medieval soul underneath: illuminated manuscript meets pro audio and video software. Never a church website, never a dev-tool dashboard.

The three promises run through every screen: **you save money, your work stays private, and you own everything you make.**

## Content fundamentals

- Write warm, plain and confident. Short labels, sentence case everywhere ("Force now", "Add a device", never "Add A Device").
- Address the person as "you"; Hildegard speaks of itself rarely and never as "I".
- Name things for what they do. The cluster is the **Choir** and its devices are **voices**; everything else uses plain words: Studio, Queue, Models, Costs & Keys, Settings.
- Nods to the namesake are welcome in empty and welcome states only: "Nothing yet. Every work begins as a vision." No religious language in functional UI, no Latin in buttons, no jargon walls.
- Put cost and privacy in the sentence, not in a footnote: "Est. $0.00 · saves $0.48", "Stays on your devices", "Nothing left your devices except 2 requests to ElevenLabs."
- Money always carries a word: "saved", "spent". Never a bare signed number.
- No emoji in interface copy.

## Visual foundations

### Colour: Hildegard's own palette

Every hue comes from her texts and the Rupertsberg *Scivias*. Use each for its meaning and nothing else.

| Hue | Her words | Tokens | Use it for |
|---|---|---|---|
| **Viriditas** | the Spirit's "sweet, green freshness" | `brand`, `on-brand`, `brand-text`, `viridian-deep` | Primary actions, the selected item, progress, the brand ground |
| **Gold** (Living Light) | "golden rays" from the Trinity; Ecclesia "a gleaming, golden figure" | `gold`, `on-gold`, `gold-text`, `gold-leaf`, `state-running`, `glow-live` | Live and running work, ornament rules, the mark's lens |
| **Sapphire** (Wisdom) | "a person who was the color of sapphire" (Scivias II.2); "the fullness of wisdom" (*Physica*) | `sapphire-deep`, `sapphire`, `on-sapphire`, `sapphire-text`, `state-queued` | Media grounds, the Choir diagram, links, queued work |
| **Ember** (the Spirit's fire) | "a very pleasant fire of reddish color"; "a red glow like the dawn" | `ember`, `on-ember`, `ember-text`, `state-spent`, `glow-force` | **Force now** only, and money spent on outside APIs |
| **Burgundy** (Passion and rubric) | "mixed with purple and blue"; "a red tunic" | `burgundy`, `on-burgundy`, `burgundy-text`, `state-error` | Destructive actions, errors, the rubric drop initial |
| **Vellum and silver** | "white as snow and translucent as crystal"; the silver Spirit and Cross | `canvas` (light), `text-primary` (dark), `silver`, `hairline` | Grounds, text, orbit lines |

- Dark is the default theme: `canvas` → `panel` → `raised` step up in lightness. Light theme is warm vellum, never pure white.
- Put text only on the grounds its token note names. Every text token holds 4.5:1 or better on `canvas`, `panel`, `raised` and `sapphire-deep` in both themes. Fills pair with their `on-` token.
- Never let a hue carry a state alone. `hg-status` always pairs a glyph with a word: a spinning ring for Running, a hollow ring for Queued, a dash for Idle, a triangle for errors, a check for Done.
- Ember means "now, at a cost to something". Keep it off everything else so Force now stays unmistakable.
- Saved money is `state-saved` green with a plus sign; spent money is `state-spent` ember. The words carry the meaning for people who cannot tell them apart.

### Type

- **Display:** Cormorant Garamond 500/600 (`display-xl` … `h2`) for screen titles, heroes and the wordmark's voice. Never below 24px; at smaller sizes its hairlines break up.
- **Interface:** Source Sans 3 variable (`title`, `body-lg`, `body`, `body-strong`, `body-sm`, `label`, `caption`, `overline`). Body is 15px on desktop, 17px (`body-lg`) on phones; every text field is 16px or larger so iOS does not zoom.
- **Mono:** DM Mono (`mono`, `mono-sm`, `figure-md`, `figure-lg`) for model names, logs, job ids, pairing codes and every number that is money, size or time. Use `.hg-num` for tabular figures.
- **Ornament:** Uncial Antiqua (`initial`) for a single drop initial in `burgundy-text` on Onboarding and empty states. Decorative only, never a word.
- All four faces ship as files under `fonts/`. Load them locally; Hildegard must look right offline.

### Space, radius, elevation

- A 4px grid: `space-1` (4) to `space-16` (64). Card padding `space-4`, panel padding `space-5`, section gaps `space-6`.
- Radii: `radius-xs` tracks and bars, `radius-sm` chips and inputs, `radius-md` buttons and rows, `radius-lg` cards and thumbnails, `radius-xl` panels, sheets and the prompt bar, `radius-pill` chips and switches.
- In dark, elevation is a lighter surface plus `shadow-1`/`shadow-2`. In light it is a soft warm shadow. The only glows are `glow-live` (gold, running work) and `glow-force` (ember, Force now).
- One gold hairline rule (`.hg-rule`) may separate sections inside a card. Never more than one per card; ornament must never cost density or legibility.

### Motion

- 160ms ease for colour and background; 180ms for switches; 400ms for progress.
- Rings rotate: the outer gold ring at 1.6s, the inner green ring counter-rotating at 2.4s, so many voices sing at different tempos. The Choir's gold orbit turns once a minute.
- Honour `prefers-reduced-motion`: every spin stops and state stays readable from the glyph and word.

## Layout across every platform

Hildegard is one product on macOS, Windows, Linux (plus an Omarchy plugin), iOS, iPadOS, Android and any browser. Build one layout that adapts to **window classes**, never to device names or user agents.

| Window class | Width | Navigation | Typical surface |
|---|---|---|---|
| compact | < `bp-medium` (600) | bottom tab bar (`hg-tabbar`) + safe-area inset | iPhone, Android phones, narrow browser |
| medium | 600 – 839 | icon-over-label rail (`rail-width`) | iPad portrait, Android foldables, split view |
| expanded | ≥ `bp-expanded` (840) | sidebar with labels (`sidebar-width`) | iPad landscape, laptops, desktop app |
| wide | ≥ `bp-wide` (1280) | sidebar + docked inspector (`inspector-width`) | desktop app and desktop browsers |

- Wrap every app in `.hg-app` and call `Hildegard.watch(app)`. It measures the space the app may fill and sets `data-wc`; all layout CSS keys off that attribute.
- **Every browser surface offers the Layout switch** (`[data-hg-layout-switch]`): Auto, Desktop, Tablet, Phone. Auto follows the window. Desktop on a phone or tablet widens the viewport to `frame-desktop` with pinch zoom kept, like "Request desktop site". Tablet and Phone on a wide window centre the app as a framed column (`frame-tablet`, `frame-phone`). The choice is remembered per device (`hildegard.layout`), and reaching it takes one tap: in the top bar on expanded and wide, under More on compact.
- Native apps map the same classes: SwiftUI compact width = compact, regular width split by the same breakpoints; Android Compose `WindowSizeClass` Compact/Medium/Expanded map one to one. Use `NavigationSplitView`/`NavigationRail` for medium and expanded, `TabView`/`NavigationBar` for compact.
- Touch targets: every tappable control is at least `target-min` (44px) on iOS and iPadOS and `target-comfort` (48px) on Android. `target-dense` (32px) is for pointer-only dense tables. `@media (pointer: coarse)` raises targets automatically whatever the layout, so an iPad with a keyboard in Desktop mode stays tappable.
- Respect `env(safe-area-inset-*)` on every edge; the tab bar adds the bottom inset.
- The inspector docks only on wide windows; below 1280px the same content opens as a sheet (`hg-sheet`). Force now confirms in a dialog on expanded and wide and in a bottom sheet on compact.

### Local and desktop apps

- The desktop app is the same web build in a native shell. Reserve `titlebar-height` as a drag region; inset content by `titlebar-inset-mac` on the left on macOS and `titlebar-inset-win` on the right on Windows. Draw no platform chrome inside the core layout.
- Everything loads from the app itself: fonts from `fonts/`, icons from the bundle, logos from the asset files. No CDN or network call is needed to render any screen, so Hildegard works on a LAN address (`hildegard.local`), offline, and from any device in the Choir.
- Keyboard first on desktop: every action reachable by Tab; ⌘/Ctrl-K opens the prompt bar; ⌘/Ctrl-Enter creates; F forces the selected queued job (with its confirmation).
- The menu bar and tray popover (`hg-tray`, `tray-width`) shows this device's mode, what it is running, and the Lend compute switch. Use `tray-template.svg` on macOS and `tray-light.svg` on Windows and Linux.

## Iconography

- Use the bundle's icon set (`Hildegard.icon(name, size)` or `<i data-icon="name">` + `Hildegard.hydrate()`): 24px grid, `stroke-icon` 1.5px, round caps and joins, drawn in `currentColor`. At 16px they switch to `stroke-icon-bold`.
- Modalities each have one icon: `transcribe`, `label`, `image`, `voice`, `music`, `video`, `model3d`. Navigation: `studio`, `choir`, `queue`, `models`, `costs`, `settings`. Layout: `auto`, `desktop`, `tablet`, `phone`.
- Icons never replace a label in primary navigation; icon-only buttons carry an `aria-label`.
- No emoji, no filled duotone icons, no third-party icon fonts.

## Logo

- The mark is written, not drawn: two strokes of a 42° broad nib form the Scivias cosmic egg and the stems of an H. The left stroke rises into a hairline tongue of flame, and a gold lens (lux vivens) crosses the counter. Use the files in **Logos**; never redraw, outline or monoline it.
- On ink use the vellum files, on vellum the green files, on `viridian-deep` the vellum files. Below 20px use a one-colour mark.
- The wordmark is Cormorant Garamond 600 with a gold flame for the dot of the i. Never retype it; use `wordmark-*.svg`.
- App icons for every platform live in **App icons**. Android ships as an adaptive pair (foreground + background) plus a themed monochrome layer.

## Accessibility

- WCAG AA in both themes, checked for every text token on every ground its note names.
- The focus ring is `focus-ring` at `stroke-focus` with `focus-offset`, solid, 3:1 or better on every surface.
- Status never depends on colour; money never depends on colour; gold never signals a state alone.
- Dialogs trap focus and say what they will interrupt before the person confirms.
