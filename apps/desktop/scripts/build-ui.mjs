// SPDX-License-Identifier: AGPL-3.0-only
// Builds the app's start-up page (ui/) into ui/dist, which Tauri puts inside the app. Plain files only: no inline
// script or style, so the page runs under the app's strict content security policy.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ui = fileURLToPath(new URL('../ui', import.meta.url));
const out = join(ui, 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(ui, 'main.ts')],
  outdir: out,
  bundle: true,
  format: 'esm',
  target: ['safari15', 'chrome110'],
  minify: true,
  loader: { '.svg': 'file', '.woff2': 'file' },
  assetNames: 'assets/[name]-[hash]',
  legalComments: 'eof',
  logLevel: 'warning',
});
copyFileSync(join(ui, 'index.html'), join(out, 'index.html'));
console.log(`The start-up page is in ${out}`);
