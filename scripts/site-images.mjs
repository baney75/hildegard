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

// The card: the headline on the left, three real frames from the work on the right. `w` and `h` set its size, so one
// design makes both the page's link preview (1200 by 630) and the GitHub repository's social preview (1280 by 640).
const card = (w, h) => `${base}<style>
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500.woff2"); font-weight: 500; }
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500-Italic.woff2"); font-weight: 500; font-style: italic; }
@font-face { font-family: "Hildegard Sans"; src: url("fonts/HildegardSans-Variable.woff2"); font-weight: 200 900; }
@font-face { font-family: "DM Mono"; src: url("fonts/DMMono-400.woff2"); font-weight: 400; }
html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
body {
  position: relative; background: #0a0e13; color: #f2ecdd; font-family: "Hildegard Sans", sans-serif;
  background-image: radial-gradient(50% 70% at 86% 42%, #15265acc, transparent 70%),
    radial-gradient(40% 60% at 4% 0%, #12301fcc, transparent 70%);
}
.lock { position: absolute; left: 80px; top: 70px; height: 44px; }
h1 { position: absolute; left: 76px; top: 150px; margin: 0; width: 700px; font: 500 78px/82px "Cormorant Garamond", serif; letter-spacing: -.01em; }
h1 em { display: block; color: #e6c473; font-style: italic; }
p { position: absolute; left: 80px; top: ${h - 196}px; margin: 0; width: 560px; font-size: 26px; line-height: 34px; color: #bcb6a6; }
.url { position: absolute; left: 80px; bottom: 50px; font: 400 20px "DM Mono", monospace; color: #97968c; }
.reel { position: absolute; right: 36px; top: -70px; width: ${w - 790}px; display: grid; gap: 14px; transform: rotate(-3deg); }
.reel img { display: block; width: 100%; aspect-ratio: 1248 / 704; object-fit: cover; border-radius: 10px; box-shadow: 0 0 0 1px #e9dfc624, 0 24px 60px -20px #000; }
.reel img:nth-child(2) { margin-left: -48px; }
.fade { position: absolute; inset: 0; background: linear-gradient(90deg, #0a0e13 0, #0a0e13 600px, transparent 720px); pointer-events: none; }
</style>
<div class="reel"><img src="img/work/illuminator-quill.webp" alt=""><img src="img/work/neon-raincoat.webp" alt=""><img src="img/work/caravan-dune.webp" alt=""></div>
<div class="fade"></div>
<img class="lock" src="img/lockup-horizontal-vellum.svg" alt="">
<h1>Your own AI studio, <em>on your own GPU.</em></h1>
<p>Films, voices, characters and 3D, made on computers you own. Free and open source.</p>
<span class="url">dbaney.com/hildegard</span>`;

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
