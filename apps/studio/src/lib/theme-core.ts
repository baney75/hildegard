// SPDX-License-Identifier: AGPL-3.0-only
// The Studio's look without React: theme presets, the custom accent, and putting them on <html>. The first-paint
// script (theme-init.ts) bundles this file, so it must stay free of imports from the app.

/** Dark is the default; light is warm vellum; system follows this device. */
export type ThemeMode = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

/** The ground, ink and green fills a preset sets, for one of its two themes. Hues with a meaning stay as they are. */
export interface Palette {
  canvas: string;
  panel: string;
  raised: string;
  hairline: string;
  borderControl: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textFaint: string;
  /** The accent as a fill (primary buttons, selected rows) and the ink that sits on it. */
  brand: string;
  onBrand: string;
  /** The accent as text or an icon stroke on canvas, panel and raised. */
  brandText: string;
}

export interface Preset {
  id: string;
  name: string;
  blurb: string;
  dark: Palette;
  light: Palette;
}

/** The CSS custom property each palette entry sets. */
const VARS: Record<keyof Palette, string> = {
  canvas: '--canvas',
  panel: '--panel',
  raised: '--raised',
  hairline: '--hairline',
  borderControl: '--border-control',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textMuted: '--text-muted',
  textFaint: '--text-faint',
  brand: '--brand',
  onBrand: '--on-brand',
  brandText: '--brand-text',
};
/** Set alongside the palette: the focus ring follows the ink, and the small print on a green button follows its ink. */
const DERIVED = ['--focus-ring', '--on-brand-secondary'] as const;

