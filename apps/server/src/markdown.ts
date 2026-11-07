// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A small Markdown renderer for posts, safe by construction: every character of the input is escaped before anything
 * is built from it, raw HTML is text, and a link or picture only keeps an address that is http, https, mailto or
 * relative. It reads headings, paragraphs, emphasis, strong, code (inline and fenced), links, pictures, quotes, lists
 * (nested by indent), rules and line breaks, which is what a blog post needs, and nothing else.
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

/** Inline Markdown in one block of text. */
export function inline(text: string): string {
  const slots: string[] = [];
  const hold = (html: string) => `\uE000${slots.push(html) - 1}\uE000`;
  // Code spans first: what is in them is literal.
  let s = text
    .replace(/[\uE000\uE001]/g, '')
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _t: string, code: string) =>
      hold(`<code>${escapeHtml(code.trim())}</code>`),
    );
  // Pictures and links: the label and the address are read from the raw text, then each is escaped on its own.
  const link = /(!?)\[([^\]\n]*)\]\(\s*([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"([^"\n]*)")?\s*\)/g;
  s = s.replace(link, (_m, bang: string, label: string, url: string, title: string | undefined) => {
    const href = safeUrl(url, !bang);
    if (!href) return hold(escapeHtml(label));
    const t = title ? ` title="${escapeHtml(title)}"` : '';
    if (bang) return hold(`<img src="${href}" alt="${escapeHtml(label)}"${t} loading="lazy">`);
    // The label can hold emphasis, so it is escaped and formatted like any text, then held.
    return hold(`<a href="${href}"${t}>${emphasis(escapeHtml(label))}</a>`);
  });
  s = emphasis(escapeHtml(s));
  // Two spaces or a backslash at the end of a line is a line break.
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');
  // A held piece can hold another (a code span in a link's label).
  for (let n = 0; n < 3 && HELD.test(s); n++) s = s.replace(SLOT, (_m, k: string) => slots[Number(k)] ?? '');
  return s;
}

/** Strong and emphasis over text that is already escaped. */
function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^*\w])\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?!\w)/g, '$1<em>$2</em>');
}

interface Item {
  ordered: boolean;
  indent: number;
  text: string[];
  children: Item[];
}

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w-]*)\s*$/;

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
export function markdown(src: string, opts: { shift?: number } = {}): string {
  const shift = opts.shift ?? 1;
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
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const code: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${mark[0]}{${mark.length},}\\s*$`).test(lines[i]!))
        code.push(lines[i++]!);
      i++;
      const lang = fence[2] && /^[\w-]+$/.test(fence[2]) ? ` class="language-${escapeHtml(fence[2])}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (h) {
      const level = Math.min(6, h[1]!.length + shift);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr class="break">');
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!))
        quote.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>\n${markdown(quote.join('\n'), { shift })}\n</blockquote>`);
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
    const para: string[] = [];
    while (
      i < lines.length &&
      !blank(lines[i]) &&
      !FENCE.test(lines[i]!) &&
      !/^\s{0,3}(#{1,6})\s/.test(lines[i]!) &&
      !/^\s{0,3}>/.test(lines[i]!) &&
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
