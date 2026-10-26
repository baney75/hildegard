// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Checks a web page the way its visitors will meet it: Hildegard opens it in a real browser (Chrome, Chromium, Edge
 * or Brave, whichever this computer has) at a phone, a tablet and a desktop width, in light and dark, photographs each
 * one top to bottom, and audits it with tools/review_web.js: text that can't be read, a page that scrolls sideways,
 * controls with no name, targets too small for a thumb, missing alt text, broken images, script errors, and the
 * marks of a template nobody designed. The contact sheet outlines each problem where it is on the page.
 *
 * The page is a stranger's code, so it runs shut in: a fresh browser profile, served from a one-off address on this
 * computer that answers only for the round's own folder, with every other request refused (and reported, since a page
 * that needs the web isn't private and breaks offline). The browser is driven over a pipe, never a network port.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, Review } from '@hildegard/craft';
import { resource } from '@hildegard/runtime';
import { Browser, findChrome, serveFolder, Tab } from './browser.ts';

export { findChrome };

export interface WebSpec {
  /** The site's folder: the round's files, with the pages in it. */
  dir: string;
  /** The pages to check, as paths inside `dir`; the first is the one the sheet leads with. */
  pages: string[];
  /** Where to write the contact sheet (JPEG). */
  sheet?: string;
  /** Hold it to the bar for a page that ships, not a draft. */
  final?: boolean;
  /** The brief asked for a dark theme that follows the visitor's setting. */
  dark?: boolean;
  /**
   * The design to match: an image of the page as designed (a Figma frame, a pen.dev board, a screenshot of the old
   * site), the width it was designed at, and the page it is of. The page is rendered at that width and compared.
   */
  reference?: { path: string; width: number; page?: string };
}

/** A PNG's or JPEG's size in pixels, or null for anything else. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && v.getUint32(0) === 0x89504e47) return { w: v.getUint32(16), h: v.getUint32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let at = 2;
    while (at + 9 < b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!;
      const len = v.getUint16(at + 2);
      // Start of frame: baseline, extended, progressive, lossless (not DHT, JPG or DAC).
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { w: v.getUint16(at + 7), h: v.getUint16(at + 5) };
      at += 2 + len;
    }
  }
  return null;
}

/** What the page looks like against its design: structural similarity, and the three pictures for the sheet. */
export interface Likeness {
  page: string;
  width: number;
  /** Mean structural similarity (SSIM) of the two, in grey, at a quarter scale: 1 is the same picture. */
  score: number;
  /** Where they differ most, as fractions of the page height from the top. */
  worst: number[];
  reference: string;
  render: string;
  diff: string;
}

/**
 * Runs in the browser: loads both pictures, scales them to a quarter of the width, and compares 8×8 windows of grey
 * by SSIM. Returns the score, the worst bands, and a heat map of the difference over the render.
 */
