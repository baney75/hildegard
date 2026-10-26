// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Designs into code. A design tool's file (Figma's, pen.dev's .pen) is read into one small tree of boxes, text,
 * pictures and vectors with auto layout, and that tree is written out as a page of plain, semantic HTML and CSS: auto
 * layout becomes flexbox, named colours become CSS variables (light and dark when the design has both), and every
 * fixed width is allowed to shrink, so the page starts out working on a phone. What a design file can't say (how a
 * three-column row should stack, what a button does) is left for the loop: the import comes with an image of the
 * design, and every round is held to it.
 *
 * Everything read from a design file is text to escape or a number to clamp; nothing in it runs.
 */

export type Sizing = 'fixed' | 'fill' | 'hug';

export interface Paint {
  kind: 'solid' | 'linear' | 'radial' | 'image';
  /** CSS colour, or var(--name). */
  color?: string;
  /** Gradient stops: colour and position 0..1. */
  stops?: { color: string; at: number }[];
  /** Degrees, CSS convention (0 is up, 90 is right). */
  angle?: number;
  /** An image: its file in the site's assets, and how it fills the box. */
  src?: string;
  fit?: 'cover' | 'contain' | 'fill';
  opacity?: number;
}

export interface Shadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

export interface TextStyle {
  family?: string;
  size?: number;
  weight?: number;
  italic?: boolean;
  /** Line height as a multiple of the size. */
  lineHeight?: number;
  /** Letter spacing in pixels. */
  letterSpacing?: number;
  align?: 'left' | 'center' | 'right' | 'justify';
  transform?: 'uppercase' | 'lowercase' | 'capitalize';
  decoration?: 'underline' | 'line-through';
  color?: string;
}

export interface DNode {
  kind: 'box' | 'text' | 'image' | 'vector';
  name: string;
  /** Position relative to the parent, in pixels; used where the parent has no auto layout or the node is absolute. */
  x: number;
  y: number;
  w: number;
  h: number;
  wSize: Sizing;
  hSize: Sizing;
  /** Taken out of its parent's auto layout and placed by x and y. */
  absolute?: boolean;
  layout?: {
    dir: 'row' | 'column' | 'none';
    gap: number;
    padding: [number, number, number, number];
    justify: 'start' | 'center' | 'end' | 'between' | 'around';
    align: 'start' | 'center' | 'end' | 'stretch' | 'baseline';
    wrap?: boolean;
  };
  fills: Paint[];
  stroke?: { color: string; width: number | [number, number, number, number] };
  radius?: number | [number, number, number, number];
  shadows?: Shadow[];
  blur?: number;
  backdropBlur?: number;
  opacity?: number;
  rotation?: number;
  clip?: boolean;
  text?: { content: string; style: TextStyle; href?: string };
  /** A vector, as SVG markup (already sanitised by whoever read it) or an icon to fill in. */
  svg?: string;
  icon?: string;
  /** An image node's picture, in the site's assets, and its alt text. */
  src?: string;
  alt?: string;
  children: DNode[];
}

export interface DesignPage {
  name: string;
  root: DNode;
}

