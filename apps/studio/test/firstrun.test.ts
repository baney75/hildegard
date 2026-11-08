// SPDX-License-Identifier: AGPL-3.0-only
import { type HfState, loadCatalog, type ModelState } from '@hildegard/presets';
import { describe, expect, it } from 'vitest';
import { firstPick } from '../src/lib/firstrun.ts';

const { catalog } = loadCatalog();
const videos = catalog.models.filter((m) => m.kind !== 'image');

/** Every video model, not installed, with the fit given per id (unknown when left out). */
function states(
  fit: Record<string, ModelState['fit']> = {},
  extra: Record<string, Partial<ModelState>> = {},
) {
  return catalog.models.map(
    (m): ModelState => ({
      id: m.id,
      installed: false,
      missingBytes: 1e9,
      downloading: null,
      gated: m.gated,
      licenseAccepted: false,
      fit: fit[m.id] ?? null,
      fitWhy: fit[m.id] === 'no' ? 'memory' : null,
      error: null,
      ...extra[m.id],
    }),
  );
}
const unlinked: HfState = { linked: false, user: null, storage: null, oauth: true };
const linked: HfState = { ...unlinked, linked: true, user: 'ann' };
const fitsAll = Object.fromEntries(videos.map((m) => [m.id, 'fits' as const]));
const smallest = [...videos].sort((a, b) => a.minVramGb - b.minVramGb)[0]!;
const gated = videos.find((m) => m.gated)!;
const open = videos.filter((m) => !m.gated);

describe('the first model to offer', () => {
  it('is the smallest that downloads now when the GPU is unknown', () => {
    const p = firstPick(catalog, states(), unlinked)!;
    expect(p.model.id).toBe(smallest.id);
    expect(p.needsLink).toBe(false);
    expect(p.why).toBe(`Runs on a ${smallest.minVramGb} GB GPU or more`);
  });

  it('is the newest that fits and downloads without Hugging Face', () => {
    const p = firstPick(catalog, states(fitsAll), unlinked)!;
    expect(p.model.id).toBe(open[0]!.id);
    expect(p.why).toBe('Fits this computer’s GPU');
  });

  it('is the newest that fits once Hugging Face is linked, gated or not', () => {
    expect(firstPick(catalog, states(fitsAll), linked)!.model.id).toBe(videos[0]!.id);
  });

  it('asks for Hugging Face when only a gated model fits', () => {
    const fit = Object.fromEntries(videos.map((m) => [m.id, m.id === gated.id ? 'fits' : 'no'] as const));
    const p = firstPick(catalog, states(fit), unlinked)!;
    expect(p.model.id).toBe(gated.id);
    expect(p.needsLink).toBe(true);
  });

  it('keeps one already downloading, over a better fit', () => {
    const last = videos.at(-1)!;
    const p = firstPick(
      catalog,
      states(fitsAll, { [last.id]: { downloading: { done: 1, total: 2, file: 'x', bytesPerSec: 1 } } }),
      linked,
    )!;
    expect(p.model.id).toBe(last.id);
    expect(p.why).toBe('Downloading now');
  });

  it('is none when no video model runs here, so the welcome offers another device', () => {
    const none = Object.fromEntries(videos.map((m) => [m.id, 'no' as const]));
    expect(firstPick(catalog, states(none), linked)).toBeNull();
  });
});
