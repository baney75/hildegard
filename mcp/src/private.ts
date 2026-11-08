// SPDX-License-Identifier: AGPL-3.0-only
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { HildegardError } from './client.ts';

/**
 * A signed-in site's profile, `<Hildegard's folder>/browse/<site>/`, holds that site's cookies and storage. Hildegard
 * never reads them and no tool hands them to an agent: a path into one is refused before it is read.
 */
export function isSiteProfile(path: string, home = process.env.HILDEGARD_HOME): boolean {
  const here = resolve(path);
  let real = here;
  try {
    real = realpathSync(here);
  } catch {}
  return [here, real].some((p) => {
    if (home && p.startsWith(resolve(home, 'browse') + sep)) return true;
    // The default folders: Application Support/Hildegard, AppData/Local/Hildegard, ~/.local/share/hildegard.
    return /[\\/]hildegard[\\/]browse[\\/]/i.test(p);
  });
}

/** Throws for a path that is a signed-in site's profile; returns the path otherwise. */
export function readable(path: string): string {
  if (isSiteProfile(path))
    throw new HildegardError(
      422,
      'That is a signed-in site’s profile, which holds its cookies. Hildegard and the apps that use it never read it.',
    );
  return path;
}
