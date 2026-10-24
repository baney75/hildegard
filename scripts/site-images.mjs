// SPDX-License-Identifier: AGPL-3.0-only
// Renders the install page's share card (site/img/og.jpg) and its home-screen icon (site/img/apple-touch-icon.png)
// with Playwright's Chromium, from the page's own fonts and logo files. Run after changing either:
//   node scripts/site-images.mjs

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const site = join(root, 'site');
const { chromium } = createRequire(join(root, 'apps', 'studio', 'package.json'))('@playwright/test');
const base = '<!doctype html><meta charset="utf-8">';

const CARD = `${base}<style>
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500.woff2"); font-weight: 500; }
@font-face { font-family: "Cormorant Garamond"; src: url("fonts/CormorantGaramond-500-Italic.woff2"); font-weight: 500; font-style: italic; }
@font-face { font-family: "Hildegard Sans"; src: url("fonts/HildegardSans-Variable.woff2"); font-weight: 200 900; }
@font-face { font-family: "DM Mono"; src: url("fonts/DMMono-400.woff2"); font-weight: 400; }
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; }
body {
  position: relative; background: #0a0e13; color: #f2ecdd; font-family: "Hildegard Sans", sans-serif;
  background-image: radial-gradient(50% 70% at 86% 42%, #15265acc, transparent 70%),
    radial-gradient(40% 60% at 4% 0%, #12301fcc, transparent 70%);
}
.lock { position: absolute; left: 88px; top: 76px; height: 46px; }
.mark { position: absolute; right: 120px; top: 112px; width: 260px; }
h1 { position: absolute; left: 84px; top: 182px; margin: 0; width: 760px; font: 500 88px/90px "Cormorant Garamond", serif; letter-spacing: -.01em; }
h1 em { display: block; color: #e6c473; font-style: italic; }
.rule { position: absolute; left: 88px; right: 88px; bottom: 132px; height: 1px; background: linear-gradient(90deg, #d9b45c, transparent); opacity: .7; }
p { position: absolute; left: 88px; bottom: 74px; margin: 0; font-size: 27px; line-height: 34px; color: #bcb6a6; }
.url { position: absolute; left: 88px; bottom: 36px; font: 400 20px "DM Mono", monospace; color: #97968c; }
</style>
<img class="lock" src="img/lockup-horizontal-vellum.svg" alt="">
<h1>Your own film studio, <em>on your own GPU.</em></h1>
<img class="mark" src="img/mark-vellum.svg" alt="">
<div class="rule"></div>
<p>Free and open source. Every shot renders on computers you own.</p>
<span class="url">dbaney.com/hildegard</span>`;

const ICON = `${base}<style>
html, body { margin: 0; width: 180px; height: 180px; overflow: hidden; }
body { display: grid; place-items: center; background: radial-gradient(75% 75% at 50% 35%, #2c7350, #12301f); }
img { width: 100px; }
</style><img src="img/mark-vellum.svg" alt="">`;

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
// The pages load the site's own files from a stand-in origin, served straight from site/.
let html = CARD;
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
await page.goto('http://site.local/', { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: join(site, 'img', 'og.jpg'), type: 'jpeg', quality: 86 });
await page.setViewportSize({ width: 180, height: 180 });
html = ICON;
await page.goto('http://site.local/', { waitUntil: 'load' });
await page.screenshot({ path: join(site, 'img', 'apple-touch-icon.png') });
await browser.close();
console.log('Wrote site/img/og.jpg and site/img/apple-touch-icon.png');
