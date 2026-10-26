// SPDX-License-Identifier: AGPL-3.0-only
/**
 * pen.dev's .pen files into Hildegard designs, so a design made there carries on here as real HTML and CSS. A .pen
 * file is JSON (comments allowed): frames with flex layout, shapes, paths, text, icons, and components (`reusable`)
 * placed as `ref` instances with overrides. Each top-level frame that isn't a component becomes a page; components
 * are expanded where they're used; colour variables become CSS variables, with their dark values when the file has a
 * theme axis with "dark" in it. Paths become inline SVG; icons are named for the agent to fill in.
 */
import {
  type Design,
  type DNode,
  darkNote,
  hexColor,
  num,
  type Paint,
  type Shadow,
  type Sizing,
  slug,
} from './design.ts';

// biome-ignore lint/suspicious/noExplicitAny: a design file is untyped JSON; every value read from it is checked.
type PNode = Record<string, any>;

export class PenError extends Error {}

/** JSON with // and /* comments and trailing commas, as .pen files allow. Strings are left alone. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
      out += text.slice(start, ++i);
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface Ctx {
  vars: Map<string, { type: string; light: unknown; dark?: unknown }>;
  used: Set<string>;
  components: Map<string, PNode>;
  images: Map<string, string>;
  fonts: Set<string>;
  icons: Set<string>;
  missing: Set<string>;
  skipped: Set<string>;
}

const varName = (v: string) => slug(v.replace(/[.]/g, '-'), 'v');

/** A value that may be a `$variable`: colours become var(--…), numbers and strings their light value. */
function resolve(v: unknown, ctx: Ctx): unknown {
  if (typeof v !== 'string' || !v.startsWith('$')) return v;
  const name = v.slice(1);
  const def = ctx.vars.get(name);
  if (!def) return undefined;
  if (def.type === 'color') {
    ctx.used.add(name);
    return `var(--${varName(name)})`;
  }
  return def.light;
}

function colorOf(v: unknown, ctx: Ctx): string | null {
  const r = resolve(v, ctx);
  if (typeof r !== 'string') return null;
  if (r.startsWith('var(--')) return r;
  return hexColor(r);
}

function paintsOf(fill: unknown, ctx: Ctx): Paint[] {
  if (fill === undefined || fill === null) return [];
  const list = Array.isArray(fill) ? fill : [fill];
  const out: Paint[] = [];
  for (const f of list.slice(0, 8)) {
    if (typeof f === 'string') {
      const c = colorOf(f, ctx);
      if (c) out.push({ kind: 'solid', color: c });
      continue;
    }
    if (!f || typeof f !== 'object' || f.enabled === false) continue;
    if (f.type === 'color') {
      const c = colorOf(f.color, ctx);
      if (c) out.push({ kind: 'solid', color: c });
    } else if (f.type === 'gradient') {
      const stops = (Array.isArray(f.colors) ? f.colors : [])
        .slice(0, 16)
        .map((s: PNode) => ({ color: colorOf(s.color, ctx) ?? '#000000', at: num(s.position, 0, 1) }));
      if (stops.length)
        out.push({
          kind: f.gradientType === 'radial' || f.gradientType === 'angular' ? 'radial' : 'linear',
          stops,
          angle: num(f.rotation, -360, 360, 180),
        });
    } else if (f.type === 'image' && typeof f.url === 'string') {
      const src = ctx.images.get(f.url) ?? null;
      if (!src) {
        ctx.missing.add(f.url.slice(0, 200));
        continue;
      }
      out.push({
        kind: 'image',
        src,
        fit: f.mode === 'contain' ? 'contain' : f.mode === 'stretch' ? 'fill' : 'cover',
      });
    } else ctx.skipped.add(`${f.type} fills`);
  }
  return out;
}

