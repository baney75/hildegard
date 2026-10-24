// SPDX-License-Identifier: AGPL-3.0-only
// Builds the start-up page with Tauri's IPC mocked (ui/preview/preview.ts) into ui/preview/dist, to open in a browser:
// `node scripts/preview-ui.mjs`, then open ui/preview/dist/index.html?state=installing (see preview.ts for the states).
// For working on the page's look only; the app never ships it.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ui = fileURLToPath(new URL('../ui', import.meta.url));
const out = join(ui, 'preview', 'dist');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
await build({
  // Named main, so the page's own index.html loads it as it loads the app's script.
  entryPoints: { main: join(ui, 'preview', 'preview.ts') },
  outdir: out,
  bundle: true,
  format: 'esm',
  target: ['safari15', 'chrome110'],
  loader: { '.svg': 'file', '.woff2': 'file' },
  assetNames: 'assets/[name]-[hash]',
  logLevel: 'warning',
});
copyFileSync(join(ui, 'index.html'), join(out, 'index.html'));
console.log(`The preview is in ${out}`);