export interface Design {
  title: string;
  pages: DesignPage[];
  /** Named colours, as CSS variables: light (or the only) value, and dark where the design has one. */
  colors: { name: string; light: string; dark?: string }[];
  /** Fonts the design uses, for the report: they have to be self-hosted to load offline. */
  fonts: string[];
  /** What the import couldn't carry over, said plainly. */
  notes: string[];
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────────────────────

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const r2 = (n: number) => Math.round(n * 100) / 100;
const px = (n: number) => (n === 0 ? '0' : `${r2(n)}px`);
const clampN = (n: unknown, lo: number, hi: number, d = 0) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
export const num = clampN;

/** A CSS-safe slug: lower case letters, digits and hyphens, starting with a letter. */
export function slug(s: string, fallback = 'part'): string {
  const out = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(out) ? out : out ? `${fallback}-${out}` : fallback;
}

/** rgba from 0..1 channels, as the shortest CSS that says it. */
export function rgba(r: number, g: number, b: number, a = 1): string {
  const c = (v: number) => Math.round(clampN(v, 0, 1) * 255);
  const al = r2(clampN(a, 0, 1, 1));
  if (al >= 1) return `#${[c(r), c(g), c(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return `rgb(${c(r)} ${c(g)} ${c(b)} / ${al})`;
}

/** A colour a design file wrote (#rgb, #rrggbb, #rrggbbaa), checked; null if it isn't one. */
export function hexColor(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s.trim());
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

/** Keeps only plain vector drawing from SVG markup: no scripts, no links out, no event handlers, no foreign objects. */
export function cleanSvg(svg: string): string | null {
  const s = svg.replace(/<\?xml[^>]*>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/gi, '').trim();
  if (!/^<svg[\s>]/i.test(s)) return null;
  if (/<(script|foreignObject|iframe|object|embed|use|image|a|style|animate|set)\b/i.test(s)) return null;
  if (/\son[a-z]+\s*=|javascript:|href\s*=|url\(\s*['"]?(?!#)/i.test(s)) return null;
  return s.length > 200_000 ? null : s;
}

/** Says so when only some colours have a dark value: the dark theme would mix the two. */
export function darkNote(colors: Design['colors']): string | null {
  const dark = colors.filter((c) => c.dark).length;
  if (!dark || dark === colors.length) return null;
  const without = colors.filter((c) => !c.dark).map((c) => c.name);
  return `Only ${dark} of ${colors.length} colours have a dark value (none for ${without.slice(0, 8).join(', ')}). Give each one a dark value, or the dark theme mixes light text on light grounds.`;
}

// ── Writing the page ─────────────────────────────────────────────────────────────────────────────────────────────

const JUSTIFY = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  between: 'space-between',
  around: 'space-around',
};
const ALIGN = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
  baseline: 'baseline',
};

function paintCss(p: Paint): string | null {
  if (p.kind === 'solid' && p.color) return p.color;
  if ((p.kind === 'linear' || p.kind === 'radial') && p.stops?.length) {
    const stops = p.stops.map((s) => `${s.color} ${r2(s.at * 100)}%`).join(', ');
    return p.kind === 'linear'
      ? `linear-gradient(${r2(p.angle ?? 180)}deg, ${stops})`
      : `radial-gradient(circle, ${stops})`;
  }
  if (p.kind === 'image' && p.src) return `url("${p.src.replace(/["\\\n]/g, '')}")`;
  return null;
}

interface Emit {
  css: string[];
  used: Map<string, number>;
  headings: { h1: boolean };
  /** Inside a link or button, where only phrasing content belongs. */
  inLink: number;
  sizes: number[];
}

/** The text sizes in a page, largest first, so the biggest text becomes the h1 and the next sizes h2 and h3. */
function textSizes(n: DNode, out: number[] = []): number[] {
  if (n.kind === 'text' && n.text?.style.size) out.push(n.text.style.size);
  for (const c of n.children) textSizes(c, out);
  return out;
}

function tagFor(n: DNode, e: Emit, depth: number): string {
  const name = n.name.toLowerCase();
  if (n.kind === 'text') {
    if (n.text?.href) return 'a';
    const size = n.text?.style.size ?? 16;
    const ranked = [...new Set(e.sizes)].sort((a, b) => b - a);
    // A heading is short; a paragraph at a large size is still a paragraph.
    if ((n.text?.content.length ?? 0) > 90) return 'p';
    if (size >= 28 && size === ranked[0] && !e.headings.h1) {
      e.headings.h1 = true;
      return 'h1';
    }
    if (size >= 22 && ranked.indexOf(size) <= 1) return 'h2';
    if (size >= 20 && ranked.indexOf(size) <= 2) return 'h3';
    return 'p';
  }
  if (n.kind === 'image') return 'img';
  if (n.kind === 'vector') return 'div';
  if (depth === 1 && /\b(nav|navigation|menu)\b/.test(name)) return 'nav';
  if (depth === 1 && /\b(header|top ?bar)\b/.test(name)) return 'header';
  if (depth === 1 && /\bfooter\b/.test(name)) return 'footer';
  if (/\b(button|btn|cta)\b/.test(name)) return 'a';
  if (depth === 1) return 'section';
  return 'div';
}

