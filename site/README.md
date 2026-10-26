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
- The takes play from `video/work/` (same name as the still, `.mp4`), and `video/reel.mp4` is 2.5 seconds of six of
  them in the order of `REEL` in `main.js`; the hero caption follows the reel by that order. They play only for visitors
  who haven't asked for reduced motion or data saving, and the reel has a pause button. They were cut from the demo
  films in `~/Projects/hildegard-demos/films` on rectory1 with ffmpeg (H.264, no sound, 960 px for takes and 1248 px
  for the reel, `-crf 27`/`25` with `-maxrate` 1 and 1.8 Mb/s, `+faststart`). Keep each take under 1 MB and the reel
  under 3 MB.
- The stills are frames from real takes, in `img/work/`. Their captions (film, shot, prompt word for word, rig, model,
  GPU, render time) are in `WORK` at the top of `main.js`; the one marked `hero` leads the page and is preloaded in
  `index.html`. The Studio screenshots are `img/studio-board.webp` and `img/studio-inspector.webp`. Never caption a
  render that didn't happen.
- Search: the `<title>`, description and the JSON-LD in `<head>` (SoftwareApplication, VideoObject, FAQPage) are
  written for the words people search with (“open source Higgsfield alternative”, “local ElevenLabs”, “AI video on my
  GPU”). The FAQPage must repeat the questions and answers in `#faq` word for word; the site test checks it.
- “What it makes” says plainly what is ready, what works through your AI app, and what is coming. Move a room to Ready
  only when it ships in a release.
- Colours, type and spacing follow the Hildegard design system; the tokens are at the top of `styles.css`.
- `node scripts/site-images.mjs` renders `img/og.jpg` (the link preview) and `brand/social-preview.jpg` (the GitHub
  repository's, uploaded by hand in Settings › Social preview); `node scripts/app-icons.mjs` renders
  `favicon.svg` and `img/apple-touch-icon.png` from `brand/app-icons/`, with the app's own icons.
- X keeps a link's card for days by its image address, so after re-rendering `img/og.jpg` raise the `?v=` on
  `og:image`, `og:image:secure_url` and `twitter:image` in `index.html`. X shows the image alone with the site's name
  over its bottom-left corner, so the card carries the whole message and keeps that corner clear. Check it with
  [opengraph.xyz](https://www.opengraph.xyz/) after it deploys.
- `pnpm --filter @hildegard/studio e2e:site` checks it in both themes, on desktop and a 360 px phone: no sideways
  scroll, accessibility (axe), the OS tabs and the copy buttons. Set `SITE_SHOTS=<folder>` to save screenshots.

The fonts are subsets under the SIL Open Font License; their licenses are in `fonts/`.
