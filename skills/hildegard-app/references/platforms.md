# Platforms, states and systems

## Sizes and conventions

Sizes are in points (iOS), dp (Android) or px (desktop); in the HTML they are all CSS px at the device's width.

| | iOS (iPhone) | Android (phone) | Desktop (macOS, Windows, web app) |
| --- | --- | --- | --- |
| Canvas | 390 x 844 (`--device iphone`); 375 x 667 small | 412 x 915 (`--device android`); 360 x 800 small | 1280 x 800 (`--device desktop`), 1440 x 900 |
| System chrome | status bar 47 at top, home indicator 34 at bottom: nothing tappable there | status bar 24 to 32, gesture bar 16 to 24 | the window's title bar; macOS traffic lights top left, Windows controls top right |
| Top | large title (34) that collapses to a 44 nav bar; back at top left with the previous title | top app bar 64 with the title; back arrow at left | toolbar or header 48 to 56; the app's name or the document's |
| Navigation | tab bar at the bottom, 49 tall, 2 to 5 tabs, icon over label | navigation bar at the bottom, 80 tall, 3 to 5 destinations; or a drawer | a sidebar 220 to 280 wide, or tabs; menus and keyboard shortcuts |
| Primary action | a full-width button near the bottom, or a nav bar button at top right | a floating action button (56) at bottom right, or a filled button | a filled button, top right of its section, or at the end of a form |
| Smallest target | 44 x 44 | 48 x 48 | 24 x 24 with a pointer (32 or more is kinder) |
| Type | SF Pro, so `-apple-system` or a brand face: large title 34, title 22, headline 17 semibold, body 17, subhead 15, footnote 13, caption 12 | Roboto or a brand face: display 36, headline 28 to 24, title 22 or 16 medium, body 16 and 14, label 14 to 12 | 14 to 16 body, 12 smallest, 20 to 28 titles |
| Lists | full-width rows 44 or more, inset grouped cards | rows 56 to 72, one to three lines | dense rows 32 to 40, tables with tabular figures |
| Sheets, dialogs | bottom sheets, action sheets; alerts are rare | bottom sheets, dialogs with two text buttons | modal dialogs, popovers, inline panels |

Follow the platform the brief names. A web app on a phone follows the phone's habits (bottom navigation, big
targets) without faking a status bar.

## Every screen has states

A screen is not finished until each of these is designed. Most briefs show the full state; the rest are where apps
feel cheap.

| State | What it shows | Never |
| --- | --- | --- |
| Full | real content from the brief, at its real length: long names, big numbers, many rows | "Item 1", lorem ipsum, perfect-length names |
| Empty | what will appear here, why it is empty, and the one action that fills it | a sad illustration and no action |
| Loading | skeletons in the shape of the real layout, after about a second | a spinner on a blank screen for content you can sketch |
| Error | what happened in plain words, what the person can do, their input kept | "Something went wrong", a code, a lost form |
| Offline | what still works, what is waiting to send, when it will retry | blocking the whole screen |
| First run | one sentence of what the app does, and the first step | a five-page tour |
| Permission off | why the app needs it, and the way to turn it on | asking again on every launch |

Design the full state first, then the empty one and whichever other state the brief makes likely (an order that can
fail, a field crew with no signal).

## Tokens and components

Put every value in `tokens.css` (see `templates/tokens.css`) and use only tokens in the screens:

- color by role (ground, surface, ink, muted, line, accent, on-accent, ok, warn, danger), taken from the brand when
  there is one (**hildegard-brand**'s `brand.json`);
- the platform's type sizes as tokens;
- space on a 4 px grid (4, 8, 12, 16, 20, 24, 32, 40), corner radii (two at most), and the platform chrome heights.

Build screens from a few components and reuse them: the row or card, the primary and secondary button, the status
pill, the tab bar, the empty-state block. A new look for the same thing is a bug.

## Writing on screens

Labels are verbs for actions ("Approve proof", not "Submit"), nouns for places ("Orders"). Every number, name and
price comes from the brief. Say what will happen ("We'll text you when it ships"). Error messages say what to do next.

## Icons

Draw simple line icons in inline SVG on a 24 grid with a 1.5 to 2 stroke, or use an open icon set the project already
has (Lucide, Material Symbols). One style per app. Never emoji as icons. Every icon-only button has an `aria-label`.
