// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accentNote,
  applyTheme,
  contrast,
  nudgeLightness,
  type Palette,
  PRESETS,
  parseAccent,
  readAccent,
  readPreset,
  readThemeMode,
  resolveAccent,
  setAccent,
  setThemeMode,
  setThemePreset,
  type Theme,
} from '../src/lib/theme-core.ts';

const root = join(import.meta.dirname, '..', 'src', 'styles');
const themes: Theme[] = ['dark', 'light'];
const AA = 4.5;
const grounds = (p: Palette) => [p.canvas, p.panel, p.raised];

/** A token's value in one of the stylesheets' `[data-theme]` blocks, as the Studio ships it. */
function token(file: string, theme: Theme, name: string): string {
  const css = readFileSync(join(root, file), 'utf8');
  const block = css
    .split('\n')
    .filter((l) =>
      (theme === 'dark' ? /^:root,\[data-theme="dark"\]\{/ : /^\[data-theme="light"\]\{/).test(l),
    )[0]!;
  const m = new RegExp(`--${name}:(#[0-9a-fA-F]+)[;}]`).exec(block);
  if (!m) throw new Error(`--${name} not found for ${theme} in ${file}`);
  return m[1]!;
}

describe('theme presets', () => {
  it('offers four to six presets, hildegard first and the default', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(4);
    expect(PRESETS.length).toBeLessThanOrEqual(6);
    expect(PRESETS[0]!.id).toBe('hildegard');
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it('keeps the existing look as the hildegard preset, token for token', () => {
    const p = PRESETS[0]!;
    for (const t of themes) {
      const v = (name: string) => token('base.css', t, name);
      expect(p[t]).toEqual({
        canvas: v('canvas'),
        panel: v('panel'),
        raised: v('raised'),
        hairline: v('hairline'),
        borderControl: v('border-control'),
        textPrimary: v('text-primary'),
        textSecondary: v('text-secondary'),
        textMuted: v('text-muted'),
        textFaint: token('cinema.css', t, 'text-faint'),
        brand: v('brand'),
        onBrand: v('on-brand'),
        brandText: v('brand-text'),
      });
    }
  });

  for (const preset of PRESETS)
    for (const t of themes)
      describe(`${preset.id} ${t}`, () => {
        const p = preset[t];
        const sapphireDeep = token('base.css', t, 'sapphire-deep');

        it('reads body text at AA on every surface', () => {
          for (const g of [...grounds(p), sapphireDeep]) {
            expect(contrast(p.textPrimary, g), `text-primary on ${g}`).toBeGreaterThanOrEqual(AA);
            expect(contrast(p.textMuted, g), `text-muted on ${g}`).toBeGreaterThanOrEqual(AA);
          }
          for (const g of grounds(p)) {
            expect(contrast(p.textSecondary, g), `text-secondary on ${g}`).toBeGreaterThanOrEqual(AA);
            expect(contrast(p.textFaint, g), `text-faint on ${g}`).toBeGreaterThanOrEqual(AA);
          }
        });

        it('reads the on-accent text on the accent at AA', () => {
          expect(contrast(p.onBrand, p.brand)).toBeGreaterThanOrEqual(AA);
        });

        it('reads accent text and icons at AA on every surface', () => {
          for (const g of grounds(p)) expect(contrast(p.brandText, g)).toBeGreaterThanOrEqual(AA);
        });

        it('keeps control borders at 3:1 on panel and raised', () => {
          for (const g of [p.panel, p.raised]) expect(contrast(p.borderControl, g)).toBeGreaterThanOrEqual(3);
        });

        it('keeps the hues that carry a meaning readable on its surfaces', () => {
          for (const name of [
            'sapphire-text',
            'gold-text',
            'ember-text',
            'burgundy-text',
            'state-idle',
            'state-saved',
          ]) {
            const c = token('base.css', t, name);
            for (const g of grounds(p)) expect(contrast(c, g), `${name} on ${g}`).toBeGreaterThanOrEqual(AA);
          }
        });
      });
});

describe('accent', () => {
  const bad = [
    '#fff',
    'fff',
    '',
    '#12345g',
    '#1234567',
    '#12345678',
    'red',
    ' #112233',
    '#11 223',
    'rgb(0,0,0)',
  ];

  it('accepts #rrggbb in either case and rejects everything else', () => {
    expect(parseAccent('#3A7BD5')).toBe('#3a7bd5');
    expect(parseAccent('#3a7bd5')).toBe('#3a7bd5');
    for (const v of bad) expect(parseAccent(v), v).toBeNull();
    for (const v of [null, undefined, 12, {}]) expect(parseAccent(v)).toBeNull();
  });

  const awkward = [
    '#ffee00',
    '#ff0000',
    '#0000ff',
    '#808080',
    '#000000',
    '#ffffff',
    '#39ff14',
    '#2a0a3a',
    '#7ccda1',
  ];

  it('nudges a failing accent until it reaches 4.5:1 for both its jobs, in every preset and mode', () => {
    let nudged = 0;
    for (const preset of PRESETS)
      for (const t of themes)
        for (const a of awkward) {
          const p = preset[t];
          const r = resolveAccent(a, p);
          expect(contrast(p.onBrand, r.fill), `${preset.id} ${t} fill ${a}`).toBeGreaterThanOrEqual(AA);
          for (const g of grounds(p))
            expect(contrast(r.text, g), `${preset.id} ${t} text ${a}`).toBeGreaterThanOrEqual(AA);
          if (r.fillMoved || r.textMoved) nudged++;
          expect(accentNote(r) !== '').toBe(!!(r.fillMoved || r.textMoved));
        }
    expect(nudged).toBeGreaterThan(20);
  });

  it('leaves an accent that already passes exactly as chosen, and says nothing', () => {
    const p = PRESETS[0]!.dark;
    const r = resolveAccent(p.brandText, { ...p, onBrand: '#000000' });
    expect(r.text).toBe(p.brandText);
    expect(r.textMoved).toBeNull();
    expect(nudgeLightness('#7ccda1', ['#0a0e13'], 'lighter')).toBe('#7ccda1');
  });

  it('moves lightness only: the hue stays, and it moves as little as it can', () => {
    const out = nudgeLightness('#ff0000', ['#0a0e13', '#0f151c', '#151d28'], 'lighter');
    expect(contrast(out, '#151d28')).toBeGreaterThanOrEqual(AA);
    expect(out.slice(1, 3)).toBe('ff');
    // One half point less would not have been enough.
    const r = Number.parseInt(out.slice(3, 5), 16);
    expect(r).toBeLessThan(0x80);
    expect(out).not.toBe('#ffffff');
  });

  it('says which way it moved', () => {
    const r = resolveAccent('#ffee00', PRESETS[0]!.light);
    expect(r.fillMoved).toBe('darker');
    expect(r.textMoved).toBe('darker');
    expect(accentNote(r)).toMatch(/^Your color needed a nudge\. Buttons use a darker #[0-9a-f]{6}/);
  });
});

/** Just enough of a browser for the storage and <html> code: a Map for localStorage and a root that records styles. */
function fakeBrowser(light = false) {
  const store = new Map<string, string>();
  const style = new Map<string, string>();
  const meta: Record<string, string> = { 'color-scheme': 'dark', 'theme-color': '#0a0e13' };
  const rootEl = {
    dataset: {} as Record<string, string>,
    style: {
      colorScheme: '',
      setProperty: (k: string, v: string) => void style.set(k, v),
      removeProperty: (k: string) => void style.delete(k),
    },
  };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: light }) });
  vi.stubGlobal('document', {
    documentElement: rootEl,
    querySelector: (sel: string) => {
      const name = /name="([^"]+)"/.exec(sel)?.[1] as string;
      return {
        setAttribute: (_: string, v: string) => {
          meta[name] = v;
        },
      };
    },
  });
  return { store, style, meta, rootEl };
}

