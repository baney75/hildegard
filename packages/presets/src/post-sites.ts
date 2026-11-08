// SPDX-License-Identifier: Apache-2.0
/**
 * The sites people post to, from `presets/post-sites.json`: where each one's page for posting is, and which domains
 * its window in the Hildegard app may show. The desktop app reads the same file when it is built, so the Studio's
 * links and the app's site windows agree on what belongs to a site.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defaultPresetsDir } from './load.ts';
import { PostPlatform } from './post.ts';

const Host = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'a host name');
/**
 * A sign-in entry: a domain (and its subdomains), or a host and the start of a path, ending in `/`, for one part of a
 * host that is otherwise somebody else's (`www.google.com/recaptcha/`).
 */
const AuthEntry = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/([a-z0-9_-]+\/)+)?$/,
    'a host name, or a host and a path ending in /',
  );
const Https = z
  .string()
  .url()
  .refine((u) => u.startsWith('https://'), 'an https address');

export const PostSite = z.object({
  id: PostPlatform,
  name: z.string().min(1).max(40),
  home: Https,
  /** Where posting starts: the upload page, or the home page when the site has none to link to. */
  post: Https,
  /** The site's own domains, and every subdomain of them. */
  domains: z.array(Host).min(1),
  /** What its sign-in flow uses besides its own domains: captchas and bot checks included. */
  auth: z.array(AuthEntry),
  /**
   * `app`: the link opens the site's window in the Hildegard app. `browser`: the site (Google's) does not allow
   * signing in inside an app, so links from the Studio open the system browser.
   */
  opensIn: z.enum(['app', 'browser']),
});
export type PostSite = z.infer<typeof PostSite>;

export const PostSites = z.object({ sites: z.array(PostSite).min(1) });

/** Parse and cross-check the file: every address on its own site's domains, no domain on two sites that differ. */
export function parsePostSites(json: string): PostSite[] {
  const { sites } = PostSites.parse(JSON.parse(json));
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.id)) problems.push(`site "${s.id}" is defined twice`);
    seen.add(s.id);
    for (const [what, url] of [
      ['home', s.home],
      ['post', s.post],
    ] as const) {
      const host = new URL(url).hostname;
      if (!s.domains.some((d) => host === d || host.endsWith(`.${d}`)))
        problems.push(`${s.id}: ${what} ${url} is not on its domains`);
    }
  }
  if (problems.length)
    throw new Error(`post-sites.json has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return sites;
}

export function loadPostSites(dir = defaultPresetsDir()): PostSite[] {
  return parsePostSites(readFileSync(join(dir, 'post-sites.json'), 'utf8'));
}
