// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /s/<id>/…: a published site, shown to anyone with no sign-in, on the Studio's listener and on the hosted one. This
 * is the one place Hildegard serves files to the public, so it serves as little as it can:
 *
 * - GET and HEAD only, and only for a site the owner has published.
 * - Only files under the site's own folder. The path is decoded, checked segment by segment, then resolved to its
 *   real location, which must still be inside the folder (a symlink out is refused) and must pass the same checks.
 * - Never `notes/`, a draft post, `site.json`, a name that starts with a dot, or a half-written file.
 * - Every response is its own sandbox (an opaque origin, with no scripts unless the site has scripts of its own), so
 *   a published page can't reach Hildegard's API or the Studio's cookies even though it is served from the same host.
 * - It reads no cookie and sets none (app.ts leaves /s/ out of the sign-in check).
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import type { HgEnv } from './access.ts';
import { TYPES } from './browser.ts';
import type { Sites } from './sites.ts';

const TYPE: Record<string, string> = {
  ...TYPES,
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};
const ID = /^[a-f0-9]{12}$/;

/** What a published page may load: its own files, and scripts only if the site has scripts to run. */
export function publicCsp(scripts: boolean): string {
  return [
    `sandbox ${scripts ? 'allow-scripts ' : ''}allow-popups allow-popups-to-escape-sandbox`,
    "default-src 'none'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "media-src 'self'",
    scripts ? "script-src 'self'" : '',
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
  ]
    .filter(Boolean)
    .join('; ');
}

/** Whether a path inside the site (already split) is one the public never gets. */
function withheld(parts: string[], drafts: Set<string>): boolean {
  const low = parts.map((p) => p.toLowerCase());
  if (low[0] === 'notes') return true;
  if (low[0] === 'blog' && low[1] && drafts.has(low[1])) return true;
  const last = low.at(-1) ?? '';
  return last === 'site.json' || last.endsWith('.hg-tmp') || low.some((p) => p.startsWith('.'));
}

export function publicSiteRoutes(sites: Sites) {
  const app = new Hono<HgEnv>();
  const gone = () => new Response(null, { status: 404, headers: { 'x-content-type-options': 'nosniff' } });

  /** The published site, or null: an unpublished site and one that doesn't exist look the same. */
  const published = (id: string) => {
    if (!ID.test(id)) return null;
    try {
      const s = sites.get(id);
      return s.published ? s : null;
    } catch {
      return null;
    }
  };

  app.on(['POST', 'PUT', 'PATCH', 'DELETE'], '/*', (c) =>
    c.body(null, 405, { allow: 'GET, HEAD', 'x-content-type-options': 'nosniff' }),
  );

  app.get('/:id', (c) => {
    const id = c.req.param('id');
    return published(id) ? new Response(null, { status: 308, headers: { location: `/s/${id}/` } }) : gone();
  });

  app.get('/:id/*', (c) => {
    const id = c.req.param('id');
    const site = published(id);
    if (!site) return gone();
    const drafts = new Set(site.drafts.map((d) => d.slug));

    let rel: string;
    try {
      rel = decodeURIComponent(c.req.path.slice(`/s/${id}/`.length));
    } catch {
      return gone();
    }
    if (rel.includes('\\') || [...rel].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f))
      return gone();
    const parts = rel.split('/');
    const wantsDir = rel === '' || rel.endsWith('/');
    if (wantsDir) parts.pop();
    if (parts.some((p) => p === '' || p.startsWith('.')) || withheld(parts, drafts)) return gone();

    let root: string;
    try {
      root = realpathSync(sites.folder(id));
    } catch {
      return gone();
    }
    /** The real file for a path in the site, if it is inside the folder and allowed. */
    const find = (inside: string[]): { file: string; dir: boolean } | null => {
      let real: string;
      try {
        real = realpathSync(resolve(root, ...inside));
      } catch {
        return null;
      }
      const back = relative(root, real);
      if (back === '..' || back.startsWith(`..${sep}`) || resolve(root, back) !== real) return null;
      if (back && withheld(back.split(sep), drafts)) return null;
      const st = statSync(real);
      return st.isFile() || st.isDirectory() ? { file: real, dir: st.isDirectory() } : null;
    };

    let hit = find(parts);
    if (hit?.dir) {
      // A folder is its index.html, and its address ends in a slash so the page's relative links work.
      if (!wantsDir) {
        const inner = find([...parts, 'index.html']);
        return inner && !inner.dir
          ? new Response(null, { status: 308, headers: { location: `/s/${id}/${parts.join('/')}/` } })
          : gone();
      }
      hit = find([...parts, 'index.html']);
    } else if (wantsDir && parts.length) hit = null;
    if (!hit || hit.dir) return gone();

    const ext = hit.file.slice(hit.file.lastIndexOf('.')).toLowerCase();
    const type = TYPE[ext] ?? 'application/octet-stream';
    const document = type.startsWith('text/html') || type.startsWith('image/svg');
    const scripts = document && sites.files(id).some((f) => /\.m?js$/i.test(f.path));
    const body = readFileSync(hit.file);
    return new Response(new Uint8Array(body), {
      headers: {
        'content-type': type,
        'content-length': String(body.length),
        'x-content-type-options': 'nosniff',
        'content-security-policy': publicCsp(scripts),
        'cache-control': 'public, max-age=60',
        // A sandboxed page has no origin, so its own fonts and pictures are cross-origin loads; these are public.
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
      },
    });
  });
  return app;
}
