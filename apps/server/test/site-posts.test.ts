// SPDX-License-Identifier: AGPL-3.0-only
// Posts on a site: a page in the site's own look, the list newest first, the feed and the sitemap; drafts left out;
// Markdown that can't carry HTML; notes kept private.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markdown } from '../src/markdown.ts';
import { CASES } from './fixtures/markdown-cases.ts';
import { boot, type Harness, raw, textOf } from './harness.ts';

let h: Harness;
let journal: string;
let blank: string;

const post = (site: string, body: Record<string, unknown>) =>
  h.local(`/api/sites/${site}/posts`, 'POST', { byline: 'By Jane Doe, with Hildegard', ...body });
const read = async (site: string, path: string) =>
  readFileSync(join(h.dir, 'sites', site, 'files', path), 'utf8');
const siteJson = (site: string) =>
  JSON.parse(readFileSync(join(h.dir, 'sites', site, 'site.json'), 'utf8')) as {
    published: boolean;
    posts: { slug: string }[];
    drafts: { slug: string }[];
  };
const slugsIn = (xml: string) => [...xml.matchAll(/blog\/([a-z0-9-]+)\//g)].map((m) => m[1]);

beforeAll(async () => {
  h = await boot('posts');
  const j = await h.local('/api/sites', 'POST', {
    from: 'template',
    template: 'journal',
    title: 'Low Water',
  });
  journal = ((await j.json()) as { id: string }).id;
  const b = await h.local('/api/sites', 'POST', { from: 'empty', title: 'Plain Site' });
  blank = ((await b.json()) as { id: string }).id;
}, 30_000);
afterAll(() => h.close());

describe('the Markdown renderer', () => {
  it('shows HTML as text and drops addresses that run code', () => {
    const out = markdown(
      'Hello <script>alert(1)</script> and <img src=x onerror=alert(1)>\n\n[click](javascript:alert(1)) [tab](java\tscript:alert(1)) [data](data:text/html,x) [ok](https://example.com/a?b=1&c=2) [rel](../x/) ![p](javascript:x)\n\n```\n<script>x</script>\n```\n\n> <b>q</b>\n\n- <i>li</i>',
    );
    expect(out).not.toMatch(
      /<script|<img src=x|<b>|<i>|href="javascript|href="data|src="javascript|onerror=alert\(1\)>/,
    );
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out).toContain('<a href="https://example.com/a?b=1&amp;c=2">ok</a>');
    expect(out).toContain('<a href="../x/">rel</a>');
  });
  it('reads what a post needs', () => {
    const out = markdown(
      '# One\n\nA *soft* and **hard** `code` line  \nbroken.\n\n1. a\n2. b\n\n---\n\n- x\n  - y',
    );
    expect(out).toContain('<h2>One</h2>');
    expect(out).toContain('<em>soft</em> and <strong>hard</strong> <code>code</code> line<br>');
    expect(out).toContain('<ol>');
    expect(out).toContain('<hr class="break">');
    expect(out).toMatch(/<ul>\n<li>x\n<ul>\n<li>y<\/li>/);
  });

  // Each hostile post is rendered in a child process with a timeout, so a renderer that backtracks is killed and the
  // test fails, rather than freezing the suite. The child measures CPU time (best of three), as the edit-size tests do.
  it.each(Object.keys(CASES))(
    'renders 500,000 characters of %s in under 200 ms',
    (name) => {
      const run = spawnSync(
        process.execPath,
        [join(import.meta.dirname, 'fixtures', 'markdown-cpu.ts'), name],
        { encoding: 'utf8', timeout: 40_000 },
      );
      expect(run.error, `${name}: ${run.error?.message}`).toBeUndefined();
      expect(run.status, `${name}: ${run.stderr.slice(-300)}`).toBe(0);
      const out = JSON.parse(run.stdout) as { ms: number; length: number };
      expect(out.length).toBeGreaterThan(0);
      expect(out.ms).toBeLessThan(200);
    },
    60_000,
  );
  it('reads code spans by CommonMark’s rule: a span closes at the next run of the same length', () => {
    expect(markdown('a `x` b ``y ` z`` c ```k``` d')).toBe(
      '<p>a <code>x</code> b <code>y ` z</code> c <code>k</code> d</p>',
    );
    expect(markdown('`one` and ``two`` and `` `three` ``')).toContain('<code>`three`</code>');
    // Runs of different lengths do not close each other, and an unmatched run is text.
    expect(markdown('``a` b')).toBe('<p>``a` b</p>');
    expect(markdown('x ```a`` b')).toBe('<p>x ```a`` b</p>');
    // What is inside a span is literal.
    expect(markdown('`*a* <b>`')).toBe('<p><code>*a* &lt;b&gt;</code></p>');
  });
});

describe('writing a post', () => {
  it('draws the page from the journal template and its stylesheet', async () => {
    const res = await post(journal, {
      title: 'The Tide Keepers',
      body_md: '# First\n\nIvar reads the water *every* morning.\n\nA second paragraph.',
      date: '2026-11-01',
      summary: 'On reading the tide by hand.',
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { slug: string; path: string; lint: { ok: boolean } };
    expect(out).toMatchObject({
      slug: 'the-tide-keepers',
      path: 'blog/the-tide-keepers/index.html',
      draft: false,
    });
    const html = await read(journal, 'blog/the-tide-keepers/index.html');
    expect(html).toContain('<link rel="stylesheet" href="../../styles.css">');
    expect(html).toContain('class="story__head"');
    expect(html).toContain(
      '<p class="byline">By Jane Doe, with Hildegard · <time datetime="2026-11-01">1 November 2026</time>',
    );
    expect(html).toContain('<h2>First</h2>');
    expect(html).not.toContain('class="hg-post"');
    expect(html).not.toContain('noindex');
    expect(html).toContain('<a class="mast__name" href="../../">Low Water</a>');
  });

  it('gives a site with no look of its own a clean layout built from its tokens', async () => {
    await post(blank, { title: 'Hello', body_md: 'Plain words.', date: '2026-11-02' });
    const html = await read(blank, 'blog/hello/index.html');
    expect(html).toContain('<link rel="stylesheet" href="../../styles.css">');
    expect(html).toContain('<body class="hg-post">');
    expect(html).toContain('var(--ground,');
    expect(html).toContain('var(--accent,');
  });

  it('uses the stylesheets the site’s own front page links, wherever they are', async () => {
    const res = await h.local('/api/sites', 'POST', { from: 'empty', title: 'Nested Look' });
    const site = ((await res.json()) as { id: string }).id;
    const files = join(h.dir, 'sites', site, 'files');
    await h.local(`/api/sites/${site}/files/styles.css`, 'DELETE');
    mkdirSync(join(files, 'assets', 'css'), { recursive: true });
    writeFileSync(join(files, 'assets', 'theme.css'), ':root{--ground:#fff}');
    writeFileSync(join(files, 'assets', 'css', 'extra.css'), '.x{color:red}');
    writeFileSync(
      join(files, 'index.html'),
      `<!doctype html><html><head><title>Nested</title>
<link rel="preconnect" href="https://fonts.example">
<link href="https://fonts.example/x.css" rel="stylesheet">
<link rel="stylesheet" href="assets/theme.css?v=3">
<link href='./assets/css/extra.css' rel=stylesheet>
<link rel="stylesheet" href="../../outside.css">
<link rel="stylesheet" href="missing.css">
</head><body>Hi</body></html>`,
    );
    expect((await post(site, { title: 'Deep', body_md: 'Words.', date: '2026-11-04' })).status).toBe(201);
    const html = await read(site, 'blog/deep/index.html');
    expect(html).toContain('<link rel="stylesheet" href="../../assets/theme.css">');
    expect(html).toContain('<link rel="stylesheet" href="../../assets/css/extra.css">');
    expect(html.indexOf('theme.css')).toBeLessThan(html.indexOf('extra.css'));
    for (const never of ['fonts.example', 'outside.css', 'missing.css'])
      expect(html, never).not.toContain(never);
    expect(await read(site, 'blog/index.html')).toContain(
      '<link rel="stylesheet" href="../assets/theme.css">',
    );
    // A site with no stylesheet to link still gets a page.
    writeFileSync(join(files, 'index.html'), '<!doctype html><title>Bare</title><p>Hi');
    await post(site, { title: 'Bare', body_md: 'Words.', date: '2026-11-04' });
    expect(await read(site, 'blog/bare/index.html')).not.toContain('rel="stylesheet"');
  });

  it('keeps the list, the feed and the sitemap newest first', async () => {
    await post(journal, { title: 'Newest', body_md: 'Last.', date: '2026-11-05', summary: 'Fish & <chips>' });
    await post(journal, { title: 'Middle', body_md: 'Middle.', date: '2026-11-03' });
    const index = await read(journal, 'blog/index.html');
    const order = [...index.matchAll(/<h2><a href="([a-z-]+)\/">/g)].map((m) => m[1]);
    expect(order).toEqual(['newest', 'middle', 'the-tide-keepers']);
    const feed = await read(journal, 'feed.xml');
    expect(slugsIn(feed.replace(/<atom:link[^>]*>/, '')).filter((_, i) => i % 2 === 0)).toEqual([
      'newest',
      'middle',
      'the-tide-keepers',
    ]);
    expect(feed).toMatch(/<rss version="2.0"/);
    expect(feed).toContain('<pubDate>Thu, 05 Nov 2026 12:00:00 +0000</pubDate>');
    expect(feed).toContain('<description>Fish &amp; &lt;chips&gt;</description>');
    expect(feed).not.toContain('<chips>');
    expect(feed).toContain('<guid isPermaLink="false">blog/newest/</guid>');
    const map = await read(journal, 'sitemap.xml');
    expect(map).toContain('<loc>blog/newest/</loc><lastmod>2026-11-05</lastmod>');
    expect(map).toContain('<loc>blog/</loc>');
    expect(map).toContain('<loc></loc>');
    expect(map.indexOf('blog/newest/')).toBeLessThan(map.indexOf('blog/middle/'));
    expect(map.indexOf('blog/middle/')).toBeLessThan(map.indexOf('blog/the-tide-keepers/'));
  });

  it('uses absolute links once the site has a public address, and writes them again when it changes', async () => {
    const set = await h.local(`/api/sites/${journal}`, 'PATCH', { publicUrl: 'https://tides.example.com' });
    expect(set.status).toBe(200);
    expect(((await set.json()) as { publicUrl: string }).publicUrl).toBe('https://tides.example.com/');
    const feed = await read(journal, 'feed.xml');
    expect(feed).toContain('<guid isPermaLink="true">https://tides.example.com/blog/newest/</guid>');
    expect(feed).toContain('<atom:link href="https://tides.example.com/feed.xml" rel="self"');
    const map = await read(journal, 'sitemap.xml');
    expect(map).toContain('<loc>https://tides.example.com/blog/middle/</loc>');
    expect(map).toContain('<loc>https://tides.example.com/</loc>');
    // The pages themselves link relatively, so they move with the site.
    expect(await read(journal, 'blog/newest/index.html')).not.toContain('tides.example.com');
    for (const bad of [
      'javascript:alert(1)',
      'https://u:p@x.example/',
      'ftp://x.example',
      'not a url',
      'https://x.example/?q=1',
    ])
      expect((await h.local(`/api/sites/${journal}`, 'PATCH', { publicUrl: bad })).status, bad).toBe(422);
  });

  it('replaces a post with the same slug instead of listing it twice', async () => {
    await post(journal, { title: 'Middle', body_md: 'Rewritten.', date: '2026-11-03' });
    expect(siteJson(journal).posts.filter((p) => p.slug === 'middle')).toHaveLength(1);
    expect(await read(journal, 'blog/middle/index.html')).toContain('Rewritten.');
    expect((await read(journal, 'blog/index.html')).match(/href="middle\/"/g)).toHaveLength(1);
  });

  it('keeps a draft out of the list, the feed and the sitemap, and records it', async () => {
    const res = await post(journal, {
      title: 'Not Yet',
      body_md: 'Secret plans.',
      date: '2026-11-06',
      draft: true,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { draft: boolean }).draft).toBe(true);
    const page = await read(journal, 'blog/not-yet/index.html');
    expect(page).toContain('<meta name="robots" content="noindex">');
    expect(page).toContain('Secret plans.');
    for (const file of ['blog/index.html', 'feed.xml', 'sitemap.xml']) {
      const text = await read(journal, file);
      expect(text, file).not.toContain('not-yet');
      expect(text, file).not.toContain('Not Yet');
    }
    const meta = siteJson(journal);
    expect(meta.drafts.map((d) => d.slug)).toEqual(['not-yet']);
    expect(meta.posts.map((p) => p.slug)).not.toContain('not-yet');
    // Publishing the draft moves it into the lists and takes the noindex off.
    await post(journal, { title: 'Not Yet', body_md: 'Now ready.', date: '2026-11-06' });
    expect(siteJson(journal).drafts).toEqual([]);
    expect(await read(journal, 'blog/not-yet/index.html')).not.toContain('noindex');
    expect(await read(journal, 'feed.xml')).toContain('blog/not-yet/');
  });

  it('turns HTML in the body into text', async () => {
    await post(blank, {
      title: 'Careful',
      body_md:
        'Before <script>alert("x")</script> after\n\n<iframe src="https://evil.example"></iframe>\n\n[bad](javascript:alert(1))',
      date: '2026-11-04',
      summary: '<b>bold</b> claim',
    });
    const page = await read(blank, 'blog/careful/index.html');
    expect(page).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(page).toContain('&lt;iframe src=&quot;https://evil.example&quot;&gt;&lt;/iframe&gt;');
    expect(page).not.toMatch(/<script|<iframe|href="javascript/);
    expect(page).toContain('&lt;b&gt;bold&lt;/b&gt; claim');
    // The title and byline can't carry markup either.
    await post(blank, {
      title: 'A <u>title</u>',
      byline: 'By <i>me</i>',
      body_md: 'x',
      date: '2026-11-04',
      slug: 'tags',
    });
    const tags = await read(blank, 'blog/tags/index.html');
    expect(tags).not.toMatch(/<u>|<i>/);
    expect(tags).toContain('A &lt;u&gt;title&lt;/u&gt;');
  });

  it('keeps the interview or notes private in notes/<slug>.md', async () => {
    await post(blank, {
      title: 'Interviewed',
      body_md: 'The story.',
      date: '2026-11-04',
      notes_md: 'Q: Why?\nA: Because.',
    });
    expect(await read(blank, 'notes/interviewed.md')).toBe('Q: Why?\nA: Because.\n');
    for (const file of ['blog/index.html', 'feed.xml', 'sitemap.xml', 'blog/interviewed/index.html'])
      expect(await read(blank, file), file).not.toContain('Because');
    expect(await read(blank, 'sitemap.xml')).not.toContain('notes/');
  });

  it('refuses a bad slug, a bad date or a missing byline', async () => {
    for (const bad of [
      { slug: '../x' },
      { slug: 'A B' },
      { slug: '-x' },
      { date: '2026-02-30' },
      { date: 'yesterday' },
    ])
      expect((await post(blank, { title: 'T', body_md: 'x', ...bad })).status, JSON.stringify(bad)).toBe(422);
    expect((await h.local(`/api/sites/${blank}/posts`, 'POST', { title: 'T', body_md: 'x' })).status).toBe(
      422,
    );
    expect((await post('0123456789ab', { title: 'T', body_md: 'x' })).status).toBe(404);
  });

  it('reports the prose lint with the post', async () => {
    const res = await post(blank, {
      title: 'Stock',
      body_md: 'We will delve into the realm of it — and it is robust.',
      slug: 'stock',
    });
    const out = (await res.json()) as { lint: { ok: boolean; fails: string[] } };
    expect(out.lint.ok).toBe(false);
    expect(out.lint.fails).toContain('stock-words');
  });
});

describe('previewing a site that has notes and drafts', () => {
  it('shows a draft, as a preview is for, but never the interview notes', async () => {
    const made = await h.local('/api/sites', 'POST', { from: 'empty', title: 'Preview Notes' });
    const site = ((await made.json()) as { id: string }).id;
    await post(site, {
      title: 'Held',
      body_md: 'Draft words for the preview.',
      date: '2026-11-04',
      draft: true,
      notes_md: 'Q: Who said it?\nA: Private answer one.',
    });
    await post(site, {
      title: 'Out',
      body_md: 'Public words.',
      date: '2026-11-05',
      notes_md: 'Q: Why?\nA: Private answer two.',
    });
    const view = (await (await h.local(`/api/sites/${site}`)).json()) as { preview: string };
    const get = (rel: string) => raw(h.srv.url, `${view.preview}${rel}`);
    const draft = await get('blog/held/');
    expect(draft.status).toBe(200);
    expect(draft.body).toContain('Draft words for the preview.');
    expect((await get('blog/out/')).status).toBe(200);
    expect((await get('')).status).toBe(200);
    for (const rel of [
      'notes/held.md',
      'notes/out.md',
      'NOTES/held.md',
      'Notes/out.md',
      'notes%2Fheld.md',
      'blog/%2e%2e/notes/held.md',
      'blog/out/%2e%2e/../notes/out.md',
      'notes/',
      'notes',
    ]) {
      const r = await get(rel);
      expect(r.status, rel).toBe(404);
      expect(r.body, rel).not.toContain('Private answer');
    }
  });
});

describe('who may post', () => {
  it('is the owner’s: a director can’t, over REST or over their agent', async () => {
    const ada = await h.director('Ada');
    const rest = await h.as(ada.cookie, `/api/sites/${blank}/posts`, 'POST', {
      title: 'T',
      body_md: 'x',
      byline: 'By Ada',
    });
    expect(rest.status).toBe(403);
    const agent = await h.mcpFor('Ada');
    const r = (await agent.callTool({
      name: 'site_post',
      arguments: { site_id: blank, title: 'T', body_md: 'x', byline: 'By Ada' },
    })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Only the owner');
    expect(siteJson(blank).posts.map((p) => p.slug)).not.toContain('t');
  });

  it('works for the owner’s agent, with the tool saying what happened', async () => {
    const agent = await h.mcpFor('Alex');
    const { tools } = await agent.listTools();
    const t = tools.find((x) => x.name === 'site_post')!;
    expect(t.annotations).toMatchObject({
      title: expect.any(String),
      readOnlyHint: false,
      destructiveHint: false,
    });
    const r = (await agent.callTool({
      name: 'site_post',
      arguments: {
        site_id: blank,
        title: 'From an agent',
        body_md: 'Words that are plain.',
        byline: 'By Alex, with Hildegard',
        draft: true,
      },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain('Saved the draft blog/from-an-agent/index.html');
    const pub = tools.find((x) => x.name === 'site_publish')!;
    expect(pub.annotations).toMatchObject({ readOnlyHint: false });
  });
});
