// SPDX-License-Identifier: AGPL-3.0-only
// Builds the human corpus for the prose lint bench: everyday writing by real people, from sources whose licenses allow
// copies. Every piece is written to corpus/human/<id>.md and recorded in corpus/human/manifest.json with its source
// URL, author, license, date, word count and the SHA-256 of the text as saved.
//
//   node packages/craft/bench/fetch-human.mjs            build the corpus (raw downloads cached under
//                                                        ~/.cache/hildegard-prose-corpus)
//   node packages/craft/bench/fetch-human.mjs --check    re-fetch and fail if any piece's hash changed
//
// Sources, all published before 2021 so no model wrote them:
//   18F blog (CC0 and US public domain, github.com/18F/18f.gsa.gov, pinned commit)
//   Digital.gov news (US public domain and CC0, github.com/GSA/digitalgov.gov, pinned commit)
//   NASA blog and feature posts (US government work, generally not copyrighted)
//   Creative Commons blog (CC BY 4.0)
//   Global Voices (CC BY 3.0)
//   Stack Exchange answers (CC BY-SA 3.0 and 4.0): practical writing on gardening, cooking, repairs, music and more
//   Project Gutenberg, public domain in the US: Moody and Spurgeon sermons, letters of a woman homesteader and of a
//   Chicago packer to his son. Gutenberg's ASCII "--" is set back to the em dash it stands for.
// Pieces are cut at a paragraph break to between 90 and 699 words, a length fixed by the URL (excerpt: true). Which pieces are picked is a fixed function of
// the URL, so the same sources give the same corpus. `split` is likewise fixed: about 40 percent of pieces are `test`,
// kept out of every rule decision and read only as totals.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const here = import.meta.dirname;
const OUT = join(here, 'corpus/human');
const RAW = join(homedir(), '.cache/hildegard-prose-corpus/raw');
const check = process.argv.includes('--check');
const UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0 hildegard-prose-bench';
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const words = (s) => s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
mkdirSync(RAW, { recursive: true });

async function get(url, headers = {}) {
  const f = join(RAW, sha1(url));
  if (existsSync(f)) return readFileSync(f, 'utf8');
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, redirect: 'follow' });
    if (r.ok) {
      const t = await r.text();
      writeFileSync(f, t);
      return t;
    }
    await new Promise((ok) => setTimeout(ok, 1500));
  }
  throw new Error(`could not fetch ${url}`);
}

const ENT = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};
const decode = (s) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);

/** The article HTML as plain Markdown: paragraphs, headings, lists, bold and quotes; links keep their text. */
function htmlToMd(html) {
  let h = html
    .replace(
      /<(script|style|figure|figcaption|iframe|svg|noscript|form|aside|table|pre)\b[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${'#'.repeat(Number(n))} ${t}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${t.trim()}`)
    .replace(
      /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
      (_, t) => `\n\n> ${t.replace(/<[^>]+>/g, ' ').trim()}\n\n`,
    )
    .replace(/<\/(p|div|ul|ol)>/gi, '\n\n')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<[^>]+>/g, '');
  h = decode(h);
  return h
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .split(/\n\n/)
    .filter((p) => !PAGE_FURNITURE.test(p))
    .join('\n\n')
    .trim();
}
/** Bylines, timestamps and "related article" links that the page's markup puts inside the article body. */
const PAGE_FURNITURE =
  /\b(?:Last Updated|min read|Article \d+ (?:days?|hours?|weeks?|months?) ago|Share this|Related Terms|Image Credit)\b|^\**By [A-Z][^.]{2,60}\**$|^Read more\b|^Posted (?:in|on)\b/i;

/** A cut length of 90 to 699 words that depends only on the key, so the corpus spans short and medium pieces like a brief's drafts do. */
const target = (key) => 90 + (parseInt(sha1(key).slice(0, 6), 16) % 610);

/** Cut at a paragraph break at or before `max` words. Returns null when even the first paragraph is longer. */
function cut(md, max) {
  const paras = md.split(/\n\n+/);
  const kept = [];
  let n = 0;
  for (const p of paras) {
    const w = words(p);
    if (n + w > max) break;
    kept.push(p);
    n += w;
  }
  return kept.length ? { text: kept.join('\n\n'), excerpt: kept.length < paras.length } : null;
}

const pieces = [];
const take = (src, cands, count) => {
  const picked = cands.sort((a, b) => sha1(a.url).localeCompare(sha1(b.url))).slice(0, count);
  for (const c of picked)
    pieces.push({ source: src.id, genre: src.genre, ...c, license: c.license ?? src.license });
  console.log(`${src.id}: ${picked.length} of ${cands.length} candidates`);
};
const wanted = (md, min = 90) => {
  const w = words(md);
  const paragraphs = md.split(/\n\n+/).filter((p) => !/^(#|- |>)/.test(p));
  return w >= min && w <= 2500 && paragraphs.filter((p) => words(p) >= 10).length >= 2;
};
const front = (raw) => {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const l of m[1].split('\n')) {
    const k = l.match(/^(\w+):\s*(.*)$/);
    if (k) meta[k[1]] = k[2].replace(/^['"]|['"]$/g, '');
  }
  const authors = [...m[1].matchAll(/^\s*-\s*(.+)$/gm)].map((a) => a[1].replace(/^['"]|['"]$/g, ''));
  return { meta, authors, body: m[2] };
};
const stripMd = (b) =>
  b
    .replace(/\{\{<[\s\S]*?>\}\}|\{\{%[\s\S]*?%\}\}|\{%[\s\S]*?%\}|\{\{[\s\S]*?\}\}/g, '')
    .replace(/<(script|style|figure|iframe)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/<\/?(span|div|p|br|em|strong|a)\b[^>]*>/gi, '')
    .replace(/^\[\^?[^\]]+\]:.*$/gm, '')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

// GitHub repositories of Markdown posts: a pinned commit, a path pattern.
async function github(src, repo, commit, pathRe, count, authorsFmt) {
  const tree = JSON.parse(await get(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`));
  const files = tree.tree.map((t) => t.path).filter((p) => pathRe.test(p));
  const cands = [];
  for (const p of files.sort((a, b) => sha1(a).localeCompare(sha1(b))).slice(0, 160)) {
    const url = `https://raw.githubusercontent.com/${repo}/${commit}/${p}`;
    const { meta, authors, body } = front(await get(url));
    const date = (meta.date ?? '').slice(0, 10);
    if (!/^20(1[4-9]|20)/.test(date)) continue;
    const md = stripMd(body);
    const c = cut(md, target(p));
    if (!c || !wanted(c.text)) continue;
    cands.push({
      url: `https://github.com/${repo}/blob/${commit}/${p}`,
      title: meta.title ?? p,
      author: authorsFmt(authors ?? []),
      date,
      ...c,
    });
  }
  take(src, cands, count);
}

