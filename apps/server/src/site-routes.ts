// SPDX-License-Identifier: AGPL-3.0-only
/**
 * /api/sites/*: the owner's websites. A site starts from a template, a Figma file, a pen.dev file, a live site or a
 * ZIP; any linked AI app reads and writes its files; the canvas changes its tokens and words; and it previews at
 * /preview/<id>/<key>/, where its pages run sandboxed, with no way to Hildegard's API.
 */
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Ctx, HgEnv } from './access.ts';
import { TYPES } from './browser.ts';
import { CANVAS_SCRIPT } from './canvas.ts';
import { readTokens, setToken, type Token, tokenValue } from './css-tokens.ts';
import { designSite, esc } from './design.ts';
import { FigmaError, type FigmaFetch, importFigma } from './figma.ts';
import type { SecretStore } from './hf.ts';
import { PenError, parseJsonc, penDesign, penImages } from './pen.ts';
import { ImportError, type importUrl } from './site-import.ts';
import { SiteError, type Sites, sitePath } from './sites.ts';
import { listTemplates, templateFiles } from './templates.ts';
import { readZip, ZipError } from './zip.ts';

export interface SiteRouteDeps {
  sites: Sites;
  ownerOnly: (c: Ctx) => Response | null;
  /** The keychain entry for a named secret (the Figma token is "figma"). */
  secrets: (account: string) => SecretStore;
  /** Imports a live site; absent when this computer has no Chromium-family browser. */
  importUrl?: (url: string) => ReturnType<typeof importUrl>;
  /** Figma's API, for the tests. */
  figmaFetch?: FigmaFetch;
}

const TEXT = /\.(html?|css|js|mjs|json|svg|txt|md|xml|webmanifest)$/i;

