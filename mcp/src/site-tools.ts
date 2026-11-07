// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Site tools: the owner's websites, kept by Hildegard. A site starts from one of the templates, a Figma file, a
 * pen.dev .pen file, a live website or a folder; any AI app reads and writes its files, changes its design tokens, and
 * sends it through the web loop with loop_submit site_id. The owner watches it on the canvas in Studio.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { type HildegardClient, HildegardError, type SiteDetail } from './client.ts';
import { readable } from './private.ts';
import { PackError, zipFolder } from './zip.ts';

const text = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }] });
const fail = (s: string): CallToolResult => ({ content: [{ type: 'text', text: s }], isError: true });
const TEXT = /\.(html?|css|js|mjs|json|svg|txt|md|xml|webmanifest)$/i;

const size = (n: number) =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function registerSiteTools(
  server: McpServer,
  client: HildegardClient,
  remote?: { link: (path: string) => string },
) {
  const guard =
    <A>(fn: (a: A) => Promise<CallToolResult>) =>
    async (a: A): Promise<CallToolResult> => {
      try {
        return await fn(a);
      } catch (e) {
        return fail((e as Error).message);
      }
    };
  const previewOf = (s: { preview: string }) =>
    remote ? remote.link(s.preview) : `${client.url}${s.preview}`;
  const describe = (s: SiteDetail, lead: string) =>
    [
      `${lead} Site ${s.id}: “${s.title}”, ${s.files} files (${size(s.bytes)}), pages ${s.pages.join(', ') || 'none yet'}.`,
      `Preview: ${previewOf(s)} (the owner sees it live on the canvas in Studio → Sites).`,
      s.reference
        ? `It has an image of its design, ${s.reference.width} px wide: start the web loop with site_id and every round is compared with it.`
        : '',
      s.notes.length ? `Notes:\n${s.notes.map((n) => `- ${n}`).join('\n')}` : '',
      `Files: ${s.fileList
        .slice(0, 60)
        .map((f) => f.path)
        .join(', ')}${s.fileList.length > 60 ? `, and ${s.fileList.length - 60} more` : ''}.`,
    ]
      .filter(Boolean)
      .join('\n');

  server.registerTool(
    'site_templates',
    {
      title: 'Website templates',
      description:
        'List the website templates: whole, finished sites (plain HTML and CSS, light and dark, every web check passing) for a bakery, a studio, a software product, a clinic, an event, a parish, documentation, a journal and more. Each says who it suits, its sections, and the pictures to render in place of its drawings. Start a site from one with site_new.',
      inputSchema: {},
    },
    guard(async () => {
      const { templates } = await client.sites();
      if (!templates.length) return text('There are no templates on this Hildegard.');
      return text(
        templates
          .map(
            (t) =>
              `${t.id}: ${t.name}, for ${t.for}. ${t.description}\n  Sections: ${t.sections.join(', ')}.${t.images.length ? `\n  Pictures: ${t.images.map((i) => `${i.file} (${i.aspect})`).join(', ')}.` : ''}`,
          )
          .join('\n\n'),
      );
    }),
  );

  server.registerTool(
    'site_new',
    {
      title: 'Start a site',
      description: `Start a website Hildegard keeps: from a template (site_templates), a Figma file or frame (a figma.com link; the owner links Figma once in Studio), a pen.dev .pen file, a live website you own or have the rights to (copied as it stands, without its scripts, with a screenshot to hold the redesign to), ${remote ? 'a ZIP of a site (data)' : 'a folder on this computer'}, or empty. Figma and pen.dev designs come in as semantic HTML and CSS with their colours as CSS variables, and a Figma import keeps an image of the frame, so the web loop compares every round with the design. Then read and change the files with site_read and site_write, and send it through the loop (loop_start kind "web" with site_id, then loop_submit site_id).`,
      inputSchema: {
        from: z
          .enum(['template', 'figma', 'pen', 'url', 'folder', 'zip', 'empty'])
          .describe('Where the site starts.'),
        title: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe('The site’s name. Needed for empty, folder and zip.'),
        template: z.string().max(40).optional().describe('template: its id, from site_templates.'),
        url: z
          .string()
          .max(2000)
          .optional()
          .describe('figma: the file or frame’s link. url: the website’s address.'),
        pen_text: z.string().max(60_000_000).optional().describe('pen: the .pen file’s JSON.'),
        ...(remote
          ? {}
          : {
              pen_path: z
                .string()
                .optional()
                .describe(
                  'pen: the .pen file on this computer; the pictures it uses are read from beside it.',
                ),
              folder: z.string().optional().describe('folder: the site’s folder on this computer.'),
            }),
        data: z.string().max(140_000_000).optional().describe('zip: a ZIP of the site, as base64.'),
      },
    },
    guard(
      async (a: {
        from: 'template' | 'figma' | 'pen' | 'url' | 'folder' | 'zip' | 'empty';
        title?: string;
        template?: string;
        url?: string;
        pen_text?: string;
        pen_path?: string;
        folder?: string;
        data?: string;
      }) => {
        let body: Record<string, unknown>;
        if (a.from === 'template') {
          if (!a.template) throw new HildegardError(422, 'Give template: an id from site_templates.');
          body = { from: 'template', template: a.template, title: a.title };
        } else if (a.from === 'figma' || a.from === 'url') {
          if (!a.url)
            throw new HildegardError(
              422,
              `Give url: the ${a.from === 'figma' ? 'Figma link' : 'website’s address'}.`,
            );
          body = { from: a.from, url: a.url, title: a.title };
        } else if (a.from === 'pen') {
          let pen = a.pen_text;
          const images: Record<string, string> = {};
          if (a.pen_path) {
            if (!isAbsolute(a.pen_path))
              throw new HildegardError(422, 'pen_path has to be an absolute path.');
            pen = readFileSync(readable(a.pen_path), 'utf8');
            const base = dirname(a.pen_path);
            for (const m of pen.matchAll(/"url"\s*:\s*"([^"]{1,300})"/g)) {
              const rel = m[1]!;
              const p = resolve(base, rel);
              if (!p.startsWith(base + sep) || images[rel]) continue;
              try {
                if (statSync(p).isFile() && statSync(p).size < 20 * 1024 * 1024)
                  images[rel] = readFileSync(p).toString('base64');
              } catch {}
            }
          }
          if (!pen) throw new HildegardError(422, `Give ${remote ? 'pen_text' : 'pen_path or pen_text'}.`);
          body = { from: 'pen', pen, images, title: a.title };
        } else if (a.from === 'folder' || a.from === 'zip') {
          if (!a.title) throw new HildegardError(422, 'Give the site a title.');
          let data = a.data;
          if (a.from === 'folder') {
            if (remote || !a.folder)
              throw new HildegardError(
                422,
                remote ? 'Send the site as a ZIP (from "zip", data).' : 'Give folder.',
              );
            try {
              data = zipFolder(a.folder).toString('base64');
            } catch (e) {
              throw new HildegardError(422, e instanceof PackError ? e.message : (e as Error).message);
            }
          }
          if (!data) throw new HildegardError(422, 'Give data: the ZIP as base64.');
          body = { from: 'zip', data, title: a.title };
        } else {
          if (!a.title) throw new HildegardError(422, 'Give the site a title.');
          body = { from: 'empty', title: a.title };
        }
        const s = await client.createSite(body);
        return text(describe(s, 'Made.'));
      },
    ),
  );

  server.registerTool(
    'site_files',
    {
      title: 'A site, or all of them',
      description:
        'With site_id: the site’s files, pages, notes and preview link. Without: every site Hildegard keeps, newest first.',
      inputSchema: { site_id: z.string().max(40).optional() },
    },
    guard(async (a: { site_id?: string }) => {
      if (a.site_id) return text(describe(await client.site(a.site_id), ''));
      const { sites, figma, urlImport } = await client.sites();
      const head = `Figma ${figma.linked ? 'is linked' : 'isn’t linked yet (the owner links it in Studio → Sites)'}; importing live sites ${urlImport ? 'works here' : 'needs Chrome, Chromium, Edge or Brave on Hildegard’s computer'}.`;
      if (!sites.length) return text(`${head}\nNo sites yet. Start one with site_new.`);
      return text(
        `${head}\n${sites
          .map(
            (s) =>
              `${s.id}: “${s.title}” (${s.source.kind}), ${s.pages.length} pages, ${s.files} files, changed ${s.updatedAt}.`,
          )
          .join('\n')}`,
      );
    }),
  );

  server.registerTool(
    'site_read',
    {
      title: 'Read a site’s file',
      description: 'Read one file of a site: HTML, CSS, JS, SVG and other text come back as text.',
      inputSchema: {
        site_id: z.string().max(40),
        path: z.string().max(300).describe('Such as "index.html".'),
      },
    },
    guard(async (a: { site_id: string; path: string }) => {
      const b = await client.siteFile(a.site_id, a.path);
      if (!TEXT.test(a.path)) return text(`${a.path} isn’t text: ${size(b.length)}.`);
      return text(Buffer.from(b).toString('utf8'));
    }),
  );

  server.registerTool(
    'site_write',
    {
      title: 'Write a site’s file',
      description: `Write one file of a site (folders are made as needed): text for HTML, CSS, JS or SVG; data (base64) for a picture or a font${remote ? '' : '; or file_path to copy a file from this computer'}. The canvas in Studio reloads as you write. Keep everything the pages load inside the site: no fonts, scripts or pictures from other addresses.`,
      inputSchema: {
        site_id: z.string().max(40),
        path: z.string().max(300).describe('Such as "index.html" or "assets/hero.webp".'),
        text: z.string().max(20_000_000).optional(),
        data: z.string().max(70_000_000).optional(),
        ...(remote ? {} : { file_path: z.string().optional() }),
      },
    },
    guard(async (a: { site_id: string; path: string; text?: string; data?: string; file_path?: string }) => {
      const given = [a.text, a.data, a.file_path].filter((x) => x !== undefined).length;
      if (given !== 1) throw new HildegardError(422, 'Give exactly one of text, data or file_path.');
      const bytes =
        a.text !== undefined
          ? new TextEncoder().encode(a.text)
          : a.data !== undefined
            ? Buffer.from(a.data.replace(/^data:[\w/+.-]+;base64,/, ''), 'base64')
            : readFileSync(readable(a.file_path!));
      const s = await client.writeSiteFile(a.site_id, a.path, bytes);
      return text(
        `Wrote ${a.path} (${size(bytes.length)}). The site has ${s.files} files, ${size(s.bytes)}.`,
      );
    }),
  );

  server.registerTool(
    'site_delete_file',
    {
      title: 'Delete a site’s file',
      description: 'Delete one file (or folder) of a site.',
      inputSchema: { site_id: z.string().max(40), path: z.string().max(300) },
    },
    guard(async (a: { site_id: string; path: string }) => {
      const s = await client.deleteSiteFile(a.site_id, a.path);
      return text(`Deleted ${a.path}. The site has ${s.files} files.`);
    }),
  );

  server.registerTool(
    'site_post',
    {
      title: 'Write a post on a site',
      description:
        'Write a blog post on one of the owner’s sites, in the site’s own look: give the title, the body in Markdown (raw HTML is shown as text, never run) and a byline such as “By Jane Doe, with Hildegard”. It makes blog/<slug>/index.html and keeps blog/index.html (newest first), feed.xml and sitemap.xml up to date. Run lint_writing on the body first, and write in the person’s voice (writing_voice). With draft true the post has its page, asks search engines to skip it and is left out of the list, the feed and the sitemap. Give notes_md to keep the interview or notes the post came from at notes/<slug>.md, which is never shown to the public. Posting again with the same slug replaces the post. Nothing is visible to the public until the owner publishes the site (site_publish).',
      inputSchema: {
        site_id: z.string().max(40),
        title: z.string().min(1).max(200),
        body_md: z
          .string()
          .min(1)
          .max(500_000)
          .describe('The post, in Markdown. Start sections at “#”: the title is already the page’s heading.'),
        byline: z.string().min(1).max(200).describe('Such as “By Jane Doe, with Hildegard”.'),
        date: z.string().max(10).optional().describe('YYYY-MM-DD. Today when left out.'),
        slug: z
          .string()
          .max(60)
          .optional()
          .describe('Lower-case letters, digits and hyphens. From the title when left out.'),
        summary: z
          .string()
          .max(600)
          .optional()
          .describe('One or two sentences for the list and the feed. The start of the post when left out.'),
        draft: z.boolean().optional().describe('True to keep it out of the list, the feed and the sitemap.'),
        notes_md: z
          .string()
          .max(500_000)
          .optional()
          .describe('The interview or notes behind the post, kept private.'),
      },
      annotations: {
        title: 'Write a post on a site',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    guard(
      async (a: {
        site_id: string;
        title: string;
        body_md: string;
        byline: string;
        date?: string;
        slug?: string;
        summary?: string;
        draft?: boolean;
        notes_md?: string;
      }) => {
        const { site_id, ...body } = a;
        const r = await client.postToSite(site_id, body);
        const where = r.site.published
          ? r.site.address
            ? `It is public at ${r.site.address}blog/${r.slug}/.`
            : `It is public at ${remote ? 'the Hildegard link' : client.url}${r.site.path}blog/${r.slug}/.`
          : 'The site isn’t published, so nobody outside Hildegard can see it yet; the owner publishes it with site_publish.';
        return text(
          [
            r.draft
              ? `Saved the draft ${r.path}. It is out of the list, the feed and the sitemap, and asks search engines to skip it.`
              : `Wrote ${r.path} (${r.date}) and updated blog/index.html, feed.xml and sitemap.xml.`,
            r.draft ? '' : where,
            r.lint.fails.length
              ? `Prose lint fails: ${r.lint.fails.join(', ')}. Fix them and post again.`
              : r.lint.warns.length
                ? `Prose lint passes, with warnings to weigh: ${r.lint.warns.join(', ')}.`
                : 'Prose lint is clean.',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      },
    ),
  );

  server.registerTool(
    'site_publish',
    {
      title: 'Publish a site, or take it back',
      description:
        'Make a site visible to everyone at its address (/s/<site_id>/ on the Hildegard link, no sign-in), or take it down again with published false. Only the owner can do this, because it changes what the public sees. Only the site’s pages and files are shown: never its notes, its drafts or anything outside the site. Ask the owner before you publish.',
      inputSchema: { site_id: z.string().max(40), published: z.boolean() },
      annotations: {
        title: 'Publish a site, or take it back',
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    guard(async (a: { site_id: string; published: boolean }) => {
      const s = await client.publishSite(a.site_id, a.published);
      return text(
        a.published
          ? `“${s.title}” is published at ${s.address ?? `${remote ? 'the Hildegard link' : client.url}${s.path}`}. Anyone with the address can read it. It is only reachable from other devices when the owner has put Hildegard at a link (hildegard host).`
          : `“${s.title}” is no longer published. Its address answers 404.`,
      );
    }),
  );

  server.registerTool(
    'site_tokens',
    {
      title: 'A site’s design tokens',
      description:
        'Read the site’s design tokens (the CSS variables its stylesheets set on :root, light and dark), or change one everywhere it is used: give name and value (and dark true for the dark theme’s value). Change the system, not one-off values.',
      inputSchema: {
        site_id: z.string().max(40),
        name: z.string().max(90).optional().describe('Such as "--accent".'),
        value: z.string().max(300).optional().describe('Such as "#1f5f4a" or "clamp(2rem, 5vw, 4rem)".'),
        dark: z.boolean().optional(),
      },
    },
    guard(async (a: { site_id: string; name?: string; value?: string; dark?: boolean }) => {
      const out =
        a.name && a.value !== undefined
          ? await client.setSiteToken(a.site_id, { name: a.name, value: a.value, dark: a.dark })
          : await client.siteTokens(a.site_id);
      if (!out.tokens.length)
        return text('This site sets no CSS variables on :root. Put its system in tokens first.');
      return text(
        out.tokens.map((t) => `${t.name}: ${t.value}${t.dark ? ' (dark)' : ''}  [${t.file}]`).join('\n'),
      );
    }),
  );

  if (!remote)
    server.registerTool(
      'site_export',
      {
        title: 'Copy a site to a folder',
        description:
          'Copy every file of a site into a folder on this computer, to port it to a framework, put it under version control, or deploy it. Files already there with the same names are replaced.',
        inputSchema: { site_id: z.string().max(40), folder: z.string().describe('An absolute path.') },
      },
      guard(async (a: { site_id: string; folder: string }) => {
        if (!isAbsolute(a.folder)) throw new HildegardError(422, 'folder has to be an absolute path.');
        const s = await client.site(a.site_id);
        const root = resolve(a.folder);
        for (const f of s.fileList) {
          const to = resolve(root, f.path);
          if (!to.startsWith(root + sep)) continue;
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, await client.siteFile(s.id, f.path));
        }
        return text(`Copied ${s.fileList.length} files of “${s.title}” to ${join(root)}.`);
      }),
    );
}
