// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accentFromInput,
  accentNote,
  applyTheme,
  contrast,
  forgetChoices,
  fromHsl,
  nudgeInto,
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
  toHsl,
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

  it('takes the box’s #rrggbb, or bare digits, with spaces around either', () => {
    for (const v of ['#3A7BD5', ' #3a7bd5 ', '3a7bd5', ' 3A7BD5\n'])
      expect(accentFromInput(v), v).toBe('#3a7bd5');
    for (const v of ['', '#3a7bd', '3a7bd', '#3a7bd55', '3a7bd5f', '##3a7bd5', 'blue', '#3a 7bd5']) {
      expect(accentFromInput(v), v).toBeNull();
    }
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
    // Close to a ground: dark presets' canvas, and the vellum and silver grounds of the light ones.
    '#070a14',
    '#0d0f11',
    '#f4eedd',
    '#fffcf3',
    '#fffffe',
    '#e6e8eb',
  ];

  it('nudges a failing accent until it reaches 4.5:1 for both its jobs, in every preset and mode', () => {
    let nudged = 0;
    for (const preset of PRESETS)
      for (const t of themes)
        for (const a of awkward) {
          const p = preset[t];
          const r = resolveAccent(a, p);
          // Both hold for every preset we ship; fillConflict is for a palette whose ink sits between its grounds and fills.
          expect(r.fillConflict, `${preset.id} ${t} ${a}`).toBe(false);
          expect(contrast(p.onBrand, r.fill), `${preset.id} ${t} fill ${a}`).toBeGreaterThanOrEqual(AA);
          for (const g of grounds(p))
            expect(contrast(r.fill, g), `${preset.id} ${t} fill ${a} on ${g}`).toBeGreaterThanOrEqual(3);
          for (const g of grounds(p))
            expect(contrast(r.text, g), `${preset.id} ${t} text ${a}`).toBeGreaterThanOrEqual(AA);
          if (r.fillMoved || r.textMoved) nudged++;
          expect(accentNote(r) !== '').toBe(!!(r.fillMoved || r.textMoved));
        }
    expect(nudged).toBeGreaterThan(40);
  });

  it('leaves an accent that already passes exactly as chosen, and says nothing', () => {
    const p = PRESETS[0]!.dark;
    const r = resolveAccent(p.brandText, { ...p, onBrand: '#000000' });
    expect(r.text).toBe(p.brandText);
    expect(r.textMoved).toBeNull();
    expect(nudgeLightness('#7ccda1', ['#0a0e13'], 'lighter')).toBe('#7ccda1');
  });

  it('moves lightness only: the hue stays, and it moves no further than it must', () => {
    const against = ['#0a0e13', '#0f151c', '#151d28'];
    const out = nudgeLightness('#ff0000', against, 'lighter');
    expect(against.every((g) => contrast(out, g) >= AA)).toBe(true);
    const [h0, s0, l0] = toHsl('#ff0000');
    const [h, s, l] = toHsl(out);
    expect(Math.abs(h - h0)).toBeLessThan(1);
    expect(Math.abs(s - s0)).toBeLessThan(0.02);
    expect(l).toBeGreaterThan(l0);
    // Back one step (and a little more, for the rounding to eight bits) it would fail a ground, so it did not overshoot.
    const back = fromHsl(h, s, l - 0.005 - 0.0025);
    expect(against.some((g) => contrast(back, g) < AA)).toBe(true);
    // A color that needs a nudge toward dark moves only that way.
    const dark = nudgeLightness('#ffee00', ['#f4eedd', '#faf5e8', '#fffcf3'], 'darker');
    const [, , ld] = toHsl(dark);
    expect(ld).toBeLessThan(toHsl('#ffee00')[2]);
    expect(
      ['#f4eedd', '#faf5e8', '#fffcf3'].some(
        (g) =>
          contrast(fromHsl(...(toHsl(dark).slice(0, 2) as [number, number]), ld + 0.005 + 0.0025), g) < AA,
      ),
    ).toBe(true);
  });

  it('finds the nearest lightness that meets needs pulling both ways, or says there is none', () => {
    const needs = [
      { against: ['#f8f4ea'], min: 4.5 },
      { against: ['#070a14', '#0c1120', '#131a2e'], min: 3 },
    ];
    for (const a of ['#000000', '#ffffff', '#ffee00']) {
      const c = nudgeInto(a, needs)!;
      expect(c, a).not.toBeNull();
      expect(contrast(c, '#f8f4ea')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(c, '#131a2e')).toBeGreaterThanOrEqual(3);
    }
    // Ink in the middle: no lightness is 4.5:1 from it and 3:1 from dark grounds.
    expect(nudgeInto('#ff0000', [{ against: ['#989898'], min: 4.5 }, needs[1]!])).toBeNull();
  });

  it('keeps a fill visible against its grounds when the ink and the grounds conflict, and says so', () => {
    const p: Palette = { ...PRESETS[2]!.dark, onBrand: '#989898' };
    const r = resolveAccent('#000000', p);
    expect(r.fillConflict).toBe(true);
    for (const g of grounds(p)) expect(contrast(r.fill, g)).toBeGreaterThanOrEqual(3);
    expect(accentNote(r)).toContain('may be harder to read');
  });

  it('says which way it moved', () => {
    const r = resolveAccent('#ffee00', PRESETS[0]!.light);
    expect(r.fillMoved).toBe('darker');
    expect(r.textMoved).toBe('darker');
    expect(accentNote(r)).toMatch(
      /^Your color needed a nudge\. Buttons use a darker #[0-9a-f]{6}, so they stand out/,
    );
  });
});