// WordPress sites with the REST API on: posts from 2016 to 2020.
async function wordpress(src, base, count, pages = 3) {
  const cands = [];
  for (let page = 1; page <= pages; page++) {
    const url = `${base}/wp-json/wp/v2/posts?per_page=100&page=${page}&after=2016-01-01T00:00:00&before=2021-01-01T00:00:00&_embed=author`;
    for (const p of JSON.parse(await get(url))) {
      const md = htmlToMd(p.content.rendered);
      const c = cut(md, target(p.link));
      if (!c || !wanted(c.text)) continue;
      cands.push({
        url: p.link,
        title: decode(p.title.rendered),
        author: p._embedded?.author?.[0]?.name ?? src.author,
        date: p.date.slice(0, 10),
        ...c,
      });
    }
  }
  take(src, cands, count);
}

// Stack Exchange answers (CC BY-SA), 2014 to 2020, best-voted first: practical writing about mowers, baking, chickens,
// plumbing, pianos and the like, by people who answer for nothing.
async function stackexchange(src, sites, perSite) {
  const cands = [];
  for (const site of sites) {
    const url = `https://api.stackexchange.com/2.3/answers?order=desc&sort=votes&site=${site}&filter=withbody&fromdate=1388534400&todate=1609459200&pagesize=100`;
    const found = [];
    for (const a of JSON.parse(await get(url)).items) {
      const md = htmlToMd(a.body);
      const c = cut(md, target(`${site}/${a.answer_id}`));
      if (a.score < 5 || !c || !wanted(c.text) || words(md) > 1500) continue;
      found.push({
        url: `https://${site}.stackexchange.com/a/${a.answer_id}`,
        title: `Answer ${a.answer_id} on ${site}.stackexchange.com`,
        author: a.owner?.display_name ?? 'Stack Exchange contributor',
        date: new Date(a.creation_date * 1000).toISOString().slice(0, 10),
        license: `${a.content_license} (stackexchange.com)`,
        ...c,
      });
    }
    cands.push(...found.sort((a, b) => sha1(a.url).localeCompare(sha1(b.url))).slice(0, perSite));
  }
  take(src, cands, cands.length);
}

/** Paragraphs re-joined from Gutenberg's hard-wrapped lines; "--" is the em dash it stands for; _x_ is italics. */
const gutenberg = (raw) => {
  const start = raw.search(/\*\*\* START OF .*?\*\*\*/);
  const end = raw.search(/\*\*\* END OF .*?\*\*\*/);
  const body = raw
    .slice(start >= 0 ? raw.indexOf('\n', start) : 0, end >= 0 ? end : undefined)
    .replace(/\r/g, '');
  return body
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .replace(/\n\s*/g, ' ')
        .replace(/_/g, '')
        .replace(/\s*--\s*/g, '\u2014')
        .trim(),
    )
    .filter(Boolean);
};
async function book(src, id, headRe, count, { title, author, date }) {
  const paras = gutenberg(await get(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`));
  const cands = [];
  for (let i = 0; i < paras.length; i++) {
    if (!headRe.test(paras[i])) continue;
    const sect = [];
    for (let j = i + (src.skipHead ? 1 : 0); j < paras.length && sect.length < 40; j++) {
      if (j > i && headRe.test(paras[j])) break;
      sect.push(paras[j]);
    }
    const c = cut(sect.filter((p) => !/^[A-Z0-9 .,'’\u2014-]{3,}$/.test(p)).join('\n\n'), target(paras[i]));
    if (!c || words(c.text) < 90) continue;
    cands.push({
      url: `https://www.gutenberg.org/ebooks/${id}#${sha1(paras[i]).slice(0, 8)}`,
      title: `${title}: ${paras[i].slice(0, 50)}`,
      author,
      date,
      ...c,
    });
  }
  take(src, cands, count);
}