const COMPARE = `async (refUrl, renderUrl) => {
  const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('image')); i.src = src; });
  const [a, b] = await Promise.all([load(refUrl), load(renderUrl)]);
  const W = Math.max(64, Math.round(b.naturalWidth / 4)), H = Math.max(64, Math.round(W * a.naturalHeight / a.naturalWidth));
  const grey = (img) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.drawImage(img, 0, 0, W, H); const d = x.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H); for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return g; };
  const ga = grey(a), gb = grey(b);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2, N = 8;
  let sum = 0, n = 0; const rows = new Float32Array(Math.ceil(H / N)), rowN = new Float32Array(Math.ceil(H / N));
  const heat = document.createElement('canvas'); heat.width = W; heat.height = H; const hx = heat.getContext('2d'); hx.drawImage(b, 0, 0, W, H);
  hx.fillStyle = 'rgba(255,255,255,0.55)'; hx.fillRect(0, 0, W, H);
  const ssim = (x, y, ox, oy) => {
    let ma = 0, mb = 0; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { ma += ga[(y + j) * W + x + i]; mb += gb[(y + oy + j) * W + x + ox + i]; }
    ma /= N * N; mb /= N * N; let va = 0, vb = 0, cov = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const da = ga[(y + j) * W + x + i] - ma, db = gb[(y + oy + j) * W + x + ox + i] - mb; va += da * da; vb += db * db; cov += da * db; }
    va /= N * N - 1; vb /= N * N - 1; cov /= N * N - 1;
    return { s: ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)), flat: va + vb < 4 && Math.abs(ma - mb) < 8 };
  };
  // A window may sit up to S pixels (16 at full size) off where the design has it and still count as matching:
  // a layout nudged by a few pixels is the same layout, and shouldn't read as a different one.
  const S = 4;
  for (let y = 0; y + N <= H; y += N) for (let x = 0; x + N <= W; x += N) {
    const here = ssim(x, y, 0, 0);
    // Flat in both and the same shade says nothing about the layout; leave it out, or empty space would carry the score.
    if (here.flat) continue;
    let s = here.s;
    for (let oy = -S; oy <= S && s < 0.98; oy++) for (let ox = -S; ox <= S; ox++) {
      if ((!ox && !oy) || x + ox < 0 || y + oy < 0 || x + ox + N > W || y + oy + N > H) continue;
      const t = ssim(x, y, ox, oy).s; if (t > s) s = t;
    }
    sum += s; n++; rows[y / N] += s; rowN[y / N]++;
    if (s < 0.7) { hx.fillStyle = 'rgba(224,36,154,' + Math.min(0.85, (0.7 - s) * 1.6 + 0.2).toFixed(2) + ')'; hx.fillRect(x, y, N, N); }
  }
  const bands = Array.from(rows, (r, i) => ({ at: (i * N) / H, s: rowN[i] ? r / rowN[i] : 1 })).sort((p, q) => p.s - q.s);
  return { score: n ? sum / n : 1, worst: bands.slice(0, 3).filter((x) => x.s < 0.8).map((x) => Math.round(x.at * 100) / 100), diff: heat.toDataURL('image/jpeg', 0.8).split(',')[1] };
}`;

interface Viewport {
  name: 'phone' | 'tablet' | 'desktop';
  width: number;
  height: number;
  mobile: boolean;
}
const VIEWPORTS: Viewport[] = [
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'tablet', width: 820, height: 1180, mobile: true },
  { name: 'desktop', width: 1440, height: 900, mobile: false },
];
/** Longest page photographed, in CSS pixels; past it the sheet says the page goes on. */
const MAX_PAGE = 9000;

// ── What a page is checked for ───────────────────────────────────────────────────────────────────────────────────

interface Found {
  what: string;
  box: [number, number, number, number];
  [k: string]: unknown;
}
export interface Audit {
  viewport: string;
  width: number;
  height: number;
  pageHeight: number;
  title: string;
  lang: string;
  viewportMeta: string;
  description: string;
  background: string;
  colorScheme: string;
  sideways: boolean;
  scrollWidth: number;
  overflow: Found[];
  contrast: Found[];
  contrastCount: number;
  textCount: number;
  unchecked: number;
  small: Found[];
  smallCount: number;
  longLines: Found[];
  families: string[];
  unnamed: Found[];
  unnamedCount: number;
  unlabelled: Found[];
  targets: Found[];
  targetCount: number;
  noAlt: Found[];
  noAltCount: number;
  broken: Found[];
  heavy: Found[];
  images: number;
  h1: number;
  skips: Found[];
  placeholder: boolean;
  standIn: string;
  stock: string[];
  emojiIcons: number;
  words: number;
  animated: boolean;
  reduced: boolean;
  outlineOff: boolean;
  focusStyled: boolean;
}

export interface PageShot {
  page: string;
  viewport: Viewport['name'];
  /** The viewport, in CSS pixels. */
  width: number;
  screen: number;
  dark: boolean;
  /** PNG, base64: the page from the top, up to MAX_PAGE tall. */
  png: string;
  height: number;
  cut: boolean;
  audit: Audit;
}