function classFor(n: DNode, e: Emit): string {
  const base = slug(n.name, n.kind);
  const k = (e.used.get(base) ?? 0) + 1;
  e.used.set(base, k);
  return k === 1 ? base : `${base}-${k}`;
}

function nodeCss(n: DNode, parent: DNode | null, depth: number): string[] {
  const d: string[] = [];
  const flex = parent?.layout && parent.layout.dir !== 'none' && !n.absolute;
  const row = parent?.layout?.dir === 'row';
  // Size. A fixed size is a most, never a must: it gives way on a narrow screen.
  if (depth === 0) {
    d.push('width:100%', 'min-height:100vh');
  } else if (n.absolute || !parent?.layout || parent.layout.dir === 'none') {
    d.push('position:absolute', `left:${px(n.x)}`, `top:${px(n.y)}`, `width:${px(n.w)}`);
    if (n.kind !== 'text') d.push(`height:${px(n.h)}`);
  } else {
    // Filling a row that wraps, each keeps most of its designed width, so on a phone they stack, not squeeze.
    if (n.wSize === 'fill')
      d.push(
        row
          ? `flex:1 1 ${n.w > 0 ? px(Math.min(n.w, Math.max(200, n.w * 0.6))) : n.kind === 'text' ? '0' : '200px'}`
          : 'align-self:stretch',
        'min-width:0',
        ...(row || n.kind !== 'image' ? [] : ['width:100%']),
      );
    else if (n.wSize === 'fixed' && n.kind !== 'text') d.push(`width:${px(n.w)}`, 'max-width:100%');
    else if (n.wSize === 'fixed') d.push(`max-width:${px(n.w)}`, row ? `flex:0 1 ${px(n.w)}` : 'width:100%');
    if (n.hSize === 'fill') d.push(row ? 'align-self:stretch' : 'flex:1 1 0');
    else if (n.hSize === 'fixed' && n.kind !== 'text' && !(n.layout && n.layout.dir !== 'none'))
      d.push(`height:${px(n.h)}`);
    else if (n.hSize === 'fixed' && n.kind !== 'text') d.push(`min-height:${px(n.h)}`);
    if (row && n.wSize !== 'fill') d.push('flex-shrink:1');
  }
  // Layout.
  const l = n.layout;
  if (l && n.kind === 'box') {
    if (l.dir !== 'none') {
      d.push('display:flex', `flex-direction:${l.dir}`);
      if (l.wrap || (l.dir === 'row' && n.children.length > 1)) d.push('flex-wrap:wrap');
      if (l.gap) d.push(`gap:${px(l.gap)}`);
      if (l.justify !== 'start') d.push(`justify-content:${JUSTIFY[l.justify]}`);
      d.push(`align-items:${ALIGN[l.align]}`);
    }
    const [t, r, b, lft] = l.padding;
    if (t || r || b || lft) d.push(`padding:${[t, r, b, lft].map(px).join(' ')}`);
    if (depth === 0 && l.dir !== 'none') d.push('box-sizing:border-box');
  }
  // Paint.
  const paints = n.fills.map((p) => ({ p, css: paintCss(p) })).filter((x) => x.css);
  if (n.kind === 'text') {
    const s = n.text!.style;
    const color = s.color ?? paints.find((x) => x.p.kind === 'solid')?.css;
    if (color) d.push(`color:${color}`);
    if (s.family) d.push(`font-family:${JSON.stringify(s.family)}, system-ui, sans-serif`);
    if (s.size)
      d.push(
        `font-size:${depth <= 2 && s.size > 40 ? `clamp(${px(Math.max(28, s.size * 0.6))}, ${r2(s.size / 14.4)}vw, ${px(s.size)})` : px(s.size)}`,
      );
    if (s.weight && s.weight !== 400) d.push(`font-weight:${s.weight}`);
    if (s.italic) d.push('font-style:italic');
    if (s.lineHeight) d.push(`line-height:${r2(s.lineHeight)}`);
    if (s.letterSpacing) d.push(`letter-spacing:${px(s.letterSpacing)}`);
    if (s.align && s.align !== 'left') d.push(`text-align:${s.align}`);
    if (s.transform) d.push(`text-transform:${s.transform}`);
    if (s.decoration) d.push(`text-decoration:${s.decoration}`);
    d.push('margin:0');
  } else if (n.kind === 'image') {
    d.push('object-fit:cover', 'display:block');
  } else if (paints.length) {
    const layers = [...paints].reverse();
    const solids = layers.filter((x) => x.p.kind === 'solid');
    const rest = layers.filter((x) => x.p.kind !== 'solid');
    if (rest.length) {
      d.push(`background-image:${rest.map((x) => x.css).join(', ')}`);
      if (rest.some((x) => x.p.kind === 'image'))
        d.push(
          `background-size:${rest[0]!.p.fit === 'contain' ? 'contain' : rest[0]!.p.fit === 'fill' ? '100% 100%' : 'cover'}`,
          'background-position:center',
          'background-repeat:no-repeat',
        );
    }
    if (solids.length) d.push(`background-color:${solids[0]!.css}`);
  }
  if (n.stroke) {
    const w = n.stroke.width;
    if (Array.isArray(w)) {
      const sides = ['top', 'right', 'bottom', 'left'];
      for (const [i, v] of w.entries()) if (v) d.push(`border-${sides[i]}:${px(v)} solid ${n.stroke.color}`);
    } else if (w) d.push(`border:${px(w)} solid ${n.stroke.color}`);
    d.push('box-sizing:border-box');
  }
  if (n.radius)
    d.push(`border-radius:${Array.isArray(n.radius) ? n.radius.map(px).join(' ') : px(n.radius)}`);
  if (n.shadows?.length)
    d.push(
      `box-shadow:${n.shadows.map((s) => `${s.inset ? 'inset ' : ''}${px(s.x)} ${px(s.y)} ${px(s.blur)} ${px(s.spread)} ${s.color}`).join(', ')}`,
    );
  if (n.blur) d.push(`filter:blur(${px(n.blur)})`);
  if (n.backdropBlur) d.push(`backdrop-filter:blur(${px(n.backdropBlur)})`);
  if (n.opacity !== undefined && n.opacity < 1) d.push(`opacity:${r2(n.opacity)}`);
  if (n.rotation) d.push(`transform:rotate(${r2(-n.rotation)}deg)`);
  if (n.clip) d.push('overflow:hidden');
  if (n.kind === 'vector') d.push('display:block', 'flex:none');
  // Whatever is placed by x and y inside this box is placed against it.
  if ((flex || n.children.length) && !d.some((x) => x.startsWith('position:'))) d.push('position:relative');
  return d;
}