function sizeOf(v: unknown, ctx: Ctx): { size: Sizing; px: number } {
  const r = resolve(v, ctx);
  if (typeof r === 'number') return { size: 'fixed', px: num(r, 0, 1e5) };
  if (r === 'fill_container') return { size: 'fill', px: 0 };
  if (typeof r === 'string' && r.startsWith('fit_content')) {
    const m = /\(([\d.]+)\)/.exec(r);
    return { size: 'hug', px: m ? num(Number(m[1]), 0, 1e5) : 0 };
  }
  return { size: 'hug', px: 0 };
}

function padding(v: unknown, ctx: Ctx): [number, number, number, number] {
  const r = resolve(v, ctx);
  const n = (x: unknown) => num(resolve(x, ctx), 0, 2000);
  if (typeof r === 'number') return [n(r), n(r), n(r), n(r)];
  if (Array.isArray(r) && r.length === 2) return [n(r[0]), n(r[1]), n(r[0]), n(r[1])];
  if (Array.isArray(r) && r.length === 4) return [n(r[0]), n(r[1]), n(r[2]), n(r[3])];
  return [0, 0, 0, 0];
}

const PATH_D = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\-+eE\s]{1,100000}$/;

function pathSvg(
  n: PNode,
  w: number,
  h: number,
  fill: string,
  stroke: { color: string; width: number } | null,
) {
  const d = typeof n.geometry === 'string' ? n.geometry.trim() : '';
  if (!PATH_D.test(d)) return undefined;
  const vb =
    Array.isArray(n.viewBox) && n.viewBox.length === 4
      ? n.viewBox.map((x: unknown) => num(x, -1e5, 1e5)).join(' ')
      : `0 0 ${w || 24} ${h || 24}`;
  const rule = n.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
  const st = stroke ? `;stroke:${stroke.color};stroke-width:${stroke.width}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w || 24}" height="${h || 24}" preserveAspectRatio="none"><path d="${d}" style="fill:${fill}${st}"${rule}/></svg>`;
}

