// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Posts on a site: `blog/<slug>/index.html` drawn from the site's own look (its stylesheet and the journal template's
 * article structure), `blog/index.html` newest first, `feed.xml` (RSS 2.0) and `sitemap.xml`. A draft gets its page
 * with a noindex tag and is left out of the list, the feed and the sitemap; site.json records it as a draft. The
 * writer's notes or interview go to `notes/<slug>.md`, which the public address never serves.
 */
import { posix } from 'node:path';
import { escapeHtml as esc, markdown, plainText } from './markdown.ts';
import { type PostMeta, SiteError, type Sites } from './sites.ts';

export interface PostInput {
  title: string;
  body_md: string;
  byline: string;
  date?: string;
  slug?: string;
  summary?: string;
  draft?: boolean;
  notes_md?: string;
}

export interface PostResult {
  slug: string;
  draft: boolean;
  /** The page, inside the site. */
  path: string;
  date: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** A web address part from a title: lower-case letters, digits and hyphens. */
export function slugify(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'post';
}

function checkDate(v: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null;
  if (!d || d.toISOString().slice(0, 10) !== v)
    throw new SiteError(422, 'date', 'Give the date as YYYY-MM-DD, such as 2026-11-07.');
  return v;
}
const niceDate = (v: string) => {
  const [y, m, d] = v.split('-').map(Number);
  return `${d} ${MONTHS[m! - 1]} ${y}`;
};
const rfc822 = (v: string) => {
  const t = new Date(`${v}T12:00:00Z`);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[t.getUTCDay()]}, ${p(t.getUTCDate())} ${MONTHS[t.getUTCMonth()]!.slice(0, 3)} ${t.getUTCFullYear()} 12:00:00 +0000`;
};

const excerpt = (html: string) => {
  const t = plainText(html);
  if (t.length <= 200) return t;
  return `${t.slice(0, 200).replace(/\s+\S*$/, '')}…`;
};

/** Newest first: by date, then by when it was written here. */
const newest = (a: PostMeta, b: PostMeta) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at);

/**
 * The stylesheets the site's own front page links, as paths inside the site (in the order it links them, nested
 * ones such as assets/theme.css included), found by reading the page's `<link rel="stylesheet">` tags. An address
 * outside the site, a file that isn't there and a path that climbs out of the folder are left out.
 */
function linkedStyles(sites: Sites, id: string, have: Set<string>): string[] {
  let html: string;
  try {
    html = sites.read(id, 'index.html').toString('utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?[^"'>]*\bstylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
    const raw = (href?.[1] ?? href?.[2] ?? href?.[3] ?? '').trim();
    if (!raw || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue;
    let rel: string;
    try {
      rel = posix.normalize(decodeURIComponent(raw.replace(/[?#].*$/, '')).replace(/^\/+/, ''));
    } catch {
      continue;
    }
    if (rel === '..' || rel.startsWith('../') || !have.has(rel) || out.includes(rel)) continue;
    out.push(rel);
  }
  return out;
}

/** The site's own stylesheets, and whether one is the journal's (so its article classes are already styled). */
function look(sites: Sites, id: string): { css: string[]; journal: boolean } {
  const files = sites.files(id).filter((f) => /\.css$/i.test(f.path));
  let css = linkedStyles(sites, id, new Set(files.map((f) => f.path)));
  if (!css.length) {
    // No page to read, or none that links a stylesheet of its own: a stylesheet beside it, if there is one.
    const top = files.filter((f) => !f.path.includes('/'));
    const pick = top.find((f) => f.path === 'styles.css') ?? top[0];
    css = pick ? [pick.path] : [];
  }
  return {
    css,
    journal: css.some((p) => /\.story__head\b/.test(sites.read(id, p).toString('utf8'))),
  };
}

/** A path inside the site as a web address part: each segment encoded, the slashes kept. */
const href = (p: string) => p.split('/').map(encodeURIComponent).join('/');

/** What a page the site's stylesheet doesn't already dress gets: its tokens (--ground, --ink, --accent …) with fallbacks. */
const ARTICLE_CSS = `:root{color-scheme:light dark}
body.hg-post{--hg-ground:var(--ground,var(--bg,var(--background,Canvas)));--hg-ink:var(--ink,var(--fg,var(--foreground,CanvasText)));--hg-muted:var(--ink-muted,var(--muted,var(--text-muted,GrayText)));--hg-accent:var(--accent,var(--primary,LinkText));--hg-line:var(--line,var(--border,color-mix(in srgb,currentColor 20%,transparent)));--hg-font:var(--font-body,var(--body,Georgia,"Times New Roman",serif));--hg-display:var(--font-display,var(--display,var(--hg-font)));margin:0;background:var(--hg-ground);color:var(--hg-ink);font:1.125rem/1.7 var(--hg-font)}
.hg-post a{color:var(--hg-accent);text-underline-offset:.18em}
.hg-post .mast{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.25rem 1rem;max-width:64rem;margin-inline:auto;padding:1.25rem clamp(1.1rem,5vw,3rem);border-bottom:1px solid var(--hg-line)}
.hg-post .mast__name{font:700 1.4rem/1.2 var(--hg-display);color:var(--hg-ink);text-decoration:none;padding-block:.4rem}
.hg-post .mast__issue{margin:0;font-size:.95rem}
.hg-post .story{max-width:38rem;margin-inline:auto;padding:clamp(2.5rem,7vw,5rem) clamp(1.1rem,5vw,3rem) 4rem}
.hg-post .story__head{display:grid;gap:1rem;margin-bottom:2.5rem}
.hg-post h1{margin:0;font:700 clamp(2rem,1.4rem+3vw,3.6rem)/1.08 var(--hg-display);text-wrap:balance}
.hg-post h2,.hg-post h3,.hg-post h4{font-family:var(--hg-display);line-height:1.2;margin:2em 0 .5em}
.hg-post .standfirst{margin:0;font-size:1.3rem;line-height:1.45;color:var(--hg-muted);text-wrap:balance}
.hg-post .byline{margin:0;font-size:.95rem;color:var(--hg-muted)}
.hg-post .prose>*{margin:0 0 1.15em}
.hg-post .prose img{max-width:100%;height:auto}
.hg-post blockquote{margin-inline:0;padding-inline-start:1.1rem;border-inline-start:3px solid var(--hg-accent);color:var(--hg-muted)}
.hg-post pre{overflow-x:auto;padding:1rem;border:1px solid var(--hg-line);border-radius:6px;font-size:.9rem}
.hg-post hr.break{border:0;border-top:1px solid var(--hg-line);margin:2.5em 0}
.hg-post .foot{max-width:64rem;margin-inline:auto;padding:1.5rem clamp(1.1rem,5vw,3rem) 3rem;border-top:1px solid var(--hg-line);font-size:.95rem}
:focus-visible{outline:3px solid var(--hg-accent,currentColor);outline-offset:3px}`;

const LIST_CSS = `.hg-posts{list-style:none;margin:0;padding:0;display:grid;gap:1.75rem}
.hg-posts h2{margin:0;font-size:1.5rem;line-height:1.2}
.hg-posts p{margin:.35rem 0 0}
.hg-posts time{font-size:.9rem;opacity:.75}`;

interface Page {
  site: { title: string };
  /** From the page's folder to the site's front page, such as "../../". */
  up: string;
  css: string[];
  journal: boolean;
}

const head = (p: Page, title: string, description: string, extra = '') =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${p.css.map((c) => `<link rel="stylesheet" href="${esc(p.up + href(c))}">\n`).join('')}<link rel="alternate" type="application/rss+xml" title="${esc(p.site.title)}" href="${esc(`${p.up}feed.xml`)}">
${extra}</head>`;

const masthead = (p: Page) =>
  `<header class="mast">
  <a class="mast__name" href="${esc(p.up)}">${esc(p.site.title)}</a>
  <p class="mast__issue"><a href="${esc(`${p.up}blog/`)}">All posts</a></p>
</header>`;

function articleHtml(p: Page, post: PostMeta, bodyHtml: string, draft: boolean): string {
  // The page carries no absolute address: it moves with the site, and the feed and the sitemap hold the addresses.
  const extra = [
    draft ? '<meta name="robots" content="noindex">' : '',
    `<meta property="og:type" content="article">`,
    `<meta property="og:title" content="${esc(post.title)}">`,
    `<meta property="og:description" content="${esc(post.summary)}">`,
    p.journal ? '' : `<style>\n${ARTICLE_CSS}\n</style>`,
  ]
    .filter(Boolean)
    .join('\n');
  return `${head(p, `${post.title} · ${p.site.title}`, post.summary, `${extra}\n`)}
<body${p.journal ? '' : ' class="hg-post"'}>
${masthead(p)}

<main id="story">
  <article class="story">
    <header class="story__head">
      <h1>${esc(post.title)}</h1>
      ${post.summary ? `<p class="standfirst">${esc(post.summary)}</p>` : ''}
      <p class="byline">${esc(post.byline)} · <time datetime="${post.date}">${niceDate(post.date)}</time>${draft ? ' · Draft' : ''}</p>
    </header>

    <div class="prose">
${bodyHtml}
    </div>
  </article>
</main>

<footer class="foot">
  <p><a href="${esc(p.up)}">${esc(p.site.title)}</a> · <a href="${esc(`${p.up}blog/`)}">All posts</a> · <a href="${esc(`${p.up}feed.xml`)}">Feed</a></p>
</footer>
</body>
</html>
`;
}

function indexHtml(p: Page, posts: PostMeta[]): string {
  const extra = `<style>\n${p.journal ? '' : `${ARTICLE_CSS}\n`}${LIST_CSS}\n</style>\n`;
  const items = posts
    .map(
      (x) => `    <li>
      <h2><a href="${esc(`${x.slug}/`)}">${esc(x.title)}</a></h2>
      <p><time datetime="${x.date}">${niceDate(x.date)}</time> · ${esc(x.byline)}</p>${x.summary ? `\n      <p>${esc(x.summary)}</p>` : ''}
    </li>`,
    )
    .join('\n');
  return `${head(p, `Posts · ${p.site.title}`, `Everything written on ${p.site.title}, newest first.`, extra)}
<body${p.journal ? '' : ' class="hg-post"'}>
${masthead(p)}

<main id="story">
  <section class="story">
    <header class="story__head">
      <h1>Posts</h1>
    </header>
${posts.length ? `    <ol class="hg-posts">\n${items}\n    </ol>` : '    <p>Nothing here yet.</p>'}
  </section>
</main>

<footer class="foot">
  <p><a href="${esc(p.up)}">${esc(p.site.title)}</a> · <a href="${esc(`${p.up}feed.xml`)}">Feed</a></p>
</footer>
</body>
</html>
`;
}

function feedXml(title: string, base: string | null, posts: PostMeta[]): string {
  const at = (path: string) => (base ? `${base}${path}` : path);
  const items = posts
    .map(
      (x) => `    <item>
      <title>${esc(x.title)}</title>
      <link>${esc(at(`blog/${x.slug}/`))}</link>
      <guid isPermaLink="${base ? 'true' : 'false'}">${esc(at(`blog/${x.slug}/`))}</guid>
      <pubDate>${rfc822(x.date)}</pubDate>
      <dc:creator>${esc(x.byline)}</dc:creator>
      <description>${esc(x.summary)}</description>
    </item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${esc(title)}</title>
    <link>${esc(at('blog/'))}</link>
    <description>${esc(`Posts on ${title}, newest first.`)}</description>
    <language>en</language>${base ? `\n    <atom:link href="${esc(`${base}feed.xml`)}" rel="self" type="application/rss+xml"/>` : ''}${posts[0] ? `\n    <lastBuildDate>${rfc822(posts[0].date)}</lastBuildDate>` : ''}
${items}
  </channel>
</rss>
`;
}

/** The site's own pages (not the blog, notes or anything that asks to be skipped), as the sitemap names them. */
function pages(sites: Sites, id: string): string[] {
  return sites
    .files(id)
    .map((f) => f.path)
    .filter((p) => /\.html?$/i.test(p) && !/^(blog|notes)\//.test(p) && !/(^|\/)(404|403)\.html?$/i.test(p))
    .filter(
      (p) =>
        !/<meta[^>]+name=["']robots["'][^>]+noindex/i.test(sites.read(id, p).toString('utf8').slice(0, 4000)),
    )
    .map((p) => p.replace(/(^|\/)index\.html?$/i, '$1'))
    .sort();
}

function sitemapXml(sites: Sites, id: string, base: string | null, posts: PostMeta[]): string {
  const at = (path: string) => (base ? `${base}${path}` : path);
  const urls = [
    ...pages(sites, id).map((p) => ({ loc: at(p), date: null as string | null })),
    ...(posts.length ? [{ loc: at('blog/'), date: posts[0]!.date }] : []),
    ...posts.map((x) => ({ loc: at(`blog/${x.slug}/`), date: x.date })),
  ];
  return `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${esc(u.loc)}</loc>${u.date ? `<lastmod>${u.date}</lastmod>` : ''}</url>`).join('\n')}
</urlset>
`;
}

/** Writes the list, the feed and the sitemap again from what site.json records. Links are absolute when `base` is. */
export function rebuildBlog(sites: Sites, id: string, base: string | null) {
  const site = sites.get(id);
  const { css, journal } = look(sites, id);
  const posts = [...site.posts].sort(newest);
  if (posts.length || site.drafts.length)
    sites.write(id, 'blog/index.html', indexHtml({ site, up: '../', css, journal }, posts));
  sites.write(id, 'feed.xml', feedXml(site.title, base, posts));
  sites.write(id, 'sitemap.xml', sitemapXml(sites, id, base, posts));
}

/** Writes a post (or replaces the one with its slug) and the pages that list it. */
export function writePost(
  sites: Sites,
  id: string,
  input: PostInput,
  opts: { base: string | null; now?: () => Date },
): PostResult {
  const site = sites.get(id);
  const title = input.title.trim();
  const slug = (input.slug ?? slugify(title)).trim();
  if (!SLUG.test(slug))
    throw new SiteError(
      422,
      'slug',
      'A slug is lower-case letters, digits and hyphens, up to 60, such as “first-post”.',
    );
  const now = (opts.now ?? (() => new Date()))();
  const date = checkDate(input.date ?? now.toISOString().slice(0, 10));
  const body = markdown(input.body_md);
  const draft = input.draft === true;
  const post: PostMeta = {
    slug,
    title,
    date,
    summary: (input.summary?.trim() || excerpt(body)).slice(0, 600),
    byline: input.byline.trim(),
    at: now.toISOString(),
  };
  const { css, journal } = look(sites, id);
  const path = `blog/${slug}/index.html`;
  sites.write(id, path, articleHtml({ site, up: '../../', css, journal }, post, body, draft));
  if (input.notes_md?.trim()) sites.write(id, `notes/${slug}.md`, `${input.notes_md.trim()}\n`);
  const others = (l: PostMeta[]) => l.filter((x) => x.slug !== slug);
  const posts = draft ? others(site.posts) : [...others(site.posts), post];
  const drafts = draft ? [...others(site.drafts), post] : others(site.drafts);
  sites.setPosts(id, { posts, drafts });
  rebuildBlog(sites, id, opts.base);
  return { slug, draft, path, date };
}