const Create = z.discriminatedUnion('from', [
  z.object({ from: z.literal('empty'), title: z.string().trim().min(1).max(120) }),
  z.object({
    from: z.literal('template'),
    template: z.string().trim().min(1).max(40),
    title: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({
    from: z.literal('figma'),
    url: z.string().trim().min(10).max(1000),
    title: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({
    from: z.literal('pen'),
    pen: z.string().min(2).max(60_000_000),
    /** The pictures the file uses, by the path it gives them, as base64. */
    images: z.record(z.string().max(300), z.string().max(40_000_000)).optional(),
    title: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({
    from: z.literal('url'),
    url: z.string().trim().min(4).max(2000),
    title: z.string().trim().min(1).max(120).optional(),
  }),
  z.object({
    from: z.literal('zip'),
    /** A ZIP of the site, as base64. */
    data: z.string().min(4).max(140_000_000),
    title: z.string().trim().min(1).max(120),
  }),
]);

const b64 = (s: string) => Buffer.from(s.replace(/^data:[\w/+.-]+;base64,/, ''), 'base64');

/** The site's pages, with an empty one when it has none. */
const STARTER = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<main>
<h1>${esc(title)}</h1>
</main>
</body>
</html>
`;

export function siteRoutes(d: SiteRouteDeps) {
  const { sites } = d;
  const app = new Hono<HgEnv>();
  app.use('*', async (c, next) => d.ownerOnly(c) ?? next());
  const go =
    (h: (c: Ctx) => unknown | Promise<unknown>, status: 200 | 201 = 200) =>
    async (c: Ctx) => {
      try {
        const out = await h(c);
        return out instanceof Response ? out : c.json(out as object, status);
      } catch (e) {
        if (e instanceof SiteError) return c.json({ error: e.message, code: e.code }, e.status);
        if (
          e instanceof FigmaError ||
          e instanceof PenError ||
          e instanceof ImportError ||
          e instanceof ZipError
        )
          return c.json({ error: e.message, code: 'import' }, 422);
        if (e instanceof z.ZodError) {
          const i = e.issues[0];
          return c.json({ error: i?.message ?? 'That request isn’t right.', field: i?.path.join('.') }, 422);
        }
        throw e;
      }
    };
  const body = async (c: Ctx) => (await c.req.json().catch(() => ({}))) as unknown;
  const view = (id: string) => ({
    ...sites.view(id),
    preview: `/preview/${id}/${sites.get(id).previewKey}/`,
    fileList: sites.files(id),
  });
  const figmaToken = () => d.secrets('figma').get();

  app.get(
    '/',
    go(() => ({
      sites: sites.list().map((s) => ({ ...s, preview: `/preview/${s.id}/${s.previewKey}/` })),
      templates: listTemplates(),
      figma: { linked: !!figmaToken() },
      urlImport: !!d.importUrl,
    })),
  );
  app.get(
    '/templates',
    go(() => ({ templates: listTemplates() })),
  );

  // The Figma token: kept in the keychain, never shown again.
  app.put(
    '/figma-token',
    go(async (c) => {
      const { token } = z
        .object({
          token: z
            .string()
            .trim()
            .min(20)
            .max(200)
            .regex(/^[\w-]+$/, 'That isn’t a Figma token.'),
        })
        .parse(await body(c));
      const f: FigmaFetch = d.figmaFetch ?? ((u, i) => fetch(u, i));
      const r = await f('https://api.figma.com/v1/me', { headers: { 'X-Figma-Token': token } }).catch(
        () => null,
      );
      if (!r?.ok)
        throw new SiteError(
          422,
          'figma',
          'Figma didn’t accept that token. Make a personal access token with file content read access.',
        );
      const me = (await r.json().catch(() => ({}))) as { handle?: string; email?: string };
      d.secrets('figma').set(token);
      return { linked: true, as: me.handle ?? me.email ?? null };
    }),
  );
  app.delete(
    '/figma-token',
    go(() => {
      d.secrets('figma').delete();
      return { linked: false };
    }),
  );

  app.post(
    '/',
    go(async (c) => {
      const b = Create.parse(await body(c));
      if (b.from === 'empty')
        return view(
          sites.create({
            title: b.title,
            source: 'empty',
            files: [
              ['index.html', STARTER(b.title)],
              ['styles.css', ':root {\n  color-scheme: light dark;\n}\n'],
            ],
          }).id,
        );
      if (b.from === 'template') {
        const t = listTemplates().find((x) => x.id === b.template);
        if (!t)
          throw new SiteError(
            404,
            'no_template',
            `There’s no template called ${b.template}. The templates: ${listTemplates()
              .map((x) => x.id)
              .join(', ')}.`,
          );
        return view(
          sites.create({
            title: b.title ?? t.name,
            source: 'template',
            from: t.id,
            files: templateFiles(t.id),
            notes: [
              `From the ${t.name} template. Its words are for a made-up business: write the real ones first.`,
              ...t.images.map((i) => `${i.file} (${i.aspect}): ${i.prompt}`),
            ],
          }).id,
        );
      }
      if (b.from === 'figma') {
        const token = figmaToken();
        if (!token)
          throw new SiteError(
            409,
            'figma_token',
            'Hildegard has no Figma token yet. The owner adds one in Studio (Sites → Link Figma) or with `hildegard figma token`.',
          );
        const out = await importFigma(b.url, token, { fetch: d.figmaFetch });
        const site = designSite(out.design);
        return view(
          sites.create({
            title: b.title ?? out.design.title,
            source: 'figma',
            from: b.url,
            files: [...site.files, ...out.files],
            reference: out.reference,
            notes: out.design.notes,
          }).id,
        );
      }
      if (b.from === 'pen') {
        const doc = (() => {
          try {
            return parseJsonc(b.pen);
          } catch {
            throw new PenError('That .pen file isn’t valid JSON.');
          }
        })();
        const files = new Map<string, Buffer>();
        const images = new Map<string, string>();
        for (const want of penImages(doc)) {
          const data = b.images?.[want];
          if (!data) continue;
          const name = want
            .split('/')
            .pop()!
            .replace(/[^\w.-]+/g, '-');
          const path = sitePath(`assets/${name}`);
          files.set(path, b64(data));
          images.set(want, path);
        }
        const design = penDesign(doc, b.title ?? 'Design', images);
        const site = designSite(design);
        return view(
          sites.create({
            title: b.title ?? design.pages[0]!.name,
            source: 'pen',
            files: [...site.files, ...files],
            notes: design.notes,
          }).id,
        );
      }
      if (b.from === 'url') {
        if (!d.importUrl)
          throw new SiteError(
            501,
            'no_browser',
            'Importing a site needs Chrome, Chromium, Edge or Brave on the computer Hildegard runs on.',
          );
        const out = await d.importUrl(b.url);
        return view(
          sites.create({
            title: b.title ?? out.title,
            source: 'url',
            from: out.url,
            files: out.files,
            reference: out.reference,
            notes: out.notes,
          }).id,
        );
      }
      const entries = readZip(b64(b.data));
      // A ZIP of one folder: the folder's contents are the site.
      const tops = new Set(entries.map((e) => e.name.split('/')[0]));
      const strip = tops.size === 1 && entries.every((e) => e.name.includes('/')) ? `${[...tops][0]}/` : '';
      return view(
        sites.create({
          title: b.title,
          source: 'files',
          files: entries.map((e) => [e.name.slice(strip.length), e.data] as [string, Uint8Array]),
        }).id,
      );
    }, 201),
  );

  app.get(
    '/:id',
    go((c) => view(c.req.param('id') ?? '')),
  );
  app.patch(
    '/:id',
    go(async (c) => {
      const b = z
        .object({
          title: z.string().trim().min(1).max(120).optional(),
          newPreviewKey: z.boolean().optional(),
        })
        .parse(await body(c));
      sites.update(c.req.param('id') ?? '', b);
      return view(c.req.param('id') ?? '');
    }),
  );
  app.delete(
    '/:id',
    go((c) => {
      sites.delete(c.req.param('id') ?? '');
      return { ok: true };
    }),
  );
  app.get(
    '/:id/zip',
    go((c) => {
      const id = c.req.param('id') ?? '';
      const s = sites.get(id);
      return new Response(new Uint8Array(sites.zip(id)), {
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${s.title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'site'}.zip"`,
        },
      });
    }),
  );

  // Files. Read back as text or bytes, never as a page on Hildegard's own address.
  const fileOf = (c: Ctx) => decodeURIComponent(c.req.path.replace(/^.*?\/files\//, ''));
  app.get(
    '/:id/files/*',
    go((c) => {
      const p = fileOf(c);
      const data = sites.read(c.req.param('id') ?? '', p);
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': TEXT.test(p) ? 'text/plain; charset=utf-8' : 'application/octet-stream',
          'cache-control': 'no-store',
        },
      });
    }),
  );
  app.put(
    '/:id/files/*',
    go(async (c) => {
      if (Number(c.req.header('content-length') ?? 0) > 50 * 1024 * 1024)
        throw new SiteError(413, 'size', 'Files up to 50 MB.');
      return sites.write(c.req.param('id') ?? '', fileOf(c), new Uint8Array(await c.req.arrayBuffer()));
    }),
  );
  app.delete(
    '/:id/files/*',
    go((c) => sites.remove(c.req.param('id') ?? '', fileOf(c))),
  );

  // The design to hold it to.
  app.put(
    '/:id/reference',
    go(async (c) => {
      const width = Number(c.req.query('width'));
      return sites.setReference(c.req.param('id') ?? '', new Uint8Array(await c.req.arrayBuffer()), width);
    }),
  );
  app.get(
    '/:id/reference',
    go((c) => {
      const s = sites.get(c.req.param('id') ?? '');
      const path = sites.referencePath(s.id);
      if (!path || !s.reference)
        throw new SiteError(404, 'no_reference', 'This site has no image of its design.');
      return new Response(new Uint8Array(readFileSync(path)), {
        headers: {
          'content-type': s.reference.file.endsWith('.png') ? 'image/png' : 'image/jpeg',
          'cache-control': 'no-store',
        },
      });
    }),
  );

  // Tokens: every custom property set on :root across the site's stylesheets.
  const tokens = (id: string): Token[] =>
    sites
      .files(id)
      .filter((f) => f.path.endsWith('.css') && f.bytes < 2_000_000)
      .flatMap((f) => readTokens(sites.read(id, f.path).toString('utf8'), f.path));
  app.get(
    '/:id/tokens',
    go((c) => ({ tokens: tokens(c.req.param('id') ?? '') })),
  );
  app.post(
    '/:id/tokens',
    go(async (c) => {
      const id = c.req.param('id') ?? '';
      const b = z
        .object({
          name: z.string().regex(/^--[\w-]{1,80}$/),
          value: z.string().max(300),
          dark: z.boolean().optional(),
          file: z.string().max(300).optional(),
        })
        .parse(await body(c));
      if (!tokenValue(b.value)) throw new SiteError(422, 'value', 'That value can’t go in a stylesheet.');
      const where = tokens(id).filter(
        (t) => t.name === b.name && t.dark === !!b.dark && (!b.file || t.file === b.file),
      );
      if (!where.length) throw new SiteError(404, 'no_token', `The site doesn’t set ${b.name}.`);
      const file = where.at(-1)!.file;
      const next = setToken(sites.read(id, file).toString('utf8'), b.name, b.value, !!b.dark);
      if (!next) throw new SiteError(422, 'value', 'That value can’t go in a stylesheet.');
      sites.write(id, file, next);
      return { tokens: tokens(id) };
    }),
  );

  // Words: a piece of text that appears once in a page, changed there.
  app.post(
    '/:id/text',
    go(async (c) => {
      const id = c.req.param('id') ?? '';
      const b = z
        .object({
          page: z.string().max(300),
          from: z
            .string()
            .min(1)
            .max(4000)
            .refine((v) => !/[<>]/.test(v), 'Give the words as they read, without markup.'),
          to: z.string().max(4000),
        })
        .parse(await body(c));
      if (!/\.html?$/i.test(b.page)) throw new SiteError(422, 'page', 'Give the page the words are on.');
      const html = sites.read(id, b.page).toString('utf8');
      const forms = [
        ...new Set([b.from, esc(b.from), b.from.replace(/&/g, '&amp;'), b.from.replace(/'/g, '&#39;')]),
      ];
      const hit = forms.map((f) => ({ f, n: html.split(f).length - 1 })).filter((x) => x.n > 0);
      if (!hit.length)
        throw new SiteError(
          404,
          'no_text',
          'Those words aren’t written that way in the page (they may be split by tags). Change them in the file.',
        );
      if (hit.length > 1 || hit[0]!.n > 1)
        throw new SiteError(
          409,
          'many',
          'Those words are in the page more than once. Change them in the file.',
        );
      sites.write(id, b.page, html.replace(hit[0]!.f, esc(b.to)));
      return view(id);
    }),
  );
  return app;
}

/** The headers a previewed page is sent with: its own origin, no way out but to its own files, framed only here. */
export const PREVIEW_CSP =
  "sandbox allow-scripts allow-forms allow-popups; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

/** /preview/<id>/<key>/<path>: a site's file, for the canvas and for opening a page in a browser tab. */
export function previewRoutes(sites: Sites) {
  const app = new Hono<HgEnv>();
  app.get('/:id/:key/*', (c) => {
    const id = c.req.param('id');
    const key = c.req.param('key');
    let site: ReturnType<Sites['get']>;
    try {
      site = sites.get(id);
    } catch {
      return c.body(null, 404);
    }
    const a = Buffer.from(site.previewKey);
    const b = Buffer.from(key);
    if (a.length !== b.length || !a.equals(b)) return c.body(null, 404);
    let rel = decodeURIComponent(c.req.path.split('/').slice(4).join('/'));
    if (rel === '.hildegard/canvas.js')
      return new Response(CANVAS_SCRIPT, {
        headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
      });
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    let data: Buffer;
    try {
      data = sites.read(id, rel);
    } catch {
      return c.body(null, 404);
    }
    const ext = rel.split('.').pop()!.toLowerCase();
    const type = TYPES[`.${ext}`] ?? 'application/octet-stream';
    if (ext === 'html' && c.req.query('canvas') === '1') {
      const tag = `<script src="/preview/${id}/${key}/.hildegard/canvas.js"></script>`;
      const html = data.toString('utf8');
      data = Buffer.from(
        /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}</body>`) : html + tag,
      );
    }
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': type,
        'cache-control': 'no-store',
        'content-security-policy': PREVIEW_CSP,
      },
    });
  });
  return app;
}