await github(
  { id: '18f', genre: 'blog', license: 'CC0 1.0 and US public domain (18F, a US government project)' },
  '18F/18f.gsa.gov',
  '292605ab095af8e70e2087aca63c2319ce892a4c',
  /^content\/posts\/.*\.md$/,
  22,
  (a) => `18F staff (${a.join(', ') || 'unsigned'})`,
);
await github(
  { id: 'digitalgov', genre: 'newsletter', license: 'CC0 1.0 and US public domain (GSA)' },
  'GSA/digitalgov.gov',
  '4979583206d90ff1707b097454a9b169ca9e95e4',
  /^content\/news\/201[4-9]\/.*\.md$/,
  12,
  (a) => `Digital.gov staff (${a.join(', ') || 'unsigned'})`,
);
await wordpress(
  {
    id: 'nasa',
    genre: 'blog',
    license: 'US government work, generally not copyrighted (nasa.gov/nasa-brand-center/images-and-media)',
    author: 'NASA staff',
  },
  'https://www.nasa.gov',
  10,
  2,
);
await wordpress(
  {
    id: 'creativecommons',
    genre: 'announcement',
    license: 'CC BY 4.0 (creativecommons.org)',
    author: 'Creative Commons staff',
  },
  'https://creativecommons.org',
  8,
  2,
);
await wordpress(
  {
    id: 'globalvoices',
    genre: 'article',
    license: 'CC BY 3.0 (globalvoices.org)',
    author: 'Global Voices contributor',
  },
  'https://globalvoices.org',
  8,
  1,
);
await stackexchange(
  { id: 'stackexchange', genre: 'answer', license: 'CC BY-SA' },
  [
    'gardening',
    'cooking',
    'diy',
    'mechanics',
    'outdoors',
    'music',
    'pets',
    'parenting',
    'christianity',
    'woodworking',
    'money',
  ],
  3,
);
const PD = 'Public domain in the US (Project Gutenberg)';
await book(
  { id: 'gutenberg-homesteader', genre: 'email', license: PD },
  16623,
  /^(MY )?DEAR [A-Z.' ]+,\u2014$/,
  8,
  {
    title: 'Letters of a Woman Homesteader',
    author: 'Elinore Pruitt Stewart',
    date: '1914',
  },
);
await book(
  { id: 'gutenberg-merchant', genre: 'email', license: PD },
  21959,
  /^(?:Dear|My dear|DEAR|MY DEAR) [A-Za-z]+:/,
  6,
  {
    title: 'Letters from a Self-Made Merchant to His Son',
    author: 'George Horace Lorimer',
    date: '1902',
  },
);
await book(
  { id: 'gutenberg-moody', genre: 'sermon', license: PD, skipHead: true },
  33015,
  /^[A-Z][A-Z '’,.-]{6,}\.$/,
  6,
  {
    title: 'The Overcoming Life, and Other Sermons',
    author: 'Dwight Lyman Moody',
    date: '1896',
  },
);
await book(
  { id: 'gutenberg-spurgeon', genre: 'sermon', license: PD, skipHead: true },
  42657,
  /^The [A-Z][^.]{3,60}\.$|^[A-Z][A-Za-z '’-]{3,40}\.$/,
  8,
  {
    title: 'Gleanings among the Sheaves',
    author: 'Charles Haddon Spurgeon',
    date: '1869',
  },
);

mkdirSync(OUT, { recursive: true });
const manifest = [];
const counts = {};
for (const p of pieces) {
  counts[p.source] = (counts[p.source] ?? 0) + 1;
  const id = `${p.source}-${String(counts[p.source]).padStart(2, '0')}`;
  const text = `# ${p.title.replace(/\s+/g, ' ').trim()}\n\n${p.text}\n`;
  manifest.push({
    id,
    genre: p.genre,
    split: parseInt(sha1(id)[0], 16) < 6 ? 'test' : 'dev',
    title: p.title,
    author: p.author,
    date: p.date,
    url: p.url,
    license: p.license,
    words: words(text),
    excerpt: p.excerpt,
    sha256: sha256(text),
  });
  if (!check) writeFileSync(join(OUT, `${id}.md`), text);
  else if (sha256(readFileSync(join(OUT, `${id}.md`), 'utf8')) !== sha256(text))
    throw new Error(`${id} changed`);
}
if (!check) writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `${manifest.length} pieces, ${manifest.reduce((a, m) => a + m.words, 0)} words${check ? ', hashes match' : ''}`,
);
