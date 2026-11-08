---
name: hildegard-app
description: Use for an app screen or flow (iOS, Android, desktop or web app) and its states (empty, loading, error, offline), built in HTML and CSS at device size, rendered and checked.
---

# App screens

An app screen is judged in a person's hand, in a hurry, with one thumb. It is built here as HTML and CSS at the
device's exact size, from tokens, rendered, measured by a script, and looked at before anyone sees it.

This skill owns the screens inside an app and their states. Websites, landing pages and marketing pages are
**hildegard-web**'s; the app's logo, icon and brand are **hildegard-brand**'s; a poster or social image for it is
**hildegard-design**'s.

<!-- council:start -->
A blind review, only when your user asks for one, is **hildegard-council**'s.
<!-- council:end -->

| File | What it does |
| --- | --- |
| `scripts/screen_check.py` | renders each screen at device size (2x PNG), checks overflow, contrast, clipped text, tap targets, text sizes, safe areas and placeholder copy, and puts every state side by side |
| `references/platforms.md` | iOS, Android and desktop sizes and habits; the states every screen needs; tokens, components, words and icons |
| `templates/tokens.css`, `templates/screen.html`, `templates/screen-empty.html` | a finished iOS screen and its empty state, built from tokens, that pass every check |

The script needs Chromium (Playwright's, or chromium on PATH) and Python 3.9+. Without Chromium, open each file in a
browser's device mode at the size below and check the same list by eye; say plainly that the checks didn't run.

## Steps

1. **Brief card.** Write `brief.md`: the platform and device (default: iPhone, 390 x 844), who uses the screen and
   where (a farm truck, a front desk), the one job of this screen in one sentence, every piece of real content the
   brief gives (names, prices, times, counts), and which states the brief makes likely. Done when each line is from the
   brief.
2. **Read `references/platforms.md`** for the platform's conventions and the states table.
3. **Tokens.** Copy `templates/tokens.css`. Fill the colors from the client's brand (their `brand.json`, or colors
   from their world: see **hildegard-brand**) and keep the platform's type sizes, the 4 px space scale and the chrome
   heights. Done when every value has a role.
4. **Build the full state** as `screen.html` at the device size, using only tokens. Start from
   `templates/screen.html`: system status bar marked `data-system aria-hidden="true"`, one large title, real content,
   one primary action, the platform's navigation. Semantic HTML: `button` for actions, `a` for places, a label for
   every field, `aria-label` on icon-only buttons. Done when every word on it comes from the brief.
5. **Build the other states**: the empty state as `empty.html` at least, and every state the brief makes likely
   (`error.html`, `offline.html`, `loading.html`), each the same screen with that state.
6. **Check.**

   ```sh
   python3 scripts/screen_check.py screen.html empty.html --device iphone --out screen-check
   ```

   Fix every FAIL and run it again. Then open each PNG at full size and `screen-check/screens.png`: hold it at arm's
   length; can you tell in three seconds what the screen is for and what to tap? Done when no check fails and you
   have looked.
7. **Deliver** the HTML files, `tokens.css`, the PNGs and `screens.png`, with one line per state on what it shows,
   and what wasn't checked (a real device, a screen reader, dark mode if not designed).

## Rules that are never relaxed

- Real content only: no lorem ipsum, "Item 1", invented prices, people, ratings or testimonials.
- Nothing tappable under 24 px, and the platform's size (44 iOS, 48 Android) for anything a thumb uses.
- Text at least 4.5:1 against its background (3:1 at 24 px or larger). Nothing important told only by color.
- No dark patterns: no pre-ticked consent, no hidden cost, no cancel harder than the sign-up.
- Never say a screen passes a check you didn't run.