describe('stored look', () => {
  beforeEach(() => void 0);
  afterEach(() => vi.unstubAllGlobals());

  it('still reads the mode an older Studio stored under hildegard.theme', () => {
    const b = fakeBrowser();
    expect(readThemeMode()).toBe('dark');
    for (const v of ['light', 'system', 'dark'] as const) {
      b.store.set('hildegard.theme', v);
      expect(readThemeMode()).toBe(v);
    }
    b.store.set('hildegard.theme', 'mauve');
    expect(readThemeMode()).toBe('dark');
    // With no preset or accent stored, an old Studio’s look is the hildegard preset, untouched.
    b.store.set('hildegard.theme', 'light');
    expect(applyTheme()).toBe('light');
    expect(b.rootEl.dataset).toEqual({ theme: 'light', preset: 'hildegard' });
    expect(b.style.size).toBe(0);
    expect(b.meta['theme-color']).toBe('#f4eedd');
  });

  it('keeps the preset and accent under their own keys and rejects bad values', () => {
    const b = fakeBrowser();
    setThemePreset('nocturne');
    expect(b.store.get('hildegard.themePreset')).toBe('nocturne');
    expect(setAccent('#3A7BD5')).toBe(true);
    expect(b.store.get('hildegard.accent')).toBe('#3a7bd5');
    expect(readPreset()).toBe('nocturne');
    expect(readAccent()).toBe('#3a7bd5');
    expect(setAccent('#fff')).toBe(false);
    expect(setAccent('blue')).toBe(false);
    expect(b.store.get('hildegard.accent')).toBe('#3a7bd5');
    // A stored value that is not a known preset or a valid hex is ignored, not trusted.
    b.store.set('hildegard.themePreset', 'plaid');
    b.store.set('hildegard.accent', 'url(x)');
    expect(readPreset()).toBe('hildegard');
    expect(readAccent()).toBeNull();
    expect(setAccent(null)).toBe(true);
    expect(b.store.has('hildegard.accent')).toBe(false);
  });

  it('puts the preset’s palette on <html>, with the bar color following it', () => {
    const b = fakeBrowser();
    setThemeMode('light');
    setThemePreset('vellum');
    const p = PRESETS.find((x) => x.id === 'vellum')!.light;
    expect(b.rootEl.dataset).toEqual({ theme: 'light', preset: 'vellum' });
    expect(b.style.get('--canvas')).toBe(p.canvas);
    expect(b.style.get('--brand')).toBe(p.brand);
    expect(b.style.get('--focus-ring')).toBe(p.textPrimary);
    expect(b.meta['theme-color']).toBe(p.canvas);
    setThemePreset('hildegard');
    expect(b.style.size).toBe(0);
    expect(b.meta['theme-color']).toBe('#f4eedd');
  });

  it('applies an accent over any preset, held to contrast, and drops it when cleared', () => {
    const b = fakeBrowser();
    setThemePreset('silver');
    setAccent('#ffee00');
    const p = PRESETS.find((x) => x.id === 'silver')!.dark;
    const fill = b.style.get('--brand')!;
    const text = b.style.get('--brand-text')!;
    expect(contrast(p.onBrand, fill)).toBeGreaterThanOrEqual(AA);
    for (const g of grounds(p)) expect(contrast(text, g)).toBeGreaterThanOrEqual(AA);
    setAccent(null);
    expect(b.style.get('--brand')).toBe(p.brand);
    expect(b.style.get('--brand-text')).toBe(p.brandText);
  });

  it('follows the device while the mode is system', () => {
    const b = fakeBrowser(true);
    setThemeMode('system');
    expect(b.rootEl.dataset.theme).toBe('light');
  });
});