function polygonSvg(count: number, w: number, h: number, fill: string) {
  const k = Math.round(num(count, 3, 64, 3));
  const pts = Array.from({ length: k }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / k;
    return `${Math.round((w / 2 + (Math.cos(a) * w) / 2) * 100) / 100},${Math.round((h / 2 + (Math.sin(a) * h) / 2) * 100) / 100}`;
  }).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><polygon points="${pts}" style="fill:${fill}"/></svg>`;
}

/** A component instance as the node it stands for: the component, its overrides, and its descendants' overrides. */
function expandRef(n: PNode, ctx: Ctx, depth: number): PNode | null {
  const comp = ctx.components.get(String(n.ref));
  if (!comp || depth > 12) {
    ctx.missing.add(`component ${String(n.ref).slice(0, 60)}`);
    return null;
  }
  const { ref: _r, descendants, type: _t, ...own } = n;
  const copy: PNode = structuredClone(comp);
  delete copy.reusable;
  Object.assign(copy, own);
  if (descendants && typeof descendants === 'object')
    for (const [path, patch] of Object.entries(descendants as Record<string, PNode>)) {
      const ids = path.split('/');
      let parent: PNode | null = null;
      let at: PNode | undefined = copy;
      for (const id of ids) {
        parent = at ?? null;
        at = (at?.children ?? []).find((c: PNode) => c?.id === id);
        if (!at) break;
      }
      if (!at || !parent || !patch || typeof patch !== 'object') continue;
      if (patch.type) parent.children[parent.children.indexOf(at)] = { ...patch, id: at.id };
      else Object.assign(at, patch);
    }
  return copy;
}

const TEXTISH = new Set(['text']);
const SKIP = new Set(['note', 'prompt', 'context', 'script', 'browser']);

function convert(raw: PNode, parent: PNode | null, ctx: Ctx, depth = 0): DNode | null {
  if (!raw || typeof raw !== 'object' || raw.enabled === false || depth > 40) return null;
  let n = raw;
  if (n.type === 'ref') {
    const e = expandRef(n, ctx, depth);
    if (!e) return null;
    n = e;
    if (n.type === 'ref') return convert(n, parent, ctx, depth + 1);
  }
  if (SKIP.has(n.type)) {
    ctx.skipped.add(`${n.type} nodes`);
    return null;
  }
  const flexParent = parent && (parent.layout ?? 'horizontal') !== 'none' && parent.type === 'frame';
  const w = sizeOf(n.width, ctx);
  const h = sizeOf(n.height, ctx);
  const textish = TEXTISH.has(n.type);
  // Text grows with its words unless the file fixes its width.
  if (
    textish &&
    n.textGrowth !== 'fixed-width' &&
    n.textGrowth !== 'fixed-width-height' &&
    w.size === 'fixed'
  )
    w.size = n.textGrowth === 'auto' ? 'hug' : w.size;
  const fills = paintsOf(n.fill, ctx);
  const base = {
    name: String(n.name ?? n.id ?? n.type ?? 'part').slice(0, 80),
    x: num(resolve(n.x, ctx), -1e5, 1e5),
    y: num(resolve(n.y, ctx), -1e5, 1e5),
    w: w.px,
    h: h.px,
    wSize: w.size,
    hSize: textish && h.size === 'fixed' && n.textGrowth !== 'fixed-width-height' ? ('hug' as const) : h.size,
    absolute: (flexParent && n.layoutPosition === 'absolute') || undefined,
    opacity: n.opacity !== undefined ? num(resolve(n.opacity, ctx), 0, 1, 1) : undefined,
    rotation: n.rotation ? num(resolve(n.rotation, ctx), -360, 360) : undefined,
    children: [] as DNode[],
  };
  const strokeColor = n.stroke
    ? paintsOf(n.stroke.fill ?? n.stroke, ctx).find((p) => p.kind === 'solid')?.color
    : undefined;
  const sw = resolve(n.strokeWidth ?? n.stroke?.thickness, ctx);
  const stroke = strokeColor
    ? {
        color: strokeColor,
        width: Array.isArray(sw)
          ? ([0, 1, 2, 3].map((i) => num(resolve(sw[i], ctx), 0, 100)) as [number, number, number, number])
          : num(sw, 0, 100, 1),
      }
    : undefined;

  if (textish) {
    const family = typeof n.fontFamily === 'string' ? n.fontFamily.slice(0, 60) : undefined;
    if (family) ctx.fonts.add(family);
    const weight = Number(resolve(n.fontWeight, ctx));
    const size = num(resolve(n.fontSize, ctx), 1, 400, 14);
    return {
      ...base,
      kind: 'text',
      fills: [],
      text: {
        content: String(resolve(n.content, ctx) ?? '').slice(0, 20_000),
        href: typeof n.href === 'string' ? n.href : undefined,
        style: {
          family,
          size,
          weight: Number.isFinite(weight) ? num(weight, 100, 900, 400) : undefined,
          italic: n.fontStyle === 'italic' || undefined,
          lineHeight: n.lineHeight ? num(resolve(n.lineHeight, ctx), 0.5, 4) : undefined,
          letterSpacing: n.letterSpacing ? num(resolve(n.letterSpacing, ctx), -20, 50) : undefined,
          align: ['center', 'right', 'justify'].includes(n.textAlign) ? n.textAlign : undefined,
          decoration: n.underline ? 'underline' : n.strikethrough ? 'line-through' : undefined,
          color: fills.find((f) => f.kind === 'solid')?.color,
        },
      },
    };
  }
  const fillColor = fills.find((f) => f.kind === 'solid')?.color ?? 'currentColor';
  if (n.type === 'icon') {
    const name = `${String(n.library ?? 'icon').slice(0, 30)}:${String(n.icon ?? '').slice(0, 60)}`;
    ctx.icons.add(name);
    return { ...base, kind: 'vector', fills: [], icon: name, w: w.px || 24, h: h.px || 24 };
  }
  if (n.type === 'path') {
    const svg = pathSvg(
      n,
      w.px,
      h.px,
      fills.length ? fillColor : 'none',
      stroke && !Array.isArray(stroke.width) ? { color: stroke.color, width: stroke.width } : null,
    );
    if (!svg) ctx.skipped.add('paths that aren’t plain SVG path data');
    return { ...base, kind: 'vector', fills: [], svg };
  }
  if (n.type === 'polygon')
    return {
      ...base,
      kind: 'vector',
      fills: [],
      svg: polygonSvg(n.polygonCount, w.px || 24, h.px || 24, fillColor),
    };

  const kids: PNode[] = Array.isArray(n.children) ? n.children : [];
  if (n.type === 'rectangle' && fills.length === 1 && fills[0]!.kind === 'image') {
    const alt = /^(rectangle|image|img|photo)[\s_-]*\d*$/i.test(base.name) ? '' : base.name;
    return {
      ...base,
      kind: 'image',
      fills: [],
      src: fills[0]!.src,
      alt,
      radius: cornerRadius(n, ctx),
      clip: true,
    };
  }
  const node: DNode = { ...base, kind: 'box', fills, stroke };
  node.radius = n.type === 'ellipse' ? 9999 : cornerRadius(n, ctx);
  const effects = Array.isArray(n.effect) ? n.effect : n.effect ? [n.effect] : [];
  const shadows: Shadow[] = [];
  for (const e of effects.slice(0, 8)) {
    if (!e || e.enabled === false) continue;
    if (e.type === 'shadow')
      shadows.push({
        inset: e.shadowType === 'inner',
        x: num(resolve(e.offset?.x, ctx), -500, 500),
        y: num(resolve(e.offset?.y, ctx), -500, 500),
        blur: num(resolve(e.blur, ctx), 0, 500),
        spread: num(resolve(e.spread, ctx), -500, 500),
        color: colorOf(e.color, ctx) ?? 'rgb(0 0 0 / 0.25)',
      });
    else if (e.type === 'blur') node.blur = num(resolve(e.radius ?? e.blur, ctx), 0, 250);
    else if (e.type === 'background_blur') node.backdropBlur = num(resolve(e.radius ?? e.blur, ctx), 0, 250);
  }
  if (shadows.length) node.shadows = shadows;
  if (n.clip) node.clip = true;
  if (n.type === 'frame') {
    const dir = n.layout ?? 'horizontal';
    node.layout =
      dir === 'none'
        ? { dir: 'none', gap: 0, padding: padding(n.padding, ctx), justify: 'start', align: 'start' }
        : {
            dir: dir === 'vertical' ? 'column' : 'row',
            gap: num(resolve(n.gap, ctx), 0, 1000),
            padding: padding(n.padding, ctx),
            justify:
              ({ center: 'center', end: 'end', space_between: 'between', space_around: 'around' } as const)[
                n.justifyContent as 'center'
              ] ?? 'start',
            align:
              ({ center: 'center', end: 'end', start: 'start' } as const)[n.alignItems as 'center'] ??
              'start',
          };
  } else if (n.type === 'group' && kids.length) {
    node.layout = { dir: 'none', gap: 0, padding: [0, 0, 0, 0], justify: 'start', align: 'start' };
  }
  for (const c of kids) {
    const d = convert(c, n, ctx, depth + 1);
    if (d) node.children.push(d);
  }
  return node;
}

function cornerRadius(n: PNode, ctx: Ctx): DNode['radius'] {
  const r = resolve(n.cornerRadius, ctx);
  if (Array.isArray(r) && r.length === 4)
    return r.map((x) => num(resolve(x, ctx), 0, 9999)) as [number, number, number, number];
  return typeof r === 'number' && r > 0 ? num(r, 0, 9999) : undefined;
}

/** Every image path a .pen file's fills ask for, so the caller can bring those files along. */
export function penImages(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 60) return;
    if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else {
      const o = v as PNode;
      if (o.type === 'image' && typeof o.url === 'string') out.add(o.url);
      for (const x of Object.values(o)) walk(x, depth + 1);
    }
  };
  walk(doc, 0);
  return [...out].slice(0, 500);
}

/** Reads variables, with dark values from the theme axis that has "dark" in it. */
function readVars(doc: PNode): Ctx['vars'] {
  const vars: Ctx['vars'] = new Map();
  const axes = doc.themes && typeof doc.themes === 'object' ? (doc.themes as Record<string, unknown>) : {};
  const darkAxis = Object.entries(axes).find(([, vals]) => Array.isArray(vals) && vals.includes('dark'))?.[0];
  for (const [name, def] of Object.entries((doc.variables ?? {}) as Record<string, PNode>).slice(0, 2000)) {
    if (!def || typeof def !== 'object') continue;
    const type = String(def.type ?? 'string');
    const v = def.value;
    if (Array.isArray(v)) {
      const plain = v.find((e: PNode) => !e?.theme || (darkAxis && e.theme[darkAxis] !== 'dark')) ?? v[0];
      const dark = darkAxis
        ? [...v].reverse().find((e: PNode) => e?.theme?.[darkAxis] === 'dark')
        : undefined;
      vars.set(name, { type, light: plain?.value, dark: dark?.value });
    } else vars.set(name, { type, light: v });
  }
  return vars;
}

/**
 * A .pen document as a Design. `images` maps each image path the file uses (see penImages) to where the caller put
 * that file in the site.
 */
export function penDesign(
  source: string | unknown,
  title = 'Design',
  images = new Map<string, string>(),
): Design {
  let doc: PNode;
  try {
    doc = (typeof source === 'string' ? parseJsonc(source) : source) as PNode;
  } catch {
    throw new PenError('That .pen file isn’t valid JSON.');
  }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.children))
    throw new PenError('That isn’t a .pen file: it has no children.');
  const ctx: Ctx = {
    vars: readVars(doc),
    used: new Set(),
    components: new Map(),
    images,
    fonts: new Set(),
    icons: new Set(),
    missing: new Set(),
    skipped: new Set(),
  };
  const collect = (n: PNode, depth: number) => {
    if (!n || typeof n !== 'object' || depth > 60) return;
    if (n.reusable && typeof n.id === 'string') ctx.components.set(n.id, n);
    for (const c of Array.isArray(n.children) ? n.children : []) collect(c, depth + 1);
  };
  for (const c of doc.children) collect(c, 0);
  if (Object.keys(doc.imports ?? {}).length) ctx.skipped.add('components imported from other .pen files');

  const pages: Design['pages'] = [];
  for (const top of doc.children as PNode[]) {
    if (pages.length >= 12) break;
    if (!top || top.reusable || top.enabled === false || (top.type !== 'frame' && top.type !== 'ref'))
      continue;
    const root = convert(top, null, ctx);
    if (root?.kind === 'box') pages.push({ name: root.name, root: { ...root, x: 0, y: 0 } });
  }
  if (!pages.length) throw new PenError('That .pen file has no frames to make pages from.');

  const colors: Design['colors'] = [];
  for (const [name, def] of ctx.vars) {
    if (def.type !== 'color' || !ctx.used.has(name)) continue;
    const light = hexColor(def.light);
    if (!light) continue;
    colors.push({ name: varName(name), light, dark: hexColor(def.dark) ?? undefined });
  }
  const notes: string[] = [];
  const partial = darkNote(colors);
  if (partial) notes.push(partial);
  if (ctx.fonts.size)
    notes.push(`Fonts: ${[...ctx.fonts].join(', ')}. Put their WOFF2 files in fonts/ with @font-face.`);
  if (ctx.icons.size)
    notes.push(
      `Icons to draw as inline SVG (each is an empty .icon box with data-icon): ${[...ctx.icons].slice(0, 40).join(', ')}.`,
    );
  if (ctx.missing.size) notes.push(`Not found, left out: ${[...ctx.missing].slice(0, 20).join(', ')}.`);
  if (ctx.skipped.size) notes.push(`Not carried over: ${[...ctx.skipped].join(', ')}.`);
  notes.push('A design file draws one width. Check the phone layout first.');
  return { title: String(title).slice(0, 120), pages, colors, fonts: [...ctx.fonts], notes };
}
