// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The sites a person adds to the Hildegard app's Browse menu, kept in `<data>/browse/sites.json`. The app reads the same
 * file and checks each entry again (apps/desktop/src-tauri/src/browse.rs `custom_site`), so a site is only ever an https
 * address on a real host: never an IP address, `localhost`, a name with no dot, a port, or a login in the address.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';

export interface CustomSite {
  id: string;
  name: string;
  url: string;
}

export class BrowseSiteError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

const MAX_SITES = 24;

/** The address as the site's front page, or null when it isn't one a site window may show. */
export function siteUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const bare = host.replace(/^\[|\]$/g, '');
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (isIP(bare) || !host.includes('.') || host.endsWith('.')) return null;
  const tld = host.split('.').at(-1)!;
  if (['local', 'localhost', 'internal'].includes(tld)) return null;
  return u;
}

export class BrowseSites {
  private readonly dir: string;
  private readonly file: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'browse');
    this.file = join(this.dir, 'sites.json');
  }

  list(): CustomSite[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { sites?: CustomSite[] };
      return (raw.sites ?? []).filter((s) => /^c-[a-z0-9-]{1,22}$/.test(s.id) && siteUrl(s.url));
    } catch {
      return [];
    }
  }

  add(name: string, url: string): CustomSite {
    const u = siteUrl(url);
    const title = name.trim();
    if (!u)
      throw new BrowseSiteError(
        'Give the site’s address, starting with https://, like https://bsky.app.',
        400,
      );
    if (!title || title.length > 40)
      throw new BrowseSiteError('Give the site a name of up to 40 characters.', 400);
    const sites = this.list();
    const own = (h: string) => h.replace(/^www\./, '');
    if (sites.some((s) => own(new URL(s.url).hostname) === own(u.hostname)))
      throw new BrowseSiteError('That site is already in the list.', 409);
    if (sites.length >= MAX_SITES) throw new BrowseSiteError(`The list holds ${MAX_SITES} sites.`, 409);
    const site = { id: `c-${randomBytes(4).toString('hex')}`, name: title, url: u.toString() };
    this.save([...sites, site]);
    return site;
  }

  /**
   * Takes a site off the list, and its profile folder (its sign-in) with it. The Hildegard app sees the list change,
   * closes the site's window, and clears what is left: the folder again, or on macOS 14 and later its WebKit store.
   */
  remove(id: string): CustomSite {
    const sites = this.list();
    const site = sites.find((s) => s.id === id);
    if (!site) throw new BrowseSiteError('No such site', 404);
    this.save(sites.filter((s) => s.id !== id));
    rmSync(join(this.dir, id), { recursive: true, force: true });
    return site;
  }

  private save(sites: CustomSite[]) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.part`;
    writeFileSync(tmp, JSON.stringify({ sites }, null, 2));
    renameSync(tmp, this.file);
  }
}

/**
 * What removing a site says. On macOS 11 to 13 every site's cookies, and the Studio's, are in one store, so removing
 * one can't take its sign-in with it: the person signs out on the site itself.
 */
export function removalNotice(name: string, shared: boolean): string {
  if (!shared)
    return `Removed ${name}. Its window closes, and its cookies and saved data are gone from Hildegard.`;
  return (
    `Removed ${name}. On macOS 11 to 13 every site in the app shares one set of cookies, so Hildegard can’t clear ` +
    `${name}’s alone and you may still be signed in to it. To sign out, add it again, open it, use its own Sign ` +
    `out, then remove it.`
  );
}

/** macOS before 14 keeps every site's cookies in one store, which the Browse page says plainly. */
export function sharedCookies(platform = process.platform, release = ''): boolean {
  return platform === 'darwin' && Number.parseInt(release, 10) < 23;
}