/**
 * Hildegard's own look, exactly the tokens in base.css and cinema.css (a test holds the two together). Ember is the
 * design system's hue for Force now and nothing else, so no preset takes it for an accent.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: 'hildegard',
    name: 'Hildegard',
    blurb: 'Ink and viriditas green, as it opens.',
    dark: {
      canvas: '#0a0e13',
      panel: '#0f151c',
      raised: '#151d28',
      hairline: '#e9dfc61f',
      borderControl: '#7f8794',
      textPrimary: '#f2ecdd',
      textSecondary: '#bcb6a6',
      textMuted: '#97968c',
      textFaint: '#8a8a84',
      brand: '#2c7350',
      onBrand: '#f6f0e1',
      brandText: '#7ccda1',
    },
    light: {
      canvas: '#f4eedd',
      panel: '#faf5e8',
      raised: '#fffcf3',
      hairline: '#2a241824',
      borderControl: '#6f6a5c',
      textPrimary: '#1a1914',
      textSecondary: '#4a4638',
      textMuted: '#615c4e',
      textFaint: '#6b675a',
      brand: '#1f5a3d',
      onBrand: '#f6f0e1',
      brandText: '#1f5a3d',
    },
  },
  {
    id: 'vellum',
    name: 'Vellum',
    blurb: 'Warm parchment and umber, like a scriptorium.',
    dark: {
      canvas: '#120e09',
      panel: '#1a140d',
      raised: '#231b12',
      hairline: '#f3ead81f',
      borderControl: '#857a68',
      textPrimary: '#f3ead8',
      textSecondary: '#c2b8a2',
      textMuted: '#9d9482',
      textFaint: '#8f8676',
      brand: '#8a5a2b',
      onBrand: '#fbf3e2',
      brandText: '#e0b27a',
    },
    light: {
      canvas: '#efe4cc',
      panel: '#f6edd9',
      raised: '#fcf6e6',
      hairline: '#1d171024',
      borderControl: '#6b5f4a',
      textPrimary: '#1d1710',
      textSecondary: '#4a4030',
      textMuted: '#5f5440',
      textFaint: '#6a5f4b',
      brand: '#7a4a1e',
      onBrand: '#fbf3e2',
      brandText: '#7a4a1e',
    },
  },
  {
    id: 'nocturne',
    name: 'Nocturne',
    blurb: 'Midnight blue and sapphire, for late work.',
    dark: {
      canvas: '#070a14',
      panel: '#0c1120',
      raised: '#131a2e',
      hairline: '#eaeefa1f',
      borderControl: '#7a84a3',
      textPrimary: '#eaeefa',
      textSecondary: '#b4bcd4',
      textMuted: '#8f98b4',
      textFaint: '#8790ab',
      brand: '#3451b2',
      onBrand: '#f8f4ea',
      brandText: '#9fb6f7',
    },
    light: {
      canvas: '#e9edf6',
      panel: '#f3f6fb',
      raised: '#fbfcff',
      hairline: '#12151f24',
      borderControl: '#646b82',
      textPrimary: '#12151f',
      textSecondary: '#3c4256',
      textMuted: '#4f566b',
      textFaint: '#5c6378',
      brand: '#23409e',
      onBrand: '#f8f4ea',
      brandText: '#23409e',
    },
  },
  {
    id: 'verdant',
    name: 'Verdant',
    blurb: 'Deep leaf greens by night, soft sage by day.',
    dark: {
      canvas: '#08110c',
      panel: '#0d1a12',
      raised: '#14241a',
      hairline: '#e9f2e61f',
      borderControl: '#76897b',
      textPrimary: '#e9f2e6',
      textSecondary: '#b3c4b4',
      textMuted: '#8fa192',
      textFaint: '#869788',
      brand: '#2c7350',
      onBrand: '#f6f0e1',
      brandText: '#8fe0b0',
    },
    light: {
      canvas: '#e6edd8',
      panel: '#f0f5e3',
      raised: '#f9fcef',
      hairline: '#14190f24',
      borderControl: '#5f6b53',
      textPrimary: '#14190f',
      textSecondary: '#3a4430',
      textMuted: '#4b5640',
      textFaint: '#586349',
      brand: '#1b6b3f',
      onBrand: '#f6f0e1',
      brandText: '#1b6b3f',
    },
  },
  {
    id: 'silver',
    name: 'Silver',
    blurb: 'Graphite and silver, with no color of its own.',
    dark: {
      canvas: '#0d0f11',
      panel: '#14171a',
      raised: '#1c2024',
      hairline: '#eceef01f',
      borderControl: '#7d848e',
      textPrimary: '#eceef0',
      textSecondary: '#b8bdc4',
      textMuted: '#939aa3',
      textFaint: '#8a9099',
      brand: '#c3c8cf',
      onBrand: '#14171a',
      brandText: '#c3c8cf',
    },
    light: {
      canvas: '#e6e8eb',
      panel: '#f0f2f4',
      raised: '#fafbfc',
      hairline: '#14171a24',
      borderControl: '#646a73',
      textPrimary: '#14171a',
      textSecondary: '#3a3f45',
      textMuted: '#4c525a',
      textFaint: '#585e66',
      brand: '#3b4048',
      onBrand: '#f4f5f7',
      brandText: '#3b4048',
    },
  },
];

export const DEFAULT_PRESET = 'hildegard';
export const presetById = (id: string): Preset => PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;

// ── Colour maths ─────────────────────────────────────────────────────────────────────────────────────────────────

/** A hex colour the Studio accepts for an accent: `#` and six digits. Anything else is null. */
export function parseAccent(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

/** What the accent box accepts: `#rrggbb`, or the six digits alone, with spaces around either. */
export function accentFromInput(v: string): string | null {
  const t = v.trim();
  return parseAccent(/^[0-9a-fA-F]{6}$/.test(t) ? `#${t}` : t);
}

const rgb = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (c: [number, number, number]) =>
  `#${c
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** HSL of a `#rrggbb` color: hue in degrees, saturation and lightness 0 to 1. */
export function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgb(hex).map((v) => v / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return [h, s, l];
}

export function fromHsl(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return toHex([(r! + m) * 255, (g! + m) * 255, (b! + m) * 255]);
}

/** How far one nudge step moves HSL lightness: half a point. */
export const NUDGE_STEP = 0.005;

/** A contrast the color must hold against every one of `against`. */
export interface Need {
  against: string[];
  min: number;
}
const meets = (c: string, needs: Need[]) =>
  needs.every((n) => n.against.every((g) => contrast(c, g) >= n.min));

/**
 * Move a color's lightness, half a point at a time and no further than it must, until it holds `min`:1 against every
 * `against` color. Hue and saturation stay. `direction` is the way to move, away from the grounds it is read on.
 * Returns the color unchanged when it already passes.
 */
export function nudgeLightness(
  hex: string,
  against: string[],
  direction: 'lighter' | 'darker',
  min = 4.5,
): string {
  const needs = [{ against, min }];
  if (meets(hex, needs)) return hex;
  const [h, s, l0] = toHsl(hex);
  const step = direction === 'lighter' ? NUDGE_STEP : -NUDGE_STEP;
  let best = hex;
  for (let l = l0 + step; l >= 0 && l <= 1; l += step) {
    best = fromHsl(h, s, l);
    if (meets(best, needs)) return best;
  }
  return best;
}

/**
 * The nearest color, in lightness and on either side of the chosen one, that meets every need; null when no
 * lightness does. Needs that pull in opposite directions (ink on a fill, and the fill against its grounds) leave a
 * band between them, and this finds it.
 */
export function nudgeInto(hex: string, needs: Need[]): string | null {
  if (meets(hex, needs)) return hex;
  const [h, s, l0] = toHsl(hex);
  for (let i = 1; i * NUDGE_STEP <= 1; i++) {
    for (const sign of [1, -1]) {
      const l = l0 + sign * i * NUDGE_STEP;
      if (l < 0 || l > 1) continue;
      const c = fromHsl(h, s, l);
      if (meets(c, needs)) return c;
    }
  }
  return null;
}

export interface AccentResolved {
  /** The accent as a fill: the on-accent ink reads on it at 4.5:1 and it stands out from the grounds at 3:1. */
  fill: string;
  /** The accent as text or an icon stroke, at 4.5:1 or better on canvas, panel and raised. */
  text: string;
  /** Which way the fill and the text moved from the chosen color, if they had to. */
  fillMoved: 'lighter' | 'darker' | null;
  textMoved: 'lighter' | 'darker' | null;
  /**
   * True when no lightness gives both the ink 4.5:1 and the grounds 3:1 (a preset whose ink sits between its grounds
   * and its fills; none of ours). The fill then keeps to the grounds, so it stays visible, and the ink may read less well.
   */
  fillConflict: boolean;
}

const way = (from: string, to: string): 'lighter' | 'darker' | null =>
  from === to ? null : luminance(to) > luminance(from) ? 'lighter' : 'darker';

/** Hold a chosen accent to the contrast its preset needs, nudging lightness only where it falls short. */
export function resolveAccent(accent: string, p: Palette): AccentResolved {
  const grounds = [p.canvas, p.panel, p.raised];
  const darkGround = grounds.every((g) => luminance(g) < 0.18);
  const textWay = darkGround ? 'lighter' : 'darker';
  // WCAG 1.4.11: a selected row or a button shape is told from its ground by 3:1, as well as its ink by 4.5:1.
  const both: Need[] = [
    { against: [p.onBrand], min: 4.5 },
    { against: grounds, min: 3 },
  ];
  const together = nudgeInto(accent, both);
  const fill = together ?? nudgeInto(accent, [both[1]!]) ?? accent;
  const text = nudgeLightness(accent, grounds, textWay);
  return {
    fill,
    text,
    fillMoved: way(accent, fill),
    textMoved: text === accent ? null : textWay,
    fillConflict: together === null,
  };
}

/** The sentence under the accent control when the chosen color had to move; empty when it did not. */
export function accentNote(r: AccentResolved): string {
  const parts: string[] = [];
  if (r.fillMoved)
    parts.push(
      r.fillConflict
        ? `Buttons use ${r.fill} so they stand out from the page; the words on them may be harder to read.`
        : `Buttons use a ${r.fillMoved} ${r.fill}, so they stand out from the page and the words on them stay readable.`,
    );
  if (r.textMoved)
    parts.push(`Accent text and icons use a ${r.textMoved} ${r.text}, so they stay readable on this theme.`);
  return parts.length ? `Your color needed a nudge. ${parts.join(' ')}` : '';
}

// ── Storage ──────────────────────────────────────────────────────────────────────────────────────────────────────

// `hildegard.theme` keeps the mode, as it always has.
const MODE_KEY = 'hildegard.theme';
const PRESET_KEY = 'hildegard.themePreset';
const ACCENT_KEY = 'hildegard.accent';
export const listeners = new Set<() => void>();

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
};