function emitNode(n: DNode, parent: DNode | null, depth: number, e: Emit): string {
  const cls = classFor(n, e);
  let tag = depth === 0 ? 'main' : tagFor(n, e, depth);
  if (e.inLink && tag !== 'img') tag = 'span';
  const decls = nodeCss(n, parent, depth);
  // Links and the spans inside them are inline unless their layout says otherwise.
  if ((tag === 'a' || tag === 'span') && !decls.some((x) => x.startsWith('display:')))
    decls.push('display:block');
  if (decls.length) e.css.push(`.${cls}{${decls.join(';')}}`);
  if (n.kind === 'text') {
    const t = n.text!;
    const body = esc(t.content).replace(/\n/g, '<br>');
    const href = t.href && /^(https?:|mailto:|tel:|#|\/|\.\/)/.test(t.href) ? ` href="${esc(t.href)}"` : '';
    return `<${tag} class="${cls}"${tag === 'a' ? href || ' href="#"' : ''}>${body}</${tag}>`;
  }
  if (n.kind === 'image')
    return `<img class="${cls}" src="${esc(n.src ?? '')}" alt="${esc(n.alt ?? '')}"${n.w >= 1 ? ` width="${Math.round(n.w)}"` : ''}${n.h >= 1 ? ` height="${Math.round(n.h)}"` : ''} loading="lazy">`;
  if (n.kind === 'vector') {
    const t = e.inLink ? 'span' : 'div';
    if (n.svg) return `<${t} class="${cls}" aria-hidden="true">${n.svg}</${t}>`;
    const icon = cls === 'icon' ? cls : `${cls} icon`;
    return `<${t} class="${icon}" aria-hidden="true"${n.icon ? ` data-icon="${esc(n.icon)}"` : ''}></${t}>`;
  }
  if (tag === 'a') e.inLink++;
  const inner = n.children.map((c) => emitNode(c, n, depth + 1, e)).join('\n');
  if (tag === 'a') e.inLink--;
  const label = tag === 'a' ? ' href="#"' : '';
  return `<${tag} class="${cls}"${label}>\n${inner}\n</${tag}>`;
}

/** One page of the design as an HTML document, with its own styles in `cssHref` beside it. */
export function pageHtml(
  d: Design,
  page: DesignPage,
  cssHref = `${slug(page.name, 'page')}.css`,
  lang = 'en',
): { html: string; css: string } {
  const e: Emit = {
    css: [],
    used: new Map(),
    headings: { h1: false },
    inLink: 0,
    sizes: textSizes(page.root),
  };
  const body = emitNode(page.root, null, 0, e);
  const title = page.name === d.title ? d.title : `${page.name} · ${d.title}`;
  const html = `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(d.title)}">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="${esc(cssHref)}">
</head>
<body>
${body}
</body>
</html>
`;
  return { html, css: `${e.css.join('\n')}\n` };
}

/** The design's colours and base as CSS: variables for light, and dark where the design has a dark theme. */
export function tokensCss(d: Design): string {
  const light = d.colors.map((c) => `  --${c.name}: ${c.light};`).join('\n');
  const darks = d.colors.filter((c) => c.dark);
  const dark = darks.length
    ? `\n@media (prefers-color-scheme: dark) {\n  :root {\n${darks.map((c) => `    --${c.name}: ${c.dark};`).join('\n')}\n  }\n}\n`
    : '';
  return `/* Colours from the design, as variables. Use these names in the rest of the CSS. */
:root {
  color-scheme: ${darks.length ? 'light dark' : 'light'};
${light}
}
${dark}
*,
*::before,
*::after {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: system-ui, sans-serif;
}
img,
svg {
  display: block;
  max-width: 100%;
}
.icon {
  width: 24px;
  height: 24px;
}
:focus-visible {
  outline: 3px solid currentColor;
  outline-offset: 2px;
}
`;
}

/** The whole design as a site: a page per board (the first is index.html), its CSS, and the tokens. */
export function designSite(d: Design): { files: Map<string, string>; pages: string[] } {
  const files = new Map<string, string>();
  const pages: string[] = [];
  const taken = new Set<string>();
  d.pages.forEach((p, i) => {
    let name = i === 0 ? 'index' : slug(p.name, 'page');
    if (name === 'tokens') name = 'page-tokens';
    while (taken.has(name)) name = `${name}-${i}`;
    taken.add(name);
    const { html, css } = pageHtml(d, p, `${name}.css`);
    files.set(`${name}.html`, html);
    files.set(`${name}.css`, css);
    pages.push(`${name}.html`);
  });
  files.set('tokens.css', tokensCss(d));
  return { files, pages };
}