const check = (
  id: string,
  status: Check['status'],
  value: unknown,
  limit: unknown,
  detail: string,
): Check => ({
  id,
  status,
  value,
  limit,
  detail,
});
const list = (xs: Found[], n = 3, extra?: (f: Found) => string) =>
  xs
    .slice(0, n)
    .map((f) => `${f.what}${extra ? ` (${extra(f)})` : ''}`)
    .join('; ');

/** The checks, from every page at every viewport. Exported for tests. */
export function judge(
  shots: PageShot[],
  net: { blocked: string[]; errors: string[]; bytes: number; late: string[] },
  spec: Pick<WebSpec, 'final' | 'dark'>,
): Check[] {
  const light = shots.filter((s) => !s.dark);
  const at = (v: Viewport['name']) => light.filter((s) => s.viewport === v);
  const where = (s: PageShot) => `${s.page} at ${s.viewport}${s.dark ? ', dark' : ''}`;
  const worst = <K extends keyof Audit>(xs: PageShot[], k: K) =>
    xs.filter((s) => (Array.isArray(s.audit[k]) ? (s.audit[k] as unknown[]).length : s.audit[k]));
  const out: Check[] = [];

  out.push(
    check(
      'loads',
      net.late.length ? 'fail' : 'pass',
      net.late,
      [],
      'Pages that didn’t finish loading within 20 seconds. Something on them waits forever: a script, a font, an image from the web.',
    ),
  );
  out.push(
    check(
      'errors',
      net.errors.length ? 'fail' : 'pass',
      net.errors.slice(0, 5),
      [],
      'Script errors and console errors while the page loaded. Each one is something broken for every visitor.',
    ),
  );

  const sideways = light.filter((s) => s.audit.sideways);
  out.push(
    check(
      'overflow',
      sideways.length ? 'fail' : 'pass',
      sideways.map((s) => `${where(s)}: ${s.audit.scrollWidth}px wide`),
      'no sideways scroll',
      `The page scrolls sideways${sideways.length ? `; what sticks out: ${list(sideways[0]!.audit.overflow)}` : ''}. Let it wrap, give images max-width: 100%, and check fixed widths.`,
    ),
  );

  const low = shots.filter((s) => s.audit.contrastCount);
  const lowCount = low.reduce((n, s) => n + s.audit.contrastCount, 0);
  out.push(
    check(
      'contrast',
      lowCount ? 'fail' : 'pass',
      lowCount,
      'WCAG AA: 4.5:1, or 3:1 for large text',
      `Text that’s too faint for its background${low.length ? `, such as ${list(low[0]!.audit.contrast, 3, (f) => `${f.ratio}:1, needs ${f.need}:1`)} (${where(low[0]!)})` : ''}. Darken the text or lighten the ground until it passes.${shots.some((s) => s.audit.unchecked) ? ' Text over images or gradients can’t be measured: look at it on the sheet.' : ''}`,
    ),
  );

  const noAlt = worst(light, 'noAlt');
  out.push(
    check(
      'alt',
      noAlt.length ? 'fail' : 'pass',
      Math.max(0, ...light.map((s) => s.audit.noAltCount)),
      0,
      `Images with no alt attribute${noAlt.length ? `: ${list(noAlt[0]!.audit.noAlt, 3, (f) => String(f.src))}` : ''}. Describe what each shows for people who can’t see it, or alt="" if it’s decoration.`,
    ),
  );
  const broken = worst(light, 'broken');
  out.push(
    check(
      'images',
      broken.length ? 'fail' : 'pass',
      [...new Set(broken.flatMap((s) => s.audit.broken.map((f) => String(f.src))))].slice(0, 5),
      [],
      'Images that didn’t load. Send them in the zip beside the page, with paths relative to it.',
    ),
  );
  const unnamed = worst(light, 'unnamed');
  out.push(
    check(
      'names',
      unnamed.length ? 'fail' : 'pass',
      Math.max(0, ...light.map((s) => s.audit.unnamedCount)),
      0,
      `Links and buttons with nothing to call them by${unnamed.length ? `: ${list(unnamed[0]!.audit.unnamed)}` : ''}. A screen reader says “button”; give each words, or an aria-label for an icon.`,
    ),
  );
  const unlabelled = worst(light, 'unlabelled');
  out.push(
    check(
      'labels',
      unlabelled.length ? 'fail' : 'pass',
      unlabelled.length ? unlabelled[0]!.audit.unlabelled.length : 0,
      0,
      `Form fields without a label${unlabelled.length ? `: ${list(unlabelled[0]!.audit.unlabelled)}` : ''}. A placeholder isn’t a label; it vanishes as you type.`,
    ),
  );
  const tiny = at('phone').filter((s) => s.audit.targetCount);
  out.push(
    check(
      'targets',
      tiny.length ? 'warn' : 'pass',
      Math.max(0, ...at('phone').map((s) => s.audit.targetCount)),
      '24 × 24 CSS pixels on a phone',
      `Things to tap that are smaller than a fingertip can hit${tiny.length ? `: ${list(tiny[0]!.audit.targets, 3, (f) => (f.size as number[]).join(' × '))}` : ''}. Pad them to 44 pixels where you can.`,
    ),
  );
  const small = at('phone').filter((s) => s.audit.smallCount);
  out.push(
    check(
      'text-size',
      small.length ? 'warn' : 'pass',
      Math.max(0, ...at('phone').map((s) => s.audit.smallCount)),
      '12 px on a phone',
      `Text under 12 pixels on a phone${small.length ? `: ${list(small[0]!.audit.small)}` : ''}. Body text reads best at 16.`,
    ),
  );
  const long = at('desktop').filter((s) => s.audit.longLines.length);
  out.push(
    check(
      'measure',
      long.length ? 'warn' : 'pass',
      long.length ? Math.max(...long[0]!.audit.longLines.map((f) => Number(f.chars))) : 0,
      '90 characters a line',
      'Lines of body text too long to read comfortably on a desktop. Hold paragraphs to about 65 characters (max-width: 65ch).',
    ),
  );
  const families = [...new Set(light.flatMap((s) => s.audit.families))];
  out.push(
    check(
      'fonts',
      families.length > 3 ? 'warn' : 'pass',
      families,
      3,
      'Typefaces in use. More than three reads as nobody chose; one for text and one for display is usually right.',
    ),
  );
  const first = light[0]?.audit;
  const structure: string[] = [];
  if (first && first.h1 !== 1) structure.push(`${first.h1} h1 headings (want one)`);
  const skips = [...new Map(light.flatMap((s) => s.audit.skips).map((f) => [f.what, f])).values()];
  if (skips.length)
    structure.push(`a heading skips a level: ${list(skips, 2, (f) => `h${f.from} to h${f.to}`)}`);
  out.push(
    check(
      'headings',
      structure.length ? 'warn' : 'pass',
      structure,
      'one h1, no skipped levels',
      'The outline a screen reader and a search engine see. One h1 that says what the page is, then h2, h3 in order.',
    ),
  );
  const head: string[] = [];
  for (const s of light.filter((x) => x.viewport === 'phone')) {
    if (!s.audit.title) head.push(`${s.page}: no <title>`);
    if (!s.audit.lang) head.push(`${s.page}: no lang on <html>`);
    if (!/width=device-width/.test(s.audit.viewportMeta)) head.push(`${s.page}: no viewport meta`);
  }
  out.push(
    check(
      'head',
      head.some((h) => /viewport|title/.test(h)) ? 'fail' : head.length ? 'warn' : 'pass',
      head,
      [],
      'The basics every page needs: a <title>, <html lang>, and <meta name="viewport" content="width=device-width, initial-scale=1"> (without it a phone shows the desktop page shrunk).',
    ),
  );

  const placeholder = light.find((s) => s.audit.placeholder);
  const standIn = light.find((s) => s.audit.standIn);
  out.push(
    check(
      'placeholder',
      placeholder ? 'fail' : standIn ? 'warn' : 'pass',
      placeholder ? 'lorem ipsum' : (standIn?.audit.standIn ?? ''),
      'real words',
      'Placeholder text or stand-in names. A page is designed around its real words; write them, or ask your user for them.',
    ),
  );
  const stock = [...new Set(light.flatMap((s) => s.audit.stock))];
  out.push(
    check(
      'stock-copy',
      stock.length >= 2 ? 'warn' : 'pass',
      stock,
      'none',
      'Phrases from every template (“unlock the power”, “seamless”, “elevate your”). Say the plain, specific thing this product does.',
    ),
  );
  const emoji = Math.max(0, ...light.map((s) => s.audit.emojiIcons));
  out.push(
    check(
      'emoji-icons',
      emoji >= 3 ? 'warn' : 'pass',
      emoji,
      'under 3',
      'Headings, buttons and list items that start with an emoji in place of an icon. It reads as a template; draw or choose real icons, or let the words stand.',
    ),
  );

  if (net.blocked.length || spec.final)
    out.push(
      check(
        'offline',
        net.blocked.length ? (spec.final ? 'fail' : 'warn') : 'pass',
        net.blocked.slice(0, 6),
        'nothing from the web',
        'Things the page asked the web for, which Hildegard refused (fonts, scripts and images from other sites). A page that needs them breaks offline and tells those sites who visits. Put them in the zip beside the page.',
      ),
    );
  const mb = net.bytes / 1024 / 1024;
  out.push(
    check(
      'weight',
      mb > 15 ? 'fail' : mb > 3 ? 'warn' : 'pass',
      `${mb.toFixed(2)} MB`,
      '3 MB',
      'What the first page weighs. Over 3 MB is slow on a phone signal: size images to how big they’re shown, as WebP or AVIF.',
    ),
  );
  const heavy = light.flatMap((s) => s.audit.heavy);
  if (heavy.length)
    out.push(
      check(
        'image-size',
        'warn',
        list(heavy, 3, (f) => `${f.natural}px shown at ${f.shown}px`),
        '2.5 × the size shown',
        'Images much bigger than they’re shown. Export them at twice the shown width at most.',
      ),
    );

  const dark = shots.filter((s) => s.dark);
  if (dark.length) {
    const same = dark.filter(
      (d) =>
        light.find((l) => l.page === d.page && l.viewport === d.viewport)?.audit.background ===
        d.audit.background,
    );
    out.push(
      check(
        'dark',
        same.length ? (spec.dark ? 'fail' : 'pass') : 'pass',
        same.length ? 'the same in dark' : 'follows the visitor’s setting',
        spec.dark ? 'a dark theme' : null,
        spec.dark
          ? 'Whether the page has a dark theme when the visitor’s system asks for one (prefers-color-scheme: dark).'
          : 'Whether the page changes when the visitor’s system is dark. Not asked for, so either is fine; if it does change, check the dark views as hard as the light.',
      ),
    );
  }
  const motion = light.find((s) => s.audit.animated && !s.audit.reduced);
  out.push(
    check(
      'motion',
      motion ? 'warn' : 'pass',
      motion ? 'animates, with no reduced-motion style' : 'fine',
      '@media (prefers-reduced-motion: reduce)',
      'Animation without a way out. Some visitors get sick from motion; calm it under prefers-reduced-motion.',
    ),
  );
  const focus = light.find((s) => s.audit.outlineOff && !s.audit.focusStyled);
  out.push(
    check(
      'focus',
      focus ? 'fail' : 'pass',
      focus ? 'outline removed, no :focus style' : 'fine',
      'a visible focus',
      'Whether someone using a keyboard can see where they are. Never remove the outline without a :focus-visible style in its place.',
    ),
  );
  return out;
}

