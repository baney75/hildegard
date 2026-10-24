# The install page

A static page, no build step: `index.html`, `styles.css`, `main.js`, and the fonts and logo files beside them. Every
path is relative, so it works from any folder, such as `https://dbaney.com/hildegard/`.

## Serving it

- Copy this folder as it is. `node scripts/build-release.mjs` also puts a copy in the release output's `site/`.
- The page's one-liners use short links, so the host must redirect them to the latest release (302, so a new release
  needs no change):
  - `/hildegard/install.sh` to `https://github.com/baney75/hildegard/releases/latest/download/install.sh`
  - `/hildegard/install.ps1` to `https://github.com/baney75/hildegard/releases/latest/download/install.ps1`
- `og:url`, `og:image` and the canonical link in `index.html` name `https://dbaney.com/hildegard/`. Change them if
  the page moves.
- `.github/workflows/pages.yml` can publish it to GitHub Pages, but only when started by hand, with the owner's OK.

## Changing it

- Release URLs and the desktop app's file names are in `RELEASE` and `DESKTOP` at the top of `main.js`.
- The stills are frames from real takes, in `img/work/`. Their captions (film, shot, prompt word for word, rig, model,
  GPU, render time) are in `WORK` at the top of `main.js`; the one marked `hero` leads the page and is preloaded in
  `index.html`. The Studio screenshots are `img/studio-board.webp` and `img/studio-inspector.webp`. Never caption a
  render that didn't happen.
- Colours, type and spacing follow the Hildegard design system; the tokens are at the top of `styles.css`.
- `node scripts/site-images.mjs` renders `img/og.jpg` (the link preview) and `img/apple-touch-icon.png`.
- `pnpm --filter @hildegard/studio e2e:site` checks it in both themes, on desktop and a 360 px phone: no sideways
  scroll, accessibility (axe), the OS tabs and the copy buttons. Set `SITE_SHOTS=<folder>` to save screenshots.

The fonts are subsets under the SIL Open Font License; their licenses are in `fonts/`.
