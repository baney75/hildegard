// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Figma files into Hildegard designs. Reads a file (or one frame of it) over Figma's REST API with the owner's
 * personal access token, which lives in the keychain and is never sent anywhere but api.figma.com. Each top-level
 * frame becomes a page; auto layout, fills, strokes, corners, effects and text styles carry over; named colour styles
 * become CSS variables (a "Dark/…" style gives the dark value of the matching name); pictures and vectors are
 * downloaded into the site so it loads with nothing from outside; and the first frame comes down as a PNG to hold
 * every round of the loop to.
 */
import {
  cleanSvg,
  type Design,
  type DNode,
  darkNote,
  num,
  type Paint,
  rgba,
  type Shadow,
  type Sizing,
  slug,
} from './design.ts';

// biome-ignore lint/suspicious/noExplicitAny: a design file is untyped JSON; every value read from it is checked.
type FNode = Record<string, any>;

export class FigmaError extends Error {}

/** The file key and frame from a Figma link (figma.com/design/…, /file/…, /proto/…), or a bare key. */
export function parseFigmaUrl(s: string): { key: string; nodeId?: string } | null {
  const t = s.trim();
  if (/^[A-Za-z0-9]{10,64}$/.test(t)) return { key: t };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !/(^|\.)figma\.com$/.test(u.hostname)) return null;
  const m = /^\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,64})(?:\/|$)/.exec(u.pathname);
  if (!m) return null;
  const node = u.searchParams.get('node-id');
  const nodeId = node && /^\d+[-:]\d+$/.test(node) ? node.replace('-', ':') : undefined;
  return nodeId ? { key: m[1]!, nodeId } : { key: m[1]! };
}

const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
const VECTORS = new Set([
  'VECTOR',
  'STAR',
  'LINE',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
  'ELLIPSE',
  'POLYGON',
]);
const visible = (n: FNode) => n && n.visible !== false;

/** True when a node is drawing only (an icon, a logo): it comes down as one SVG. */
function isDrawing(n: FNode): boolean {
  // An ellipse alone is a round box (an avatar, a dot); inside a drawing it is part of the drawing.
  if (VECTORS.has(n.type)) return n.type !== 'ELLIPSE';
  if (!CONTAINERS.has(n.type) || n.type === 'SECTION') return false;
  const b = n.absoluteBoundingBox;
  if (!b || b.width > 160 || b.height > 160) return false;
  const kids = (n.children ?? []).filter(visible);
  return (
    kids.length > 0 &&
    kids.every((c: FNode) => VECTORS.has(c.type) || (CONTAINERS.has(c.type) && isDrawing(c)))
  );
}

/** Every vector that has to come down as SVG, and every picture a fill uses. */
export function figmaNeeds(frames: FNode[]): { svgIds: string[]; imageRefs: string[] } {
  const svgIds: string[] = [];
  const refs = new Set<string>();
  const walk = (n: FNode) => {
    if (!visible(n)) return;
    for (const f of n.fills ?? [])
      if (f.type === 'IMAGE' && f.imageRef && f.visible !== false) refs.add(f.imageRef);
    if (n.type !== 'TEXT' && isDrawing(n)) {
      svgIds.push(n.id);
      return;
    }
    for (const c of n.children ?? []) walk(c);
  };
  for (const f of frames) walk(f);
  return { svgIds, imageRefs: [...refs] };
}

