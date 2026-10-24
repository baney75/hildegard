// SPDX-License-Identifier: AGPL-3.0-only
// Renders every app icon from the design system's sources in brand/app-icons/ with Playwright's Chromium:
// the desktop app's icons and tray glyphs (apps/desktop/src-tauri/icons/), the Studio's favicon, and the install
// page's favicon and home-screen icon. Run after changing any file in brand/app-icons/:
//   node scripts/app-icons.mjs

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'brand', 'app-icons');
const icons = join(root, 'apps', 'desktop', 'src-tauri', 'icons');
const { chromium } = createRequire(join(root, 'apps', 'studio', 'package.json'))('@playwright/test');

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const page = await browser.newPage();

/** One SVG drawn at size × size px, as PNG bytes; transparent unless the SVG fills its own ground. */
async function render(name, size) {
  const svg = readFileSync(join(src, name)).toString('base64');
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>` +
      `<img src="data:image/svg+xml;base64,${svg}">`,
  );
  await page.locator('img').evaluate((img) => img.decode());
  return page.screenshot({ omitBackground: true, type: 'png' });
}

/** Apple's icon family: each entry is a PNG under its OSType. */
async function icns(name) {
  const types = [
    ['icp4', 16],
    ['icp5', 32],
    ['ic11', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic13', 256],
    ['ic09', 512],
    ['ic14', 512],
    ['ic10', 1024],
  ];
  const parts = [];
  for (const [type, size] of types) {
    const png = await render(name, size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    parts.push(head, png);
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** A Windows icon with PNG entries; 256 is written as 0 in the directory. */
async function ico(name, sizes) {
  const pngs = [];
  for (const size of sizes) pngs.push(await render(name, size));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(sizes.length, 4);
  let at = dir.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(pngs[i].length, e + 8);
    dir.writeUInt32LE(at, e + 12);
    at += pngs[i].length;
  });
  return Buffer.concat([dir, ...pngs]);
}

const out = {
  // Linux bundles and the window icon use the flat disc, macOS its own body, Windows its plate.
  '32x32.png': await render('appicon-linux-flat.svg', 32),
  '128x128.png': await render('appicon-linux-flat.svg', 128),
  '128x128@2x.png': await render('appicon-linux-flat.svg', 256),
  'icon.png': await render('appicon-linux-flat.svg', 512),
  'icon.icns': await icns('appicon-macos.svg'),
  'icon.ico': await ico('appicon-windows.svg', [16, 24, 32, 48, 64, 256]),
  // The macOS menu bar takes a 22 pt template at 2x; Windows and Linux trays sit on dark bars.
  'tray-template.png': await render('tray-template.svg', 44),
  'tray.png': await render('tray-light.svg', 64),
};
for (const [file, bytes] of Object.entries(out)) writeFileSync(join(icons, file), bytes);
// iOS draws its own rounded mask over the full-bleed square.
writeFileSync(join(root, 'site', 'img', 'apple-touch-icon.png'), await render('appicon-ios.svg', 180));
await browser.close();
for (const to of [join(root, 'site', 'favicon.svg'), join(root, 'apps', 'studio', 'public', 'favicon.svg')])
  copyFileSync(join(src, 'favicon.svg'), to);
console.log('Wrote the desktop icons, both favicons and site/img/apple-touch-icon.png');
