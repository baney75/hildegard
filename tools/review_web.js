// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The audit Hildegard runs inside a page it renders (apps/server/src/web-review.ts evaluates this file in the page,
 * once per viewport). It only reads the page and returns what it found as JSON: the faults that sink a web page for
 * the people using it (text they can't read, a page that scrolls sideways on a phone, buttons with no name, targets
 * too small for a thumb) and the signs of a template nobody designed (placeholder text, stock copy, too many fonts).
 * Every finding that has a place on the page carries its box, so the contact sheet can outline it.
 *
 * The file is one expression: a function of the viewport's name, called as `(source)(name)`.
 */
(viewport) => {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const doc = document.documentElement;
  const MAX = 8;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return [
      Math.round(r.left + scrollX),
      Math.round(r.top + scrollY),
      Math.round(r.width),
      Math.round(r.height),
    ];
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    for (let e = el; e && e !== doc; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    }
    return true;
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
        : '';
    const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('alt') || '')
      .trim()
      .replace(/\s+/g, ' ');
    return `${tag}${id}${cls}${text ? ` “${text.slice(0, 40)}${text.length > 40 ? '…' : ''}”` : ''}`;
  };
  const found = (el, extra) => ({ what: describe(el), box: box(el), ...extra });

  // ── Colour ──────────────────────────────────────────────────────────────────────────────────────────────────
  const parse = (c) => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const over = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (!a) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  /** The colour behind an element, or null when an image or gradient is behind it and the colour can't be known. */
  const backdrop = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor);
      if (c && c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
    }
    let under = parse(
      getComputedStyle(doc).colorScheme === 'dark' ? 'rgb(18, 18, 18)' : 'rgb(255, 255, 255)',
    );
    for (let i = layers.length - 1; i >= 0; i--) under = over(layers[i], under);
    return under;
  };

  // Every element that holds visible text of its own.
  const texts = [];
  const walker = document.createTreeWalker(document.body || doc, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const el = n.parentElement;
    if (!el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TITLE)$/.test(el.tagName)) continue;
    seen.add(el);
    if (visible(el)) texts.push(el);
  }

  const contrast = [];
  let unchecked = 0;
  const families = new Map();
  const small = [];
  const longLines = [];
  for (const el of texts) {
    const s = getComputedStyle(el);
    const size = Number.parseFloat(s.fontSize);
    const weight = Number.parseInt(s.fontWeight, 10) || 400;
    const family = s.fontFamily
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    families.set(family, (families.get(family) || 0) + 1);
    if (size < 12 && viewport === 'phone') small.push(found(el, { px: size }));
    const fg = parse(s.color);
    const bg = backdrop(el);
    if (!fg || !bg) {
      unchecked++;
    } else {
      const r = ratio(over(fg, bg), bg);
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      if (r < need) contrast.push(found(el, { ratio: Math.round(r * 100) / 100, need }));
    }
    if (viewport === 'desktop' && /^(P|LI|DD|BLOCKQUOTE)$/.test(el.tagName) && el.innerText.length > 120) {
      const chars = el.getBoundingClientRect().width / (size * 0.5);
      if (chars > 90) longLines.push(found(el, { chars: Math.round(chars) }));
    }
  }

  // ── Layout ──────────────────────────────────────────────────────────────────────────────────────────────────
  const overflow = [];
  const sideways = doc.scrollWidth > W + 1;
  if (sideways) {
    for (const el of document.body ? document.body.querySelectorAll('*') : []) {
      const r = el.getBoundingClientRect();
      if (
        r.right > W + 1 &&
        r.width > 0 &&
        visible(el) &&
        !(el.parentElement && el.parentElement.getBoundingClientRect().right > W + 1)
      ) {
        overflow.push(found(el, { right: Math.round(r.right) }));
        if (overflow.length >= MAX) break;
      }
    }
  }

  // ── Names and labels ────────────────────────────────────────────────────────────────────────────────────────
  const nameOf = (el) => {
    const label = el.getAttribute('aria-label') || '';
    const by = (el.getAttribute('aria-labelledby') || '')
      .split(/\s+/)
      .map((id) => (id && document.getElementById(id) ? document.getElementById(id).textContent : ''))
      .join(' ');
    const alt = [...el.querySelectorAll('img[alt], svg title')]
      .map((x) => x.getAttribute('alt') || x.textContent)
      .join(' ');
    return `${label} ${by} ${el.innerText || el.value || ''} ${alt} ${el.getAttribute('title') || ''}`.trim();
  };
  const controls = [
    ...document.querySelectorAll(
      'a[href], button, [role="button"], input[type="submit"], input[type="button"], summary',
    ),
  ].filter(visible);
  const unnamed = controls.filter((el) => !nameOf(el)).map((el) => found(el));
  const fields = [
    ...document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), select, textarea',
    ),
  ].filter(visible);
  const unlabelled = fields
    .filter((el) => {
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.closest('label'))
        return false;
      return !(el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    })
    .map((el) => found(el));

  const targets = [];
  if (viewport === 'phone') {
    for (const el of [...controls, ...fields]) {
      const r = el.getBoundingClientRect();
      // A link inside a sentence is excused: WCAG 2.5.8 exempts targets in a line of text.
      const inline =
        el.tagName === 'A' &&
        getComputedStyle(el).display === 'inline' &&
        el.parentElement &&
        el.parentElement.innerText.trim().length > el.innerText.trim().length + 20;
      if (!inline && (r.width < 24 || r.height < 24))
        targets.push(found(el, { size: [Math.round(r.width), Math.round(r.height)] }));
    }
  }

  // ── Images ──────────────────────────────────────────────────────────────────────────────────────────────────
  const imgs = [...document.images];
  const noAlt = imgs
    .filter((i) => !i.hasAttribute('alt') && visible(i))
    .map((i) => found(i, { src: (i.currentSrc || i.src).split('/').pop().slice(0, 60) }));
  const broken = imgs
    .filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src))
    .map((i) => found(i, { src: (i.currentSrc || i.src).split('/').pop().slice(0, 60) }));
  const heavy = imgs
    .filter(
      (i) =>
        visible(i) &&
        i.naturalWidth > 1200 &&
        i.naturalWidth > i.getBoundingClientRect().width * 2.5 * devicePixelRatio,
    )
    .map((i) => found(i, { natural: i.naturalWidth, shown: Math.round(i.getBoundingClientRect().width) }));

  // ── Structure ───────────────────────────────────────────────────────────────────────────────────────────────
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(visible);
  const skips = [];
  let last = 0;
  for (const h of headings) {
    const level = Number(h.tagName[1]);
    if (last && level > last + 1) skips.push(found(h, { from: last, to: level }));
    last = level;
  }
  const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';

  // ── Words ───────────────────────────────────────────────────────────────────────────────────────────────────
  const body = document.body?.innerText || '';
  const PLACEHOLDER = /lorem ipsum|dolor sit amet|consectetur adipiscing/i;
  const STAND_IN =
    /\b(your company|company name|acme( inc| corp)?|john doe|jane doe|example\.com|\[insert[^\]]*\]|placeholder|tbd|coming soon\.{3})\b/i;
  const STOCK =
    /\b(unlock the (power|potential)|elevate your|seamless(ly)?|revolutioni[sz]e|cutting[- ]edge|game[- ]chang(er|ing)|supercharge|next[- ]level|harness the power|in today'?s (fast[- ]paced|digital)|empower(s|ing)? you|transform your|world[- ]class|best[- ]in[- ]class|state[- ]of[- ]the[- ]art|leverag(e|ing) (the|our)|unleash)\b/gi;
  const stock = [...new Set((body.match(STOCK) || []).map((s) => s.toLowerCase()))];
  const EMOJI = /\p{Extended_Pictographic}/u;
  const emojiIcons = [...document.querySelectorAll('h1, h2, h3, h4, button, li, [class*="icon"]')].filter(
    (el) => visible(el) && EMOJI.test((el.innerText || '').trim().slice(0, 3)),
  ).length;

  // ── Motion and focus ────────────────────────────────────────────────────────────────────────────────────────
  let reduced = false;
  let animated = false;
  let outlineOff = false;
  let focusStyled = false;
  const scan = (rules) => {
    for (const r of rules) {
      if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) reduced = true;
      if (r.type === CSSRule.KEYFRAMES_RULE) animated = true;
      if (r.selectorText) {
        if (/:focus/.test(r.selectorText)) focusStyled = true;
        if (/outline:\s*(none|0)\b/.test(r.cssText) && !/:focus-visible/.test(r.selectorText))
          outlineOff = true;
      }
      if (r.cssRules) scan(r.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      scan(sheet.cssRules);
    } catch {}
  }
  animated = animated || document.getAnimations().length > 0;

  return {
    viewport,
    width: W,
    height: H,
    pageHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
    title: document.title.trim(),
    lang: doc.getAttribute('lang') || '',
    viewportMeta: meta('viewport'),
    description: meta('description'),
    background: getComputedStyle(document.body || doc).backgroundColor,
    colorScheme: getComputedStyle(doc).colorScheme,
    sideways,
    scrollWidth: doc.scrollWidth,
    overflow,
    contrast: contrast.slice(0, MAX),
    contrastCount: contrast.length,
    textCount: texts.length,
    unchecked,
    small: small.slice(0, MAX),
    smallCount: small.length,
    longLines: longLines.slice(0, MAX),
    families: [...families.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f),
    unnamed: unnamed.slice(0, MAX),
    unnamedCount: unnamed.length,
    unlabelled: unlabelled.slice(0, MAX),
    targets: targets.slice(0, MAX),
    targetCount: targets.length,
    noAlt: noAlt.slice(0, MAX),
    noAltCount: noAlt.length,
    broken: broken.slice(0, MAX),
    heavy: heavy.slice(0, MAX),
    images: imgs.length,
    h1: headings.filter((h) => h.tagName === 'H1').length,
    skips: skips.slice(0, MAX),
    placeholder: PLACEHOLDER.test(body),
    standIn: (STAND_IN.exec(body) || [''])[0],
    stock,
    emojiIcons,
    words: body.split(/\s+/).filter(Boolean).length,
    animated,
    reduced,
    outlineOff,
    focusStyled,
  };
};
