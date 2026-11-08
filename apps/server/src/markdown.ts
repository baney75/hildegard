// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A small Markdown renderer for posts, safe by construction: every character of the input is escaped before anything
 * is built from it, raw HTML is text, and a link or picture only keeps an address that is http, https, mailto or
 * relative. It reads headings, paragraphs, emphasis, strong, code (inline and fenced), links, pictures, quotes, lists
 * (nested by indent), rules and line breaks, which is what a blog post needs, and nothing else.
 *
 * A post is the writer's, or an agent's, so the work is bounded by its length: every inline pattern is read in one
 * pass over the text (a closer is found from a table built right to left), never by a regular expression that can
 * backtrack over a long run of one marker, and quotes nest only so deep.
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** An address that is safe to put in an href or src, already escaped; null when it isn't. */
function safeUrl(raw: string, allowMail: boolean): string | null {
  const url = raw.trim();
  if (
    !url ||
    /[\s"<>`\\]/.test(url) ||
    [...url].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  )
    return null;
  if (/^https?:\/\/[^/?#]+/i.test(url)) return escapeHtml(url);
  if (allowMail && /^mailto:[^\s@]+@[^\s@]+$/i.test(url)) return escapeHtml(url);
  // Relative or a fragment: no scheme (a colon before any slash), and not protocol-relative.
  if (url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return escapeHtml(url);
}

const SLOT = /\uE000(\d+)\uE000/g;
const HELD = /\uE000\d+\uE000/;

const BACKTICK = 96;
const isSpace = (c: number) =>
  c === 32 ||
  (c >= 9 && c <= 13) ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff;
const isWord = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/** For every index, the first index at or after it holding a character `is` accepts, or -1; one pass right to left. */
function nextAt(s: string, is: (c: number) => boolean): Int32Array {
  const next = new Int32Array(s.length + 1);
  next[s.length] = -1;
  for (let i = s.length - 1; i >= 0; i--) next[i] = is(s.charCodeAt(i)) ? i : next[i + 1]!;
  return next;
}

/**
 * Code spans, by CommonMark's rule: a run of backticks opens a span that closes at the next run of the same length,
 * and a run with no partner is text. The runs are listed once, then each is paired with the next of its length.
 */
function codeSpans(text: string, hold: (html: string) => string): string {
  if (!text.includes('`')) return text;
  const starts: number[] = [];
  const lens: number[] = [];
  for (let i = 0; i < text.length; ) {
    if (text.charCodeAt(i) !== BACKTICK) {
      i++;
      continue;
    }
    let j = i + 1;
    while (text.charCodeAt(j) === BACKTICK) j++;
    starts.push(i);
    lens.push(j - i);
    i = j;
  }
  const partner = new Int32Array(starts.length);
  const last = new Map<number, number>();
  for (let r = starts.length - 1; r >= 0; r--) {
    partner[r] = last.get(lens[r]!) ?? -1;
    last.set(lens[r]!, r);
  }
  const out: string[] = [];
  let at = 0;
  for (let r = 0; r < starts.length; r++) {
    const close = partner[r]!;
    if (close < 0) continue;
    const code = text.slice(starts[r]! + lens[r]!, starts[close]);
    out.push(text.slice(at, starts[r]), hold(`<code>${escapeHtml(code.trim())}</code>`));
    at = starts[close]! + lens[close]!;
    r = close;
  }
  out.push(text.slice(at));
  return out.join('');
}

/**
 * Pictures and links: `[label](address "title")`, with the label and the address read from the raw text. The label
 * ends at the first `]`, so a `]` whose `(address)` fails to read is remembered and not read again for the next `[`.
 */
function links(text: string, hold: (html: string) => string): string {
  if (!text.includes('](')) return text;
  const n = text.length;
  const close = nextAt(text, (c) => c === 93);
  const newline = nextAt(text, (c) => c === 10);
  const quote = nextAt(text, (c) => c === 34 || c === 10);
  const skip = (from: number) => {
    let k = from;
    while (k < n && isSpace(text.charCodeAt(k))) k++;
    return k;
  };
  /** Up to the next parenthesis or space. */
  const run = (from: number) => {
    let k = from;
    for (; k < n; k++) {
      const c = text.charCodeAt(k);
      if (c === 40 || c === 41 || isSpace(c)) break;
    }
    return k;
  };
  let failed = -1;
  /** The link whose `[` is at `open`, or null. */
  const read = (open: number) => {
    const end = close[open + 1]!;
    const lineEnd = newline[open + 1]!;
    if (end < 0 || (lineEnd >= 0 && lineEnd < end) || text[end + 1] !== '(' || end === failed) return null;
    const from = skip(end + 2);
    // The address: runs without parentheses, and at most one level of balanced (parentheses) between them.
    let k = run(from);
    let ok = true;
    while (text[k] === '(') {
      const inner = run(k + 1);
      if (text[inner] !== ')') {
        ok = false;
        break;
      }
      k = run(inner + 1);
    }
    if (ok) {
      const url = text.slice(from, k);
      const gap = skip(k);
      if (gap > k && text[gap] === '"') {
        const q = quote[gap + 1]!;
        if (q >= 0 && text[q] === '"') {
          const after = skip(q + 1);
          if (text[after] === ')')
            return { label: text.slice(open + 1, end), url, title: text.slice(gap + 1, q), end: after + 1 };
        }
      }
      if (text[gap] === ')') return { label: text.slice(open + 1, end), url, title: undefined, end: gap + 1 };
    }
    failed = end;
    return null;
  };
  const out: string[] = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    const bang = c === 33 && text[i + 1] === '[';
    if (c !== 91 && !bang) continue;
    const found = read(bang ? i + 1 : i);
    if (!found) continue;
    const href = safeUrl(found.url, !bang);
    out.push(text.slice(at, i));
    if (!href) out.push(hold(escapeHtml(found.label)));
    else {
      const t = found.title ? ` title="${escapeHtml(found.title)}"` : '';
      if (bang) out.push(hold(`<img src="${href}" alt="${escapeHtml(found.label)}"${t} loading="lazy">`));
      // The label can hold emphasis, so it is escaped and formatted like any text, then held.
      else out.push(hold(`<a href="${href}"${t}>${emphasis(escapeHtml(found.label))}</a>`));
    }
    at = found.end;
    i = found.end - 1;
  }
  out.push(text.slice(at));
  return out.join('');
}

/** Inline Markdown in one block of text. */
export function inline(text: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\uE000${slots.push(html) - 1}\uE000`;
  // Code spans first: what is in them is literal.
  let s = links(codeSpans(text.replace(/[\uE000\uE001]/g, ''), hold), hold);
  s = emphasis(escapeHtml(s));
  // Two spaces or a backslash at the end of a line is a line break. (The lookbehind keeps a long run of spaces from
  // being tried again from every space in it.)
  s = s.replace(/(?:(?<! ) {2,}|\\)\n/g, '<br>\n');
  // A held piece can hold another (a code span in a link's label).
  for (let n = 0; n < 3 && HELD.test(s); n++) s = s.replace(SLOT, (_m, k: string) => slots[Number(k)] ?? '');
  return s;
}

/**
 * Wraps each `mark … mark` pair in `tag`, over text that is already escaped. An opener is the mark at the start or after
 * a character `before` accepts, followed by a character `edge` accepts; its closer is the nearest mark after it that
 * `edge` accepts the character before, and `after` accepts the character after. The nearest closer for every position
 * is found in one pass, so no opener is ever matched by looking again through the text.
 */
function pairs(
  s: string,
  mark: string,
  tag: string,
  rule: { before?: (c: number) => boolean; edge: (c: number) => boolean; after?: (c: number) => boolean },
): string {
  if (!s.includes(mark)) return s;
  const n = s.length;
  const m = mark.length;
  const nearest = new Int32Array(n + 2).fill(-1);
  for (let k = n - 1; k > 0; k--) {
    const closes =
      s.startsWith(mark, k) &&
      rule.edge(s.charCodeAt(k - 1)) &&
      (k + m >= n || !rule.after || rule.after(s.charCodeAt(k + m)));
    nearest[k] = closes ? k : nearest[k + 1]!;
  }
  const out: string[] = [];
  let at = 0;
  for (let i = s.indexOf(mark); i >= 0; i = s.indexOf(mark, i + 1)) {
    const opens =
      i + m < n &&
      rule.edge(s.charCodeAt(i + m)) &&
      (!rule.before || i === 0 || (i - 1 >= at && rule.before(s.charCodeAt(i - 1))));
    if (!opens) continue;
    const k = nearest[i + m + 1]!;
    if (k < 0) break;
    out.push(s.slice(at, i), `<${tag}>`, s.slice(i + m, k), `</${tag}>`);
    at = k + m;
    i = at - 1;
  }
  if (!at) return s;
  out.push(s.slice(at));
  return out.join('');
}

/** Strong and emphasis over text that is already escaped. */
function emphasis(s: string): string {
  const solid = (c: number) => !isSpace(c);
  const nonWord = (c: number) => !isWord(c);
  s = pairs(s, '**', 'strong', { edge: solid });
  s = pairs(s, '__', 'strong', { before: nonWord, edge: solid, after: nonWord });
  s = pairs(s, '*', 'em', {
    before: (c) => c !== 42 && !isWord(c),
    edge: (c) => !isSpace(c) && c !== 42,
    after: (c) => c !== 42,
  });
  return pairs(s, '_', 'em', {
    before: nonWord,
    edge: (c) => !isSpace(c) && c !== 95,
    after: nonWord,
  });
}

interface Item {
  ordered: boolean;
  indent: number;
  text: string[];
  children: Item[];
}

const QUOTE_DEPTH = 8;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
/** The marker and language of a line that opens or closes a fence: up to 3 spaces, 3 or more of ` or ~, one word. */
function fenceOf(line: string): { mark: string; lang: string } | null {
  let k = 0;
  while (k < 4 && isSpace(line.charCodeAt(k))) k++;
  if (k > 3 || (line[k] !== '`' && line[k] !== '~')) return null;
  let e = k;
  while (line[e] === line[k]) e++;
  // A run of 3 or more; the rest of the line is a language, or nothing (checked on the trimmed rest, not with `\s*`
  // on both sides of an optional word, which tries every split of a long run of spaces).
  const lang = line.slice(e).trim();
  return e - k >= 3 && /^[\w-]*$/.test(lang) ? { mark: line.slice(k, e), lang } : null;
}

function renderList(items: Item[]): string {
  const out: string[] = [];
  let i = 0;
  while (i < items.length) {
    const ordered = items[i]!.ordered;
    const group: Item[] = [];
    while (i < items.length && items[i]!.ordered === ordered) group.push(items[i++]!);
    const tag = ordered ? 'ol' : 'ul';
    const lis = group.map(
      (it) =>
        `<li>${inline(it.text.join('\n'))}${it.children.length ? `\n${renderList(it.children)}` : ''}</li>`,
    );
    out.push(`<${tag}>\n${lis.join('\n')}\n</${tag}>`);
  }
  return out.join('\n');
}

/** The block-level pass. `shift` moves headings down (the post's title is the page's h1, so "#" is an h2). */
export function markdown(src: string, opts: { shift?: number; depth?: number } = {}): string {
  const shift = opts.shift ?? 1;
  // Quotes inside quotes are read this many deep; past that a ">" is text, so a post of nothing but ">" can't recurse.
  const depth = opts.depth ?? 0;
  const quoting = depth < QUOTE_DEPTH;
  const quoteStart = (l: string) => quoting && /^\s{0,3}>/.test(l);
  const lines = src
    .replace(/\r\n?/g, '\n')
    .replace(/[\uE000\uE001]/g, '')
    .split('\n');
  const out: string[] = [];
  let i = 0;
  const blank = (l: string | undefined) => l === undefined || !l.trim();
  while (i < lines.length) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const fence = fenceOf(line);
    if (fence) {
      const mark = fence.mark;
      const code: string[] = [];
      const closer = new RegExp(`^\\s{0,3}${mark[0]}{${mark.length},}\\s*$`);
      i++;
      while (i < lines.length && !closer.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      const lang = fence.lang ? ` class="language-${escapeHtml(fence.lang)}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+/.exec(line);
    if (h) {
      // The text, without the spaces after it and without a closing run of #s (one run, after a space).
      let text = line.slice(h[0].length).trimEnd();
      let k = text.length;
      while (text[k - 1] === '#') k--;
      if (k > 0 && k < text.length && isSpace(text.charCodeAt(k - 1))) text = text.slice(0, k).trimEnd();
      const level = Math.min(6, h[1]!.length + shift);
      out.push(`<h${level}>${inline(text)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr class="break">');
      i++;
      continue;
    }
    if (quoteStart(line)) {
      const quote: string[] = [];
      while (i < lines.length && quoteStart(lines[i]!)) quote.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>\n${markdown(quote.join('\n'), { shift, depth: depth + 1 })}\n</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      const root: Item[] = [];
      const chain: Item[] = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]!);
        if (m) {
          const indent = m[1]!.replace(/\t/g, '    ').length;
          const item: Item = { ordered: /\d/.test(m[2]!), indent, text: [m[3]!], children: [] };
          while (chain.length && chain.at(-1)!.indent >= indent) chain.pop();
          (chain.length ? chain.at(-1)!.children : root).push(item);
          chain.push(item);
        } else if (chain.length && !blank(lines[i]) && /^\s+\S/.test(lines[i]!))
          chain.at(-1)!.text.push(lines[i]!.trim());
        else break;
        i++;
      }
      out.push(renderList(root));
      continue;
    }
    // A paragraph runs to the next blank line or the start of another block.
    // The first line is always taken, so this branch advances whatever the line is.
    const para: string[] = [lines[i++]!];
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      !fenceOf(lines[i]!) &&
      !/^\s{0,3}(#{1,6})\s/.test(lines[i]!) &&
      !quoteStart(lines[i]!) &&
      !(para.length && LIST.test(lines[i]!)) &&
      !(para.length && /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(lines[i]!))
    )
      para.push(lines[i++]!);
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

/** The text of rendered HTML, for a summary when the writer gave none. */
export function plainText(html: string): string {
  return html
    .replace(/<(pre|code)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]!,
    )
    .replace(/\s+/g, ' ')
    .trim();
}
