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

// The card: a real take fills the right and fades into the ground under the headline; a strip of four more takes sits
// bottom right, clear of the corner where X lays the site's name over a card. `w` and `h` set its size, so one design
// makes both the page's link preview (1200 by 630) and the GitHub repository's social preview (1280 by 640). Every
// frame is a real render from the page's gallery (see WORK in site/main.js), all on one laptop GPU.
const card = (w, h) => `${base}<style>
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500.woff2"); font-weight: 500; }
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500-Italic.woff2"); font-weight: 500; font-style: italic; }
@font-face { font-family: "Hildegard Sans"; src: url("fonts/HildegardSans-Variable.woff2"); font-weight: 200 900; }
@font-face { font-family: "DM Mono"; src: url("fonts/DMMono-400.woff2"); font-weight: 400; }
html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
body { position: relative; background: #0a0e13; color: #f2ecdd; font-family: "Hildegard Sans", sans-serif; }
.still { position: absolute; right: 0; top: 0; width: ${w - 380}px; height: ${h}px; object-fit: cover; object-position: 62% 50%; }
.fade { position: absolute; inset: 0; background:
  linear-gradient(90deg, #0a0e13 0 34%, #0a0e13e6 46%, #0a0e1366 66%, #0a0e1300 82%),
  linear-gradient(0deg, #0a0e13cc 0, #0a0e1300 34%),
  radial-gradient(40% 60% at 0% 0%, #12301f99, transparent 70%); }
.words { position: absolute; left: 80px; top: 64px; width: 760px; display: flex; flex-direction: column; align-items: flex-start; }
.lock { height: 44px; margin-bottom: 44px; }
h1 { margin: 0 0 0 -4px; font: 500 82px/84px "Cormorant Garamond", serif; letter-spacing: -.01em; white-space: nowrap; text-shadow: 0 2px 24px #0a0e13; }
h1 em { display: block; color: #e6c473; font-style: italic; }
.what { margin: 26px 0 0; width: 540px; font-size: 26px; line-height: 35px; color: #d6d0c0; text-shadow: 0 1px 12px #0a0e13; }
.free { margin-top: 26px; display: flex; gap: 10px; }
.free span { padding: 7px 14px; border: 1px solid #e6c47366; border-radius: 999px; font-size: 19px; color: #e6c473; background: #0a0e13b3; }
.strip { position: absolute; right: 56px; bottom: 48px; display: flex; gap: 10px; }
.strip img { width: 132px; height: 74px; object-fit: cover; border-radius: 6px; outline: 1px solid #f2ecdd33; box-shadow: 0 6px 20px #0008; }
.cap { position: absolute; right: 56px; bottom: 134px; font: 400 17px "DM Mono", monospace; color: #e8e2d2; text-shadow: 0 1px 8px #000; }
</style>
<img class="still" src="img/work/illuminator-quill.webp" alt="">
<div class="fade"></div>
<div class="words">
  <img class="lock" src="img/lockup-horizontal-vellum.svg" alt="">
  <h1>Your own AI studio,<em>on your own GPU.</em></h1>
  <p class="what">Films, voices, characters, 3D and websites, made on computers you own. Your AI apps direct it.</p>
  <div class="free"><span>Free</span><span>Open source</span><span>No credits</span></div>
</div>
<span class="cap">Every frame: one laptop GPU</span>
<div class="strip">
  <img src="img/work/lighthouse-keeper.webp" alt=""><img src="img/work/neon-raincoat.webp" alt="">
  <img src="img/work/caravan-dune.webp" alt=""><img src="img/work/golden-hour-sea-stack.webp" alt="">
</div>`;

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
      : path.endsWith('.webp')
        ? 'image/webp'
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