// What was chosen in this page, kept even where storage refuses to hold it (blocked site data, a full quota), so a
// choice still takes effect and reads back until the page closes. It wins over storage, which only this page writes.
const chosen: { mode?: ThemeMode; preset?: string; accent?: string | null } = {};
/** Forget what this page chose (for tests). */
export const forgetChoices = () => {
  delete chosen.mode;
  delete chosen.preset;
  delete chosen.accent;
};

export function readThemeMode(): ThemeMode {
  if (chosen.mode) return chosen.mode;
  const v = read(MODE_KEY);
  return v === 'light' || v === 'system' ? v : 'dark';
}
export const readPreset = (): string => chosen.preset ?? presetById(read(PRESET_KEY) ?? '').id;
export const readAccent = (): string | null =>
  chosen.accent !== undefined ? chosen.accent : parseAccent(read(ACCENT_KEY));

const systemLight = () => window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;

export const resolveTheme = (mode: ThemeMode, light = systemLight()): Theme =>
  mode === 'system' ? (light ? 'light' : 'dark') : mode;

// ── On the page ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Put the look on <html>: the theme and preset as attributes, the preset's palette and the accent as custom
 * properties on the element (the default preset sets none, so base.css stays the truth for it), and the browser's own
 * color scheme and bar color to match.
 */