// ── The contact sheet ────────────────────────────────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The sheet, as a page for the same browser to photograph: the first screen of every view, then whole pages. */
export function sheetHtml(
  shots: PageShot[],
  checks: Check[],
  title: string,
  likeness: Likeness | null = null,
): { html: string; width: number } {
  const width = 1720;
  const bad = checks.filter((c) => c.status !== 'pass');
  const marks = (s: PageShot, scale: number) =>
    [
      ...s.audit.contrast.map((f) => ['contrast', f] as const),
      ...s.audit.overflow.map((f) => ['overflow', f] as const),
      ...s.audit.targets.map((f) => ['target', f] as const),
      ...s.audit.unnamed.map((f) => ['name', f] as const),
      ...s.audit.noAlt.map((f) => ['alt', f] as const),
      ...s.audit.broken.map((f) => ['image', f] as const),
      ...s.audit.small.map((f) => ['size', f] as const),
    ]
      .filter(([, f]) => f.box[1] < s.height)
      .map(
        ([k, f]) =>
          `<i class="m" style="left:${f.box[0] * scale}px;top:${f.box[1] * scale}px;width:${Math.max(4, f.box[2] * scale)}px;height:${Math.max(4, f.box[3] * scale)}px" title="${k}"></i>`,
      )
      .join('');
  const label = (s: PageShot) =>
    `${esc(s.page)} · ${s.viewport} ${s.width}px${s.dark ? ' · dark' : ''}${s.cut ? ` · first ${s.height}px` : ''}`;

  // Row one: what a visitor sees first, at each width, light and dark, all the same height.
  const foldH = 330;
  const lead = shots.filter((s) => s.page === shots[0]?.page);
  const fold = lead
    .map((s) => {
      const scale = foldH / s.screen;
      const w = Math.round(s.width * scale);
      return `<figure style="width:${w}px"><div class="shot" style="width:${w}px;height:${foldH}px"><img src="data:image/png;base64,${s.png}" style="width:${w}px">${marks(s, scale)}</div><figcaption>${label(s)} · first screen</figcaption></figure>`;
    })
    .join('');
  // Row two: whole pages, light, cut into columns so a long page still fits.
  const colH = 1500;
  const whole = shots
    .filter((s) => !s.dark)
    .map((s) => {
      const target = s.viewport === 'desktop' ? 420 : s.viewport === 'tablet' ? 300 : 210;
      const scale = target / s.width;
      const fullH = s.height * scale;
      const cols = Math.max(1, Math.ceil(fullH / colH));
      const parts = Array.from({ length: cols }, (_, i) => {
        const h = Math.min(colH, fullH - i * colH);
        return `<div class="shot" style="width:${target}px;height:${h}px"><div style="position:absolute;top:${-i * colH}px;left:0"><img src="data:image/png;base64,${s.png}" style="width:${target}px">${marks(s, scale)}</div></div>`;
      }).join('');
      return `<figure><div class="cols">${parts}</div><figcaption>${label(s)} · whole page${cols > 1 ? `, in ${cols} columns` : ''}</figcaption></figure>`;
    })
    .join('');
  // Row three: the design it was made from, the page at that width, and where they part.
  const refRow = likeness
    ? (() => {
        const w = 420;
        const pic = (src: string, cap: string) =>
          `<figure><div class="shot" style="width:${w}px"><img src="${src}" style="width:${w}px"></div><figcaption>${cap}</figcaption></figure>`;
        return `<div class="row">${pic(likeness.reference, `the design · ${likeness.width}px`)}${pic(`data:image/png;base64,${likeness.render}`, `${esc(likeness.page)} · ${likeness.width}px`)}${pic(`data:image/jpeg;base64,${likeness.diff}`, `where they part (magenta) · ${Math.round(likeness.score * 100)}% alike`)}</div>`;
      })()
    : '';
  const notes = bad
    .map((c) => `<li class="${c.status}"><b>${c.status === 'fail' ? 'FAIL' : 'warn'} ${esc(c.id)}</b></li>`)
    .join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{background:#181816;color:#e6e4dc;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;padding:14px;width:${width}px}
h1{font-size:15px;font-weight:600;margin-bottom:10px}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start;margin-bottom:18px}
figure{display:flex;flex-direction:column;gap:5px}
.cols{display:flex;gap:6px;align-items:flex-start}
.shot{position:relative;overflow:hidden;background:#fff;outline:1px solid #3a3a36}
.shot img{display:block}
.m{position:absolute;border:2px solid #e0249a;background:rgba(224,36,154,.12);border-radius:2px}
figcaption{color:#b8b5aa;font-size:12px}
ul{list-style:none;display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:12px;padding:0}
li.fail b{color:#ff6b9a}li.warn b{color:#e8c46a}
</style></head><body><h1>${esc(title)}</h1><ul>${notes || '<li>Every check passes. Now look hard.</li>'}</ul><div class="row">${fold}</div><div class="row">${whole}</div>${refRow}</body></html>`;
  return { html, width };
}

// ── The review ───────────────────────────────────────────────────────────────────────────────────────────────────

export class WebReviewError extends Error {}

/** Renders `page` at the reference's width, as tall as the reference is there, and compares the two in the browser. */
async function compare(
  tab: Tab,
  origin: string,
  ref: NonNullable<WebSpec['reference']>,
  fallback: string,
): Promise<Likeness> {
  const bytes = readFileSync(ref.path);
  const size = imageSize(bytes);
  if (!size) throw new WebReviewError('The reference is not a PNG or JPEG.');
  const page = ref.page ?? fallback;
  const width = Math.round(Math.min(3840, Math.max(320, ref.width)));
  const height = Math.min(MAX_PAGE, Math.max(200, Math.round((size.h * width) / size.w)));
  await tab.cmd('Emulation.setDeviceMetricsOverride', {
    width,
    height: Math.min(height, 1200),
    deviceScaleFactor: 1,
    mobile: width < 700,
  });
  await tab.cmd('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'light' }],
  });
  await tab.go(`${origin}/${page.split('/').map(encodeURIComponent).join('/')}`);
  const render = await tab.shoot(width, height);
  const mime = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
  const reference = bytes.toString('base64');
  const r = await tab.eval<{ score: number; worst: number[]; diff: string }>(
    `(${COMPARE})(${JSON.stringify(`data:${mime};base64,${reference}`)}, ${JSON.stringify(`data:image/png;base64,${render}`)})`,
  );
  return { page, width, ...r, reference: `data:${mime};base64,${reference}`, render, diff: r.diff };
}

/** Renders and checks the pages; writes the sheet. `chrome` is the browser, `audit` the source of review_web.js. */
export async function reviewWeb(
  chrome: string,
  audit: string,
  spec: WebSpec,
  timeoutMs = 180_000,
): Promise<Review> {
  if (!spec.pages.length) throw new WebReviewError('There’s no page to check.');
  const { origin, server } = await serveFolder(spec.dir);
  const browser = new Browser(chrome);
  let timer: NodeJS.Timeout | undefined;
  const work = (async () => {
    await browser.send('Browser.getVersion');
    const tab = await Tab.open(browser, origin);
    const shots: PageShot[] = [];
    const late: string[] = [];
    let firstBytes = -1;
    for (const page of spec.pages.slice(0, 5)) {
      const url = `${origin}/${page.split('/').map(encodeURIComponent).join('/')}`;
      const runs: [Viewport, boolean][] = [
        ...VIEWPORTS.map((v) => [v, false] as [Viewport, boolean]),
        [VIEWPORTS[0]!, true],
        [VIEWPORTS[2]!, true],
      ];
      for (const [v, dark] of runs) {
        await tab.cmd('Emulation.setDeviceMetricsOverride', {
          width: v.width,
          height: v.height,
          deviceScaleFactor: 1,
          mobile: v.mobile,
        });
        await tab.cmd('Emulation.setEmulatedMedia', {
          features: [
            { name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' },
            { name: 'prefers-reduced-motion', value: 'no-preference' },
          ],
        });
        await tab.cmd('Emulation.setTouchEmulationEnabled', { enabled: v.mobile });
        const before = tab.bytes;
        const ok = await tab.go(url);
        if (firstBytes < 0) firstBytes = tab.bytes - before;
        if (!ok && !late.includes(page)) late.push(page);
        const a = await tab.eval<Audit>(`(${audit})(${JSON.stringify(v.name)})`);
        // Without a viewport meta, a phone lays the page out wider than its screen and shrinks it: that is sideways too.
        if (a.width > v.width + 1) {
          a.sideways = true;
          a.scrollWidth = Math.max(a.scrollWidth, a.width);
        }
        const height = Math.min(MAX_PAGE, Math.max(v.height, a.pageHeight));
        const png = await tab.shoot(v.width, height);
        shots.push({
          page,
          viewport: v.name,
          width: v.width,
          screen: v.height,
          dark,
          png,
          height,
          cut: a.pageHeight > MAX_PAGE,
          audit: a,
        });
      }
    }
    const checks = judge(
      shots,
      { blocked: [...tab.blocked], errors: [...new Set(tab.errors)], bytes: firstBytes, late },
      spec,
    );
    let likeness: Likeness | null = null;
    if (spec.reference) {
      likeness = await compare(tab, origin, spec.reference, spec.pages[0]!);
      const s = likeness.score;
      checks.push(
        check(
          'reference',
          s >= 0.85 ? 'pass' : s >= 0.65 ? 'warn' : 'fail',
          Math.round(s * 100) / 100,
          0.85,
          `How closely the page at ${likeness.width}px matches the design it was made from (structural similarity, 1 is the same).${likeness.worst.length ? ` They part most ${likeness.worst.map((w) => `${Math.round(w * 100)}%`).join(', ')} of the way down; magenta on the sheet's reference row.` : ''} Match the layout, sizes and spacing first; text and pictures that are meant to differ will keep it under 1.`,
        ),
      );
    }
    const lead = shots[0]!.audit;
    if (spec.sheet) {
      const { html, width } = sheetHtml(
        shots,
        checks,
        `${spec.pages[0]} — ${lead.title || 'untitled'}`,
        likeness,
      );
      await tab.cmd('Fetch.disable');
      await tab.cmd('Emulation.setDeviceMetricsOverride', {
        width,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await tab.cmd('Emulation.setEmulatedMedia', { features: [] });
      const frame = (await tab.cmd('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      await tab.cmd('Page.setDocumentContent', { frameId: frame.frameTree.frame.id, html });
      await tab.eval('Promise.all([...document.images].map(i => i.decode().catch(() => 0)))');
      const h = await tab.eval<number>('document.documentElement.scrollHeight');
      const jpeg = await tab.shoot(width, Math.min(h, 16_000), 'jpeg');
      writeFileSync(spec.sheet, Buffer.from(jpeg, 'base64'));
    }
    tab.close();
    const info: Record<string, unknown> = {
      pages: spec.pages.slice(0, 5),
      title: lead.title,
      viewports: VIEWPORTS.map((v) => `${v.name} ${v.width}×${v.height}`),
      themes: 'light and dark',
      words: lead.words,
      images: lead.images,
      fonts: [...new Set(shots.flatMap((s) => s.audit.families))],
      'page height': shots
        .filter((s) => !s.dark && s.page === spec.pages[0])
        .map((s) => `${s.viewport} ${s.audit.pageHeight}px`),
      blocked: tab.blocked.size,
      weight: `${(Math.max(0, firstBytes) / 1024).toFixed(0)} KB`,
    };
    if (spec.sheet) info.sheet = spec.sheet;
    if (likeness)
      info.reference = `${likeness.page} at ${likeness.width}px: ${Math.round(likeness.score * 100)}% alike`;
    return { kind: 'web' as const, info, checks, passed: !checks.some((c) => c.status === 'fail') };
  })();
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new WebReviewError('Checking the page took too long.')), timeoutMs);
      }),
    ]);
  } catch (e) {
    throw e instanceof WebReviewError ? e : new WebReviewError((e as Error).message);
  } finally {
    clearTimeout(timer);
    browser.close();
    server.close();
    server.closeAllConnections();
  }
}

/** The web checker for this computer, or undefined when it has no browser to render with. */
export function webReviewer(
  chrome: string | null = findChrome(),
): ((spec: WebSpec) => Promise<Review>) | undefined {
  if (!chrome) return undefined;
  let audit: string;
  try {
    audit = readFileSync(resource(join('tools', 'review_web.js')), 'utf8')
      .replace(/^\/\/.*$/gm, '')
      .replace(/\/\*\*[\s\S]*?\*\//, '')
      .trim()
      .replace(/;$/, '');
  } catch {
    return undefined;
  }
  return (spec) => reviewWeb(chrome, audit, spec);
}
