// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard sites` and `hildegard figma`: websites made here, and the Figma link that imports them. A site starts
 * from a template, a Figma link, a live page or nothing; the canvas in the Studio and any linked AI app work on it from
 * there. The Figma token never goes on the command line: a hidden prompt, or stdin with --token-stdin.
 */
import type { Step } from '@hildegard/runtime';
import { api, askSecret, baseUrl, type Ctx, ensureRunning, readStdin } from './commands.ts';
import { type Result, result } from './output.ts';

interface Site {
  id: string;
  title: string;
  source: { kind: string; from: string | null };
  updatedAt: string;
  pages: string[];
  notes: string[];
  preview: string;
  published?: boolean;
  /** Where it is for everyone when published: a path on this server. */
  path?: string;
  /** The public address of its front page, when it has one. */
  address?: string | null;
}
interface Template {
  id: string;
  name: string;
  for: string;
}
interface Index {
  sites: Site[];
  templates: Template[];
  figma: { linked: boolean };
  urlImport: boolean;
}

const failure = (id: string, title: string, e: unknown): Result => {
  const message = (e as Error).message;
  return result([{ id, title, status: 'failed', detail: message }], message);
};

const siteStep = (c: Ctx['config'], s: Site): Step => ({
  id: `site-${s.id}`,
  title: s.title,
  status: 'done',
  detail: `${s.id} · ${s.pages.length} ${s.pages.length === 1 ? 'page' : 'pages'}${s.published ? ' · published' : ''} · ${baseUrl(c)}/#/sites/${s.id}`,
});

export async function sites(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  const c = ctx.config;
  const action = args[0] ?? 'list';
  if (action === 'list' || action === 'templates') {
    const ix = await api<Index>(c, '/api/sites');
    const steps =
      action === 'templates'
        ? ix.templates.map((t) => ({
            id: `template-${t.id}`,
            title: `${t.id}: ${t.name}`,
            status: 'done' as const,
            detail: `For ${t.for}.`,
          }))
        : ix.sites.map((s) => siteStep(c, s));
    return result(
      steps,
      action === 'templates'
        ? 'Start one with `hildegard sites new <template>`.'
        : ix.sites.length
          ? 'Open one in the Studio, or give an AI app its id.'
          : `No sites yet. Start one from a template (${ix.templates.map((t) => t.id).join(', ')}) with \`hildegard sites new <template>\`, or with --figma <link> or --url <address>.`,
      action === 'templates' ? { templates: ix.templates } : { sites: ix.sites },
    );
  }
  if (action === 'new') {
    const name = ctx.opts.get('name');
    const body = ctx.opts.has('figma')
      ? { from: 'figma', url: ctx.opts.get('figma'), title: name }
      : ctx.opts.has('url')
        ? { from: 'url', url: ctx.opts.get('url'), title: name }
        : args[1]
          ? { from: 'template', template: args[1], title: name }
          : { from: 'empty', title: name ?? 'New site' };
    try {
      const s = await api<Site>(c, '/api/sites', { method: 'POST', body, timeoutMs: 180_000 });
      return result(
        [siteStep(c, s)],
        s.notes.length ? `Made ${s.title}. Still to do:\n- ${s.notes.join('\n- ')}` : `Made ${s.title}.`,
        {
          site: s,
        },
      );
    } catch (e) {
      const r = failure('site', 'Make a site', e);
      if ((e as { data?: { code?: string } }).data?.code === 'figma_token')
        r.steps[0]!.command = 'hildegard figma token';
      return r;
    }
  }
  if (action === 'publish') {
    const id = args[1];
    if (!id)
      return result(
        [{ id: 'publish', title: 'Publish a site', status: 'failed', detail: 'Give the site’s id.' }],
        'Use `hildegard sites publish <id> [--off] [--address <https://example.com/>]`. `hildegard sites` lists the ids.',
      );
    const off = ctx.flags.has('off');
    const title = off ? 'Take a site down' : 'Publish a site';
    try {
      // The owner's own address for the site's front page goes first, so the feed and sitemap carry it.
      if (ctx.opts.has('address'))
        await api(c, `/api/sites/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: { publicUrl: ctx.opts.get('address') },
        });
      const s = await api<Site>(c, `/api/sites/${encodeURIComponent(id)}/publish`, {
        method: 'PUT',
        body: { published: !off },
      });
      const where = s.address ?? `${baseUrl(c)}${s.path ?? `/s/${s.id}/`}`;
      return result(
        [
          {
            id: `site-${s.id}`,
            title: s.title,
            status: 'done',
            detail: off ? 'No longer published.' : `Published at ${where}`,
          },
        ],
        off
          ? `${s.title} is no longer published. Its address answers 404.`
          : `${s.title} is published at ${where}. Anyone with the address can read its pages and files, never its notes or drafts. From other devices it needs the link: \`hildegard host\`.`,
        { site: s },
      );
    } catch (e) {
      return failure('publish', title, e);
    }
  }
  return result(
    [{ id: 'sites', title: 'Sites', status: 'failed', detail: `Unknown: sites ${action}.` }],
    'Use `hildegard sites`, `sites templates`, `sites new [<template>] [--figma <link> | --url <address>] [--name <name>]`, or `sites publish <id> [--off]`.',
  );
}

export async function figma(ctx: Ctx, args: string[]): Promise<Result> {
  const pre = await ensureRunning(ctx);
  if (pre?.status === 'failed') return result([pre], 'Hildegard isn’t running.');
  const c = ctx.config;
  const action = args[0] ?? 'status';
  const title = 'Link Figma';
  if (action === 'status') {
    const ix = await api<Index>(c, '/api/sites');
    return result(
      [
        {
          id: 'figma',
          title,
          status: ix.figma.linked ? 'done' : 'skipped',
          detail: ix.figma.linked ? 'Linked; the token is in this computer’s keychain.' : 'Not linked.',
        },
      ],
      ix.figma.linked ? 'Figma is linked.' : 'Link it with `hildegard figma token`.',
      { figma: ix.figma },
    );
  }
  if (action === 'unlink') {
    await api(c, '/api/sites/figma-token', { method: 'DELETE' });
    return result(
      [{ id: 'figma', title: 'Unlink Figma', status: 'done', detail: '' }],
      'Figma is unlinked; the token is gone from the keychain.',
    );
  }
  if (action === 'token') {
    let token = '';
    if (ctx.flags.has('token-stdin')) token = await readStdin();
    else if (process.stdin.isTTY && !ctx.json) {
      console.log(
        'In Figma: Settings → Security → Personal access tokens. Make one with “File content: read”.',
      );
      token = await askSecret('Token (it won’t show): ');
    } else
      return result(
        [
          {
            id: 'figma',
            title,
            status: 'needs-owner',
            detail:
              'The owner makes a Figma personal access token (File content: read) and links it here, or in the Studio under Sites → New site → Figma.',
            command: 'hildegard figma token',
          },
        ],
        'Waiting on the owner to link Figma.',
      );
    try {
      const r = await api<{ as: string | null }>(c, '/api/sites/figma-token', {
        method: 'PUT',
        body: { token: token.trim() },
      });
      return result(
        [{ id: 'figma', title, status: 'done', detail: r.as ? `As ${r.as}.` : '' }],
        'Figma is linked. Import a file with `hildegard sites new --figma <link>`.',
      );
    } catch (e) {
      return failure('figma', title, e);
    }
  }
  return result(
    [{ id: 'figma', title, status: 'failed', detail: `Unknown: figma ${action}.` }],
    'Use `hildegard figma`, `figma token [--token-stdin]` or `figma unlink`.',
  );
}