/** Just enough of a browser for the storage and <html> code: a Map for localStorage and a root that records styles. */
function fakeBrowser(light = false, storage: 'works' | 'cannot write' | 'blocked' = 'works') {
  forgetChoices();
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
  const refuse = () => {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (storage === 'blocked' ? refuse() : (store.get(k) ?? null)),
    setItem: (k: string, v: string) => (storage === 'works' ? void store.set(k, v) : refuse()),
    removeItem: (k: string) => (storage === 'works' ? void store.delete(k) : refuse()),
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
    forgetChoices();
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

  for (const storage of ['cannot write', 'blocked'] as const)
    it(`still changes the page when storage ${storage === 'blocked' ? 'is blocked' : 'cannot be written'}`, () => {
      const b = fakeBrowser(false, storage);
      setThemeMode('light');
      expect(b.rootEl.dataset.theme).toBe('light');
      expect(readThemeMode()).toBe('light');
      setThemePreset('vellum');
      const p = PRESETS.find((x) => x.id === 'vellum')!.light;
      expect(b.rootEl.dataset).toEqual({ theme: 'light', preset: 'vellum' });
      expect(b.style.get('--canvas')).toBe(p.canvas);
      expect(readPreset()).toBe('vellum');
      expect(setAccent('#3a7bd5')).toBe(true);
      expect(readAccent()).toBe('#3a7bd5');
      expect(b.style.get('--brand')).toBe(resolveAccent('#3a7bd5', p).fill);
      // Each choice keeps the others: the mode and preset were not lost by the accent.
      expect(b.rootEl.dataset).toEqual({ theme: 'light', preset: 'vellum' });
      expect(setAccent(null)).toBe(true);
      expect(readAccent()).toBeNull();
      expect(b.style.get('--brand')).toBe(p.brand);
      setThemeMode('dark');
      expect(b.rootEl.dataset.theme).toBe('dark');
      expect(b.store.size).toBe(0);
    });

  it('follows the device while the mode is system', () => {
    const b = fakeBrowser(true);
    setThemeMode('system');
    expect(b.rootEl.dataset.theme).toBe('light');
  });
});
