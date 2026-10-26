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

// The card: a real frame full bleed, the headline over its dark side. `w` and `h` set its size, so one design makes both
// the page's link preview (1200 by 630) and the GitHub repository's social preview (1280 by 640). X shows only the
// image, with the site's name over its bottom-left corner, so the words sit high and that corner stays empty; every
// word is large enough to read at X's timeline width (about 500 px).
const card = (w, h) => `${base}<style>
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500.woff2"); font-weight: 500; }
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500-Italic.woff2"); font-weight: 500; font-style: italic; }
@font-face { font-family: "Hildegard Sans"; src: url("fonts/HildegardSans-Variable.woff2"); font-weight: 200 900; }
@font-face { font-family: "DM Mono"; src: url("fonts/DMMono-400.woff2"); font-weight: 400; }
html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
body { position: relative; background: #0a0e13; color: #f2ecdd; font-family: "Hildegard Sans", sans-serif; }
.frame { position: absolute; top: 0; left: ${Math.round(w * 0.34)}px; height: 100%; width: ${Math.round((h * 1248) / 704)}px; object-fit: cover; }
.shade { position: absolute; inset: 0;
  background: linear-gradient(90deg, #0a0e13 0, #0a0e13 ${w * 0.36}px, #0a0e13b3 ${w * 0.5}px, #0a0e1300 ${w * 0.66}px),
    linear-gradient(0deg, #0a0e13cc, transparent 30%); }
.lock { position: absolute; left: 72px; top: 60px; height: 46px; }
h1 { position: absolute; left: 68px; top: 140px; margin: 0; font: 500 104px/98px "Cormorant Garamond", serif; letter-spacing: -.015em; text-shadow: 0 2px 24px #0a0e13; }
h1 em { display: block; color: #e6c473; font-style: italic; }
p { position: absolute; left: 72px; top: 368px; margin: 0; width: 620px; font-size: 30px; line-height: 40px; color: #e3dccb; text-shadow: 0 1px 12px #0a0e13; }
.chips { position: absolute; left: 72px; top: 470px; display: flex; gap: 12px; }
.chips span { padding: 9px 18px; border-radius: 999px; border: 1.5px solid #e9dfc659; background: #0a0e13b3; font: 600 21px/1 "Hildegard Sans", sans-serif; letter-spacing: .02em; color: #f2ecdd; }
.chips span:first-child { background: #2c7350; border-color: #2c7350; }
.slate { position: absolute; right: 40px; bottom: 30px; font: 400 17px "DM Mono", monospace; letter-spacing: .06em; color: #f4eeddcc; text-shadow: 0 1px 6px #000; text-transform: uppercase; }
</style>
<img class="frame" src="img/work/golden-hour-sea-stack.webp" alt="">
<div class="shade"></div>
<img class="lock" src="img/lockup-horizontal-vellum.svg" alt="">
<h1>Your own AI studio, <em>on your own GPU.</em></h1>
<p>Films, voices, characters and 3D, made on computers you own.</p>
<div class="chips"><span>Free and open source</span><span>Windows</span><span>macOS</span><span>Linux</span></div>
<span class="slate">Golden Hour, shot II · a 12 GB laptop GPU</span>`;

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
