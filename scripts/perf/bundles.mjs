// SPDX-License-Identifier: AGPL-3.0-only
// What each Studio route downloads (JS and CSS, raw, gzip and brotli), read from the build's manifest: the entry and
// everything it imports, plus the route's own page chunk and what that imports. Needs `pnpm --filter @hildegard/studio build`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIST, sumSizes } from './lib.mjs';

/** The page file each route opens. */
export const ROUTE_PAGES = {
  Cinema: 'src/pages/Cinema.tsx',
  Images: 'src/pages/Images.tsx',
  Queue: 'src/pages/Queue.tsx',
  Settings: 'src/pages/Settings.tsx',
  Sites: 'src/pages/Sites.tsx',
  Voice: 'src/pages/Voice.tsx',
  Talk: 'src/pages/Talk.tsx',
};

export function readManifest() {
  const file = join(DIST, '.vite', 'manifest.json');
  if (!existsSync(file)) throw new Error('No build found. Run: pnpm --filter @hildegard/studio build');
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Every file a chunk needs to run: itself, its static imports and their CSS. */
function closure(manifest, key, seen = new Set()) {
  const c = manifest[key];
  if (!c || seen.has(key)) return seen;
  seen.add(key);
  for (const i of c.imports ?? []) closure(manifest, i, seen);
  return seen;
}

const filesOf = (manifest, keys) => {
  const out = new Set();
  for (const k of keys) {
    const c = manifest[k];
    if (c.file) out.add(c.file);
    for (const css of c.css ?? []) out.add(css);
  }
  return out;
};

/** Bytes per route and for the shell alone (what every route pays). */
export function routeBundles() {
  const manifest = readManifest();
  const entryKey = Object.keys(manifest).find((k) => manifest[k].isEntry && k.endsWith('.html'));
  if (!entryKey) throw new Error('The manifest has no entry.');
  const entryKeys = closure(manifest, entryKey);
  const shell = filesOf(manifest, entryKeys);
  const out = { shell: { ...sumSizes([...shell]), files: shell.size } };
  for (const [route, page] of Object.entries(ROUTE_PAGES)) {
    // A build with no page chunk for the route (before pages were split) carries it in the entry.
    const keys = manifest[page] ? closure(manifest, page) : new Set();
    const all = new Set([...shell, ...filesOf(manifest, keys)]);
    const own = [...all].filter((f) => !shell.has(f));
    out[route] = { ...sumSizes([...all]), files: all.size, ownFiles: own.length };
  }
  return out;
}

if (import.meta.main) console.log(JSON.stringify(routeBundles(), null, 2));