export function applyTheme(
  mode: ThemeMode = readThemeMode(),
  presetId: string = readPreset(),
  accent: string | null = readAccent(),
): Theme {
  const theme = resolveTheme(mode);
  const preset = presetById(presetId);
  const palette = preset[theme];
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.preset = preset.id;
  root.style.colorScheme = theme;
  const set = (name: string, value: string | null) =>
    value === null ? root.style.removeProperty(name) : root.style.setProperty(name, value);
  const custom = preset.id !== DEFAULT_PRESET;
  for (const k of Object.keys(VARS) as (keyof Palette)[]) set(VARS[k], custom ? palette[k] : null);
  set(DERIVED[0], custom ? palette.textPrimary : null);
  set(DERIVED[1], custom ? palette.onBrand : null);
  if (accent) {
    const r = resolveAccent(accent, palette);
    set(VARS.brand, r.fill);
    set(VARS.brandText, r.text);
  }
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.canvas);
  return theme;
}

const notify = () => {
  for (const l of listeners) l();
};

export function setThemeMode(mode: ThemeMode) {
  chosen.mode = mode;
  write(MODE_KEY, mode);
  applyTheme(mode, readPreset(), readAccent());
  notify();
}

export function setThemePreset(id: string) {
  const preset = presetById(id).id;
  chosen.preset = preset;
  write(PRESET_KEY, preset);
  applyTheme(readThemeMode(), preset, readAccent());
  notify();
}

/** Keep a custom accent (`#rrggbb`), or clear it with null. Returns false, and changes nothing, for anything else. */
export function setAccent(value: string | null): boolean {
  const hex = value === null ? null : parseAccent(value);
  if (value !== null && hex === null) return false;
  chosen.accent = hex;
  write(ACCENT_KEY, hex);
  applyTheme(readThemeMode(), readPreset(), hex);
  notify();
  return true;
}
