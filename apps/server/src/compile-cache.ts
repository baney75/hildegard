// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Import this first in an entry point. Node strips the types from every .ts file it loads and compiles the result on
 * each start; its compile cache keeps that work, which more than halves how long `hildegard` takes to start. The cache
 * sits in the person's own cache folder (never a shared one, since what it holds runs); HILDEGARD_COMPILE_CACHE=off
 * turns it off, and a NODE_COMPILE_CACHE the person set wins.
 */
import { mkdirSync } from 'node:fs';
import { enableCompileCache } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

function cacheDir(): string {
  const home = homedir();
  const base =
    process.env.XDG_CACHE_HOME ||
    (process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Caches')
        : join(home, '.cache'));
  return join(base, 'hildegard', 'node-compile');
}

if (process.env.HILDEGARD_COMPILE_CACHE !== 'off' && !process.env.NODE_COMPILE_CACHE) {
  try {
    const dir = cacheDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    enableCompileCache(dir);
  } catch {
    // No cache is only slower.
  }
}