/** The frames that become pages: a chosen frame, a page's frames, or the first page's (sections opened). */
export function figmaFrames(doc: FNode, max = 8): FNode[] {
  const frames: FNode[] = [];
  const take = (n: FNode) => {
    if (!visible(n) || frames.length >= max) return;
    if (n.type === 'SECTION') for (const c of n.children ?? []) take(c);
    else if (n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE') frames.push(n);
  };
  if (doc.type === 'DOCUMENT') {
    const canvas = (doc.children ?? []).find((c: FNode) => c.type === 'CANVAS' && (c.children ?? []).length);
    for (const c of canvas?.children ?? []) take(c);
  } else if (doc.type === 'CANVAS') for (const c of doc.children ?? []) take(c);
  else take(doc);
  return frames;
}

interface Ctx {
  styles: Record<string, { name: string; styleType: string }>;
  colors: Map<string, { light?: string; dark?: string }>;
  images: Map<string, string>;
  svgs: Map<string, string>;
  fonts: Set<string>;
  missingAlt: number;
  lostImages: number;
  lostVectors: number;
}

const color = (c: FNode | undefined, opacity = 1) =>
  c ? rgba(num(c.r, 0, 1), num(c.g, 0, 1), num(c.b, 0, 1), num(c.a, 0, 1, 1) * opacity) : '#000000';

/** A named colour style: its variable, or null when the style is a dark one (it only gives dark values). */
function styleVar(
  n: FNode,
  key: 'fill' | 'fills' | 'stroke' | 'strokes',
  value: string,
  ctx: Ctx,
): string | null {
  const id = n.styles?.[key];
  const st = id ? ctx.styles[id] : undefined;
  if (st?.styleType !== 'FILL') return null;
  const m = /^\s*(light|dark)\s*[/\-–:]\s*(.+)$/i.exec(st.name);
  const name = slug(m ? m[2]! : st.name.split('/').join(' '), 'color');
  const entry = ctx.colors.get(name) ?? {};
  if (m && m[1]!.toLowerCase() === 'dark') {
    entry.dark ??= value;
    ctx.colors.set(name, entry);
    return null;
  }
  entry.light ??= value;
  ctx.colors.set(name, entry);
  return `var(--${name})`;
}

function paints(n: FNode, list: FNode[] | undefined, ctx: Ctx, which: 'fills' | 'strokes'): Paint[] {
  const out: Paint[] = [];
  const shown = (list ?? []).filter((p) => p.visible !== false);
  for (const p of shown) {
    const op = num(p.opacity, 0, 1, 1);
    if (p.type === 'SOLID') {
      const c = color(p.color, op);
      const v = shown.length === 1 ? styleVar(n, which === 'fills' ? 'fill' : 'stroke', c, ctx) : null;
      out.push({ kind: 'solid', color: v ?? c });
    } else if (
      p.type === 'GRADIENT_LINEAR' ||
      p.type === 'GRADIENT_RADIAL' ||
      p.type === 'GRADIENT_DIAMOND'
    ) {
      const stops = (p.gradientStops ?? []).slice(0, 16).map((s: FNode) => ({
        color: color(s.color, op),
        at: num(s.position, 0, 1),
      }));
      const [a, b] = p.gradientHandlePositions ?? [];
      const angle =
        a && b
          ? (Math.atan2(num(b.x, -9, 9) - num(a.x, -9, 9), -(num(b.y, -9, 9) - num(a.y, -9, 9))) * 180) /
            Math.PI
          : 180;
      out.push({
        kind: p.type === 'GRADIENT_LINEAR' ? 'linear' : 'radial',
        stops,
        angle: (angle + 360) % 360,
      });
    } else if (p.type === 'IMAGE' && p.imageRef) {
      const src = ctx.images.get(p.imageRef);
      if (!src) {
        ctx.lostImages++;
        continue;
      }
      const fit = p.scaleMode === 'FIT' ? 'contain' : p.scaleMode === 'STRETCH' ? 'fill' : 'cover';
      out.push({ kind: 'image', src, fit, opacity: op });
    }
  }
  return out;
}

function sizing(n: FNode, axis: 'H' | 'V', parent: FNode | null): Sizing {
  const s = axis === 'H' ? n.layoutSizingHorizontal : n.layoutSizingVertical;
  if (s === 'FILL') return 'fill';
  if (s === 'HUG') return 'hug';
  if (s === 'FIXED') return 'fixed';
  const dir = parent?.layoutMode;
  const primary = (dir === 'HORIZONTAL' && axis === 'H') || (dir === 'VERTICAL' && axis === 'V');
  if (dir && dir !== 'NONE') {
    if (primary && n.layoutGrow === 1) return 'fill';
    if (!primary && n.layoutAlign === 'STRETCH') return 'fill';
  }
  if (n.type === 'TEXT') {
    if (n.style?.textAutoResize === 'WIDTH_AND_HEIGHT' || n.textAutoResize === 'WIDTH_AND_HEIGHT')
      return 'hug';
    return axis === 'V' ? 'hug' : 'fixed';
  }
  if (n.layoutMode && n.layoutMode !== 'NONE') {
    const own =
      (n.layoutMode === 'HORIZONTAL') === (axis === 'H') ? n.primaryAxisSizingMode : n.counterAxisSizingMode;
    if (own === 'AUTO') return 'hug';
  }
  return 'fixed';
}

const GENERIC = /^(rectangle|image|frame|group|ellipse|vector|photo|img|pic|unsplash|pexels)[\s_-]*\d*$/i;

function convert(n: FNode, parent: FNode | null, ctx: Ctx): DNode | null {
  if (!visible(n)) return null;
  const b = n.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const pb = parent?.absoluteBoundingBox ?? b;
  const base = {
    name: String(n.name ?? n.type ?? 'part').slice(0, 80),
    x: num(b.x - pb.x, -1e5, 1e5),
    y: num(b.y - pb.y, -1e5, 1e5),
    w: num(b.width, 0, 1e5),
    h: num(b.height, 0, 1e5),
    wSize: sizing(n, 'H', parent),
    hSize: sizing(n, 'V', parent),
    absolute: n.layoutPositioning === 'ABSOLUTE' || undefined,
    opacity: n.opacity !== undefined ? num(n.opacity, 0, 1, 1) : undefined,
    children: [] as DNode[],
  };
  if (n.type === 'TEXT') {
    const st = n.style ?? {};
    const fills = paints(n, n.fills, ctx, 'fills');
    if (st.fontFamily) ctx.fonts.add(String(st.fontFamily).slice(0, 60));
    const size = num(st.fontSize, 1, 400, 16);
    const href =
      st.hyperlink?.type === 'URL' && typeof st.hyperlink.url === 'string' ? st.hyperlink.url : undefined;
    return {
      ...base,
      kind: 'text',
      fills: [],
      text: {
        content: String(n.characters ?? '').slice(0, 20_000),
        href,
        style: {
          family: st.fontFamily ? String(st.fontFamily).slice(0, 60) : undefined,
          size,
          weight: st.fontWeight ? num(st.fontWeight, 100, 900, 400) : undefined,
          italic: st.italic === true || undefined,
          lineHeight: st.lineHeightPx ? num(st.lineHeightPx / size, 0.5, 4) : undefined,
          letterSpacing: st.letterSpacing ? num(st.letterSpacing, -20, 50) : undefined,
          align: ({ CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' } as const)[
            st.textAlignHorizontal as 'CENTER'
          ],
          transform: ({ UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' } as const)[
            st.textCase as 'UPPER'
          ],
          decoration: ({ UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' } as const)[
            st.textDecoration as 'UNDERLINE'
          ],
          color: fills.find((f) => f.kind === 'solid')?.color,
        },
      },
    };
  }
  if (isDrawing(n)) {
    const svg = ctx.svgs.get(n.id);
    if (!svg) ctx.lostVectors++;
    return {
      ...base,
      kind: 'vector',
      fills: [],
      svg: svg ?? undefined,
      icon: svg ? undefined : slug(base.name, 'icon'),
    };
  }
  const fills = paints(n, n.fills, ctx, 'fills');
  const kids = n.children ?? [];
  // A plain shape filled with one picture is that picture.
  if (!kids.length && fills.length === 1 && fills[0]!.kind === 'image') {
    const alt = GENERIC.test(base.name.trim()) ? '' : base.name;
    if (!alt) ctx.missingAlt++;
    return { ...base, kind: 'image', fills: [], src: fills[0]!.src, alt, radius: radius(n), clip: true };
  }
  const node: DNode = { ...base, kind: 'box', fills };
  const strokes = paints(n, n.strokes, ctx, 'strokes').filter((p) => p.kind === 'solid');
  if (strokes.length) {
    const ind = n.individualStrokeWeights;
    node.stroke = {
      color: strokes[0]!.color!,
      width: ind
        ? [num(ind.top, 0, 100), num(ind.right, 0, 100), num(ind.bottom, 0, 100), num(ind.left, 0, 100)]
        : num(n.strokeWeight, 0, 100, 1),
    };
  }
  node.radius = n.type === 'ELLIPSE' ? 9999 : radius(n);
  const shadows: Shadow[] = [];
  for (const e of n.effects ?? []) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
      shadows.push({
        inset: e.type === 'INNER_SHADOW',
        x: num(e.offset?.x, -500, 500),
        y: num(e.offset?.y, -500, 500),
        blur: num(e.radius, 0, 500),
        spread: num(e.spread, -500, 500),
        color: color(e.color),
      });
    else if (e.type === 'LAYER_BLUR') node.blur = num(e.radius, 0, 250);
    else if (e.type === 'BACKGROUND_BLUR') node.backdropBlur = num(e.radius, 0, 250);
  }
  if (shadows.length) node.shadows = shadows;
  if (n.clipsContent) node.clip = true;
  const mode = n.layoutMode;
  if (mode === 'HORIZONTAL' || mode === 'VERTICAL' || mode === 'GRID') {
    node.layout = {
      dir: mode === 'VERTICAL' ? 'column' : 'row',
      gap: num(n.itemSpacing, 0, 1000),
      padding: [
        num(n.paddingTop, 0, 2000),
        num(n.paddingRight, 0, 2000),
        num(n.paddingBottom, 0, 2000),
        num(n.paddingLeft, 0, 2000),
      ],
      justify:
        ({ CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'between' } as const)[
          n.primaryAxisAlignItems as 'CENTER'
        ] ?? 'start',
      align:
        ({ CENTER: 'center', MAX: 'end', BASELINE: 'baseline' } as const)[
          n.counterAxisAlignItems as 'CENTER'
        ] ?? 'start',
      wrap: n.layoutWrap === 'WRAP' || mode === 'GRID' || undefined,
    };
  } else if (kids.length) {
    node.layout = { dir: 'none', gap: 0, padding: [0, 0, 0, 0], justify: 'start', align: 'start' };
  }
  for (const c of kids) {
    const d = convert(c, n, ctx);
    if (d) node.children.push(d);
  }
  return node;
}

function radius(n: FNode): DNode['radius'] {
  const r = n.rectangleCornerRadii;
  if (Array.isArray(r) && r.length === 4) {
    const v = r.map((x: unknown) => num(x, 0, 9999)) as [number, number, number, number];
    return v.every((x) => x === v[0]) ? v[0] || undefined : v;
  }
  return n.cornerRadius ? num(n.cornerRadius, 0, 9999) : undefined;
}

export interface FigmaAssets {
  /** imageRef → the file's path in the site (assets/…). */
  images?: Map<string, string>;
  /** node id → sanitised SVG markup. */
  svgs?: Map<string, string>;
}

/** A Figma file's frames as a Design. `styles` is the file's (or the nodes response's) style map. */
export function figmaDesign(
  title: string,
  frames: FNode[],
  styles: Record<string, { name: string; styleType: string }> = {},
  assets: FigmaAssets = {},
): Design {
  const ctx: Ctx = {
    styles,
    colors: new Map(),
    images: assets.images ?? new Map(),
    svgs: assets.svgs ?? new Map(),
    fonts: new Set(),
    missingAlt: 0,
    lostImages: 0,
    lostVectors: 0,
  };
  const pages = [];
  for (const f of frames) {
    const root = convert(f, null, ctx);
    if (root) pages.push({ name: String(f.name ?? 'Page').slice(0, 80), root: { ...root, x: 0, y: 0 } });
  }
  const colors = [...ctx.colors]
    .filter(([, v]) => v.light)
    .map(([name, v]) => ({ name, light: v.light!, dark: v.dark }));
  const notes: string[] = [];
  if (ctx.fonts.size)
    notes.push(
      `Fonts: ${[...ctx.fonts].join(', ')}. Put their files (WOFF2) in fonts/ with @font-face, or the pages fall back to the system font.`,
    );
  if (ctx.missingAlt) notes.push(`${ctx.missingAlt} pictures have no description: write alt text for each.`);
  if (ctx.lostImages) notes.push(`${ctx.lostImages} picture fills couldn’t be downloaded and were left out.`);
  if (ctx.lostVectors)
    notes.push(`${ctx.lostVectors} vectors couldn’t be exported; they are empty .icon boxes.`);
  const partial = darkNote(colors);
  if (partial) notes.push(partial);
  if (colors.some((c) => c.dark)) notes.push('Dark colours came from styles named “Dark/…”.');
  notes.push(
    'A design file draws one width. Rows wrap on a phone; check the phone layout first and fix what wrapping can’t.',
  );
  return { title: title.slice(0, 120) || 'Figma design', pages, colors, fonts: [...ctx.fonts], notes };
}

// ── Over the API ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface FigmaImport {
  design: Design;
  /** Files to add to the site, by path. */
  files: Map<string, Buffer>;
  /** The first frame as a PNG, and the width it was drawn at. */
  reference?: { data: Buffer; width: number };
}

type Fetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const API = 'https://api.figma.com/v1';
/** Picture downloads only from where Figma's API says its renders and uploads live. */
const DOWNLOAD_HOST = /(^|\.)(figma\.com|amazonaws\.com)$/;
const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

async function readCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > max) throw new FigmaError(`A download from Figma is over ${Math.round(max / 1e6)} MB.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new FigmaError(`A download from Figma is over ${Math.round(max / 1e6)} MB.`);
  return buf;
}

/**
 * Imports a Figma file or frame. `token` is the owner's personal access token (file_content:read); it is sent only to
 * api.figma.com. Pictures and SVGs come from the URLs Figma's API returns, and only from Figma's hosts.
 */
export async function importFigma(
  source: string,
  token: string,
  opts: { fetch?: Fetch; maxPages?: number; signal?: AbortSignal } = {},
): Promise<FigmaImport> {
  const at = parseFigmaUrl(source);
  if (!at)
    throw new FigmaError(
      'That isn’t a Figma link. Copy the link to the file or a frame from Figma’s Share menu.',
    );
  const f: Fetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const api = async (path: string): Promise<FNode> => {
    const res = await f(`${API}${path}`, { headers: { 'X-Figma-Token': token }, signal: opts.signal });
    if (res.status === 403 || res.status === 401)
      throw new FigmaError(
        'Figma refused the token. Make a new personal access token with file content read access.',
      );
    if (res.status === 404) throw new FigmaError('Figma has no such file, or this token can’t see it.');
    if (res.status === 429) throw new FigmaError('Figma is rate limiting this token. Try again in a minute.');
    if (!res.ok) throw new FigmaError(`Figma answered ${res.status}.`);
    return JSON.parse((await readCapped(res, 80e6)).toString('utf8'));
  };
  const download = async (url: unknown, max: number): Promise<{ data: Buffer; type: string } | null> => {
    if (typeof url !== 'string') return null;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || !DOWNLOAD_HOST.test(u.hostname)) return null;
    try {
      const res = await f(u.href, { signal: opts.signal });
      if (!res.ok) return null;
      return {
        data: await readCapped(res, max),
        type: (res.headers.get('content-type') ?? '').split(';')[0]!.trim(),
      };
    } catch {
      return null;
    }
  };

  let title: string;
  let doc: FNode;
  let styles: Record<string, { name: string; styleType: string }>;
  if (at.nodeId) {
    const r = await api(`/files/${at.key}/nodes?ids=${encodeURIComponent(at.nodeId)}`);
    const node = r.nodes?.[at.nodeId];
    if (!node?.document) throw new FigmaError('That frame isn’t in the file any more.');
    title = r.name ?? 'Figma design';
    doc = node.document;
    styles = node.styles ?? {};
  } else {
    const r = await api(`/files/${at.key}`);
    title = r.name ?? 'Figma design';
    doc = r.document;
    styles = r.styles ?? {};
  }
  const frames = figmaFrames(doc, opts.maxPages ?? 8);
  if (!frames.length)
    throw new FigmaError('There are no frames to import. Put the page’s design in a frame.');
  const needs = figmaNeeds(frames);
  const files = new Map<string, Buffer>();

  const images = new Map<string, string>();
  if (needs.imageRefs.length) {
    const r = await api(`/files/${at.key}/images`);
    const urls: Record<string, string> = r.meta?.images ?? r.images ?? {};
    for (const ref of needs.imageRefs.slice(0, 80)) {
      const got = await download(urls[ref], 20e6);
      const ext = got && EXT[got.type];
      if (!got || !ext || ext === 'svg') continue;
      const path = `assets/${slug(ref, 'img').slice(0, 24)}.${ext}`;
      files.set(path, got.data);
      images.set(ref, path);
    }
  }

  const svgs = new Map<string, string>();
  const ids = needs.svgIds.slice(0, 400);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const r = await api(`/images/${at.key}?ids=${encodeURIComponent(batch.join(','))}&format=svg`);
    for (const id of batch) {
      const got = await download(r.images?.[id], 2e6);
      const svg = got && cleanSvg(got.data.toString('utf8'));
      if (svg) svgs.set(id, svg);
    }
  }

  let reference: FigmaImport['reference'];
  const first = frames[0]!;
  const width = Math.round(num(first.absoluteBoundingBox?.width, 0, 1e5));
  if (width >= 320) {
    const r = await api(`/images/${at.key}?ids=${encodeURIComponent(first.id)}&format=png&scale=1`).catch(
      () => null,
    );
    const got = await download(r?.images?.[first.id], 40e6);
    if (got?.type === 'image/png') reference = { data: got.data, width };
  }

  return { design: figmaDesign(title, frames, styles, { images, svgs }), files, reference };
}
