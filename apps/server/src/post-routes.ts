// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/post/*: the Post sheet's side. Preparing a post makes files and words in a folder and nothing else; no route
 * here contacts a platform. Only the owner may use any of it, and the routes that touch this computer (showing a file
 * in its folder, and handing the app the latest caption) answer only to this computer itself.
 */
import { release } from 'node:os';
import { extname } from 'node:path';
import {
  POST_TARGET_IDS,
  POST_TARGETS,
  type PostFile,
  PostPlatform,
  type PostSite,
  type PostState,
} from '@hildegard/presets';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv } from './access.ts';
import { BrowseSiteError, type BrowseSites, sharedCookies } from './browse-sites.ts';
import { PostError, type Poster } from './post.ts';

export interface PostRouteDeps {
  poster: Poster;
  sites: PostSite[];
  /** The sites the person added to the app's Browse menu. */
  browse: BrowseSites;
  ownerOnly: (c: Ctx) => Response | null;
  /** Whether the request is from this computer itself. */
  local: (c: Ctx) => boolean;
  sendFile: (c: Ctx, file: string, type: string) => Response;
  /** Shows a file in the computer's file manager. */
  reveal: (path: string) => void;
}

const TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.jpg': 'image/jpeg',
  '.txt': 'text/plain; charset=utf-8',
};

const Https = z
  .string()
  .trim()
  .max(500)
  .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), 'a web address');

const Create = z.object({
  source: z.object({ kind: z.enum(['export', 'take', 'still']), id: z.string().min(1).max(64) }),
  platforms: z.array(PostPlatform).min(1).max(8),
  formats: z
    .array(z.string().refine((f) => POST_TARGET_IDS.includes(f), 'a format Hildegard makes'))
    .max(12)
    .optional(),
  facts: z
    .object({
      title: z.string().trim().max(300).optional(),
      about: z.string().trim().max(5000).optional(),
      tags: z.array(z.string().max(60)).max(40).optional(),
      link: Https.optional(),
      disclose: z.boolean().optional(),
    })
    .default({}),
  youtube4k: z.boolean().optional(),
  fit: z.enum(['blur', 'crop']).optional(),
  onScreenText: z.string().trim().max(300).optional(),
});

export function postRoutes(d: PostRouteDeps) {
  const { poster } = d;
  const app = new Hono<HgEnv>();
  app.use('*', async (c, next) => {
    // A signed link from an MCP result opens that one file, as media links do.
    if (c.get('signedMedia') && c.req.method === 'GET' && c.req.path.includes('/files/')) return next();
    return d.ownerOnly(c) ?? next();
  });

  /** A post as an answer: the folder is where it is on this computer, so only this computer is told. */
  const view = (c: Ctx, p: PostState): PostState => ({ ...p, folder: d.local(c) ? poster.folder(p) : null });
  const fail = (c: Ctx, e: unknown) => {
    if (e instanceof PostError) return c.json({ error: e.message }, e.status);
    throw e;
  };

  // What can be made, and the sites it goes to.
  app.get('/targets', (c) => c.json({ targets: POST_TARGETS, sites: d.sites }));

  // The Browse menu in the Hildegard app: the built-in sites and the ones the person added. Changing the list changes
  // this computer's own files, so only this computer may.
  const browseView = () => ({
    sites: d.sites,
    custom: d.browse.list(),
    sharedCookies: sharedCookies(process.platform, release()),
  });
  app.get('/browse', (c) => c.json(browseView()));
  app.post('/browse', async (c) => {
    if (!d.local(c)) return c.json({ error: 'Add sites on the computer Hildegard runs on.' }, 403);
    const body = z
      .object({ name: z.string().max(200), url: z.string().max(500) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Give the site a name and an address.' }, 400);
    try {
      d.browse.add(body.data.name, body.data.url);
      return c.json(browseView(), 201);
    } catch (e) {
      if (e instanceof BrowseSiteError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  app.delete('/browse/:id', (c) => {
    if (!d.local(c)) return c.json({ error: 'Change sites on the computer Hildegard runs on.' }, 403);
    try {
      d.browse.remove(c.req.param('id'));
      return c.json(browseView());
    } catch (e) {
      if (e instanceof BrowseSiteError) return c.json({ error: e.message }, e.status);
      throw e;
    }
  });
  app.get('/', (c) => c.json(poster.list().map((p) => view(c, p))));

  // The newest file for a platform, for the Hildegard app to hand to the system browser. This computer only: it
  // names a path and carries a caption.
  app.get('/latest/:platform', (c) => {
    if (!d.local(c)) return c.json({ error: 'Only this computer can ask for that.' }, 403);
    const platform = PostPlatform.safeParse(c.req.param('platform'));
    if (!platform.success) return c.json({ error: 'No such platform' }, 404);
    const latest = poster.latestFor(platform.data);
    if (!latest) return c.json({ found: false });
    const { post, file } = latest;
    return c.json({
      found: true,
      post: post.id,
      target: file.target,
      title: file.text.title,
      caption: file.text.caption,
      path: poster.filePath(post, file.file!),
    });
  });

  app.post('/', async (c) => {
    const body = Create.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ error: `Check “${body.error.issues[0]?.path.join('.') ?? 'the request'}”.` }, 400);
    try {
      return c.json(view(c, poster.prepare(body.data)), 202);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/:id', (c) => {
    const p = poster.get(c.req.param('id'));
    return p ? c.json(view(c, p)) : c.json({ error: 'No such post' }, 404);
  });

  // The checklist: the person ticks a platform once they have posted to it.
  app.patch('/:id/files/:target', async (c) => {
    const body = z.object({ posted: z.boolean() }).safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Say whether it is posted.' }, 400);
    try {
      return c.json(view(c, poster.setPosted(c.req.param('id'), c.req.param('target'), body.data.posted)));
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/:id/reveal', async (c) => {
    if (!d.local(c)) return c.json({ error: 'Only this computer can show its own files.' }, 403);
    const p = poster.get(c.req.param('id'));
    if (!p) return c.json({ error: 'No such post' }, 404);
    const body = z
      .object({ target: z.string().max(40).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    const f: PostFile | undefined =
      body.success && body.data.target ? p.files.find((x) => x.target === body.data.target) : undefined;
    const path = f?.file ? poster.filePath(p, f.file) : poster.folder(p);
    if (!path) return c.json({ error: 'That file is gone.' }, 404);
    d.reveal(path);
    return c.json({ ok: true });
  });

  app.get('/:id/files/:name', (c) => {
    const p = poster.get(c.req.param('id'));
    const file = p && poster.filePath(p, c.req.param('name'));
    if (!file) return c.body(null, 404);
    const res = d.sendFile(c, file, TYPES[extname(file)] ?? 'application/octet-stream');
    if (c.req.query('download') !== undefined && res.ok)
      res.headers.set(
        'content-disposition',
        `attachment; filename="${c.req.param('name').replace(/[^\w.-]/g, '_')}"`,
      );
    return res;
  });

  return app;
}
