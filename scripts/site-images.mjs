// SPDX-License-Identifier: AGPL-3.0-only
// Renders the install page's share card (site/img/og.jpg) and the repository's social preview
// (brand/social-preview.jpg) with Playwright's Chromium, from the page's own fonts
// and logo files; scripts/app-icons.mjs renders its icons. Run after changing the card:
//   node scripts/site-images.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const site = join(root, 'site');
const { chromium } = createRequire(join(root, 'apps', 'studio', 'package.json'))('@playwright/test');
const base = '<!doctype html><meta charset="utf-8">';

// The card: the headline on the left, six real frames from the work on the right, like a contact sheet. X shows the
// image alone with the site's name over its bottom-left corner, so the image carries the whole message, keeps that
// corner clear, and keeps its words 48 px from the top and bottom edges, which X and others may crop. `w` and `h` set
// its size, so one design makes both the page's link preview (1200 by 630) and the GitHub repository's social preview
// (1280 by 640).
const FRAMES = [
  'illuminator-quill',
  'neon-raincoat',
  'lighthouse-keeper',
  'caravan-dune',
  'golden-hour-sea-stack',
  'lighthouse-headland',
];
const card = (w, h) => `${base}<style>
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500.woff2"); font-weight: 500; }
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500-Italic.woff2"); font-weight: 500; font-style: italic; }
@font-face { font-family: "Hildegard Sans"; src: url("fonts/HildegardSans-Variable.woff2"); font-weight: 200 900; }
@font-face { font-family: "DM Mono"; src: url("fonts/DMMono-400.woff2"); font-weight: 400; }
html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
body {
  position: relative; background: #0a0e13; color: #f2ecdd; font-family: "Hildegard Sans", sans-serif;
  background-image: radial-gradient(55% 80% at 84% 50%, #1a2c63bb, transparent 70%),
    radial-gradient(45% 60% at 0% 0%, #12301fcc, transparent 70%);
}
.text { position: absolute; left: 72px; top: 0; bottom: 0; width: 600px; display: flex; flex-direction: column; justify-content: center; padding-bottom: 40px; }
.lock { height: 42px; align-self: flex-start; margin-bottom: 30px; }
h1 { margin: 0; white-space: nowrap; font: 500 76px/80px "Cormorant Garamond", serif; letter-spacing: -.015em; }
h1 em { display: block; color: #e6c473; font-style: italic; }
p { margin: 24px 0 0; font-size: 28px; line-height: 36px; color: #c9c3b2; width: 520px; }
ul { display: flex; gap: 10px; margin: 30px 0 0; padding: 0; list-style: none; }
li { font: 400 18px "DM Mono", monospace; color: #e9e2cf; padding: 9px 14px; border-radius: 999px; background: #f2ecdd12; box-shadow: inset 0 0 0 1px #e9dfc633; }
li b { color: #e6c473; font-weight: 400; }
.sheet { position: absolute; right: 40px; top: 50%; width: ${w - 752}px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px; transform: translateY(-54%) rotate(-4deg); }
.sheet img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; border-radius: 8px; box-shadow: 0 0 0 1px #e9dfc62e, 0 22px 50px -22px #000; }
.sheet img:nth-child(even) { transform: translateY(26px); }
.note { position: absolute; right: 56px; bottom: 48px; font: 400 17px "DM Mono", monospace; color: #a7a596; }
.note b { color: #f2ecdd; font-weight: 400; }
</style>
<div class="sheet">${FRAMES.map((f) => `<img src="img/work/${f}.webp" alt="">`).join('')}</div>
<div class="text">
<img class="lock" src="img/lockup-horizontal-vellum.svg" alt="">
<h1>Your own AI studio, <em>on your own GPU.</em></h1>
<p>Films, voices, characters and 3D, made on computers you own.</p>
<ul><li><b>$0</b> per shot</li><li>Private</li><li>Open source</li></ul>
</div>
<span class="note">Real takes · <b>one 12 GB laptop GPU</b></span>`;

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
// The pages load the site's own files from a stand-in origin, served straight from site/.
let html = '';
const page = await browser.newPage();
await page.route('http://site.local/**', (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ contentType: 'text/html', body: html });
  const contentType = path.endsWith('.svg')
    ? 'image/svg+xml'
    : path.endsWith('.woff2')
      ? 'font/woff2'
      : undefined;
  return route.fulfill({ contentType, body: readFileSync(join(site, decodeURIComponent(path))) });
});
for (const [w, h, out] of [
  [1200, 630, join(site, 'img', 'og.jpg')],
  [1280, 640, join(root, 'brand', 'social-preview.jpg')],
]) {
  html = card(w, h);
  await page.setViewportSize({ width: w, height: h });
  await page.goto('http://site.local/', { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
  console.log(`Wrote ${out.slice(root.length)}`);
}
await browser.close();
