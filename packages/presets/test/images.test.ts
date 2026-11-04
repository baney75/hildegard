// SPDX-License-Identifier: Apache-2.0
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Catalog,
  type Character,
  composeCharacterStill,
  composeImage,
  composeKeyframe,
  ImageRequest,
  loadCatalog,
  lockKey,
  PresetError,
  pickCharacterModel,
  pickStillModel,
  referencesOf,
} from '../src/index.ts';

const { catalog, lock } = loadCatalog();
const upload = (n: number) => `${String(n).repeat(64).slice(0, 64)}.png`;
const request = (over: Record<string, unknown> = {}) =>
  ImageRequest.parse({ prompt: 'A cellist in an empty chapel', noRealPerson: true, ...over });
const refs = (n: number) => Array.from({ length: n }, (_, i) => upload(i + 1));
const stills = catalog.models.filter((m) => m.kind === 'image');

const mara = (files: number): Character => ({
  id: 'a1b2c3d4e5f60718',
  name: 'Mara',
  description: 'Early thirties, auburn side braid',
  wardrobe: 'an undyed linen shirt',
  references: Array.from({ length: files }, (_, i) => ({
    file: upload(i + 1),
    view: (['portrait', 'full-body', 'three-quarter', 'profile'] as const)[i % 4]!,
    source: 'still' as const,
    addedAt: '2026-10-24T00:00:00Z',
  })),
  cover: null,
  voice: null,
  likeness: 'invented',
  consent: null,
  createdAt: '2026-10-24T00:00:00Z',
  updatedAt: '2026-10-24T00:00:00Z',
});

/** The same catalog with the stills models in this order of ids. */
const reordered = (...first: string[]): Catalog => ({
  ...catalog,
  models: [
    ...catalog.models.filter((m) => m.kind !== 'image'),
    ...first.map((id) => catalog.models.find((m) => m.id === id)!),
    ...stills.filter((m) => !first.includes(m.id)),
  ],
});

describe('stills models in the catalog', () => {
  it('ships FLUX.2 [klein] first, then three more Apache-2.0 models', () => {
    expect(stills.map((m) => m.id)).toEqual([
      'flux-2-klein-4b',
      'z-image-turbo',
      'qwen-image-2512',
      'qwen-image-edit-2511',
    ]);
    expect(stills.every((m) => m.license === 'Apache-2.0' && !m.gated)).toBe(true);
    expect(stills.map(referencesOf)).toEqual([4, 0, 0, 3]);
    expect(pickStillModel(catalog).id).toBe('flux-2-klein-4b');
  });

  it('pins every file of every stills model by revision and SHA-256', () => {
    for (const m of stills)
      for (const f of m.files) {
        const pin = lock.files[lockKey(f)];
        expect(pin, `${m.id}: ${lockKey(f)}`).toBeDefined();
        expect(pin!.revision).toMatch(/^[0-9a-f]{40}$/);
        expect(pin!.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(pin!.size).toBeGreaterThan(0);
      }
  });

  it('lists a file two models share under one name, with one hash, so it downloads once', () => {
    // The downloader keeps a file at <dir>/<file name>, so two models naming the same file share it.
    const byName = new Map<string, Set<string>>();
    for (const m of stills)
      for (const f of m.files) {
        const k = `${f.dir}/${basename(f.path)}`;
        const pin = lock.files[lockKey(f)]!;
        byName.set(k, (byName.get(k) ?? new Set()).add(`${pin.sha256}:${pin.size}`));
      }
    expect(byName.get('text_encoders/qwen_3_4b.safetensors')?.size).toBe(1);
    expect(byName.get('text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors')?.size).toBe(1);
    expect(byName.get('vae/qwen_image_vae.safetensors')?.size).toBe(1);
    for (const [name, hashes] of byName) expect(hashes.size, name).toBe(1);
  });
});

describe('references in an image request', () => {
  it('refuses references for a model that draws from words only, and names who edits', () => {
    for (const model of ['z-image-turbo', 'qwen-image-2512']) {
      const e = (() => {
        try {
          composeImage(catalog, request({ model, references: refs(1) }));
        } catch (x) {
          return x;
        }
      })();
      expect(e).toBeInstanceOf(PresetError);
      expect((e as PresetError).field).toBe('references');
      expect((e as PresetError).message).toMatch(
        /draws from words only\. Pick FLUX\.2 \[klein\] 4B or Qwen-Image-Edit 2511 to edit images\./,
      );
    }
  });

  it('refuses more references than a model reads, and accepts up to what it reads', () => {
    expect(() =>
      composeImage(catalog, request({ model: 'qwen-image-edit-2511', references: refs(4) })),
    ).toThrow(/reads up to 3 reference images, and you gave 4\. Use fewer\. Pick FLUX\.2 \[klein\] 4B\./);
    expect(
      composeImage(catalog, request({ model: 'qwen-image-edit-2511', references: refs(3) })).references,
    ).toHaveLength(3);
    expect(composeImage(catalog, request({ references: refs(4) })).references).toHaveLength(4);
    // Words alone are always fine, and the default model is klein.
    expect(composeImage(catalog, request({ model: 'z-image-turbo' })).model.id).toBe('z-image-turbo');
    expect(composeImage(catalog, request({ references: refs(2) })).model.id).toBe('flux-2-klein-4b');
  });

  it('says when no model reads that many', () => {
    const only: Catalog = {
      ...catalog,
      models: catalog.models.filter((m) => m.id !== 'flux-2-klein-4b' && m.id !== 'qwen-image-edit-2511'),
    };
    expect(() => composeImage(only, request({ model: 'z-image-turbo', references: refs(1) }))).toThrow(
      /draws from words only\. No model here edits images\./,
    );
  });

  it('sizes each model’s image from its own quality', () => {
    const z = composeImage(catalog, request({ model: 'z-image-turbo' }));
    expect(z).toMatchObject({ steps: 8, cfg: 1, width: 1024, height: 1024 });
    const q = composeImage(catalog, request({ model: 'qwen-image-2512', quality: 'draft' }));
    expect(q).toMatchObject({ steps: 25, cfg: 4 });
  });
});

describe('characters keep to a model that reads references', () => {
  it('picks the first such model, whatever is listed before it', () => {
    const c = reordered('z-image-turbo', 'qwen-image-2512', 'qwen-image-edit-2511', 'flux-2-klein-4b');
    expect(pickStillModel(c).id).toBe('z-image-turbo');
    expect(pickCharacterModel(c).id).toBe('qwen-image-edit-2511');
    expect(composeCharacterStill(c, mara(3), 'portrait').model.id).toBe('qwen-image-edit-2511');
    const first = reordered('z-image-turbo', 'flux-2-klein-4b');
    expect(composeCharacterStill(first, mara(3), 'portrait').model.id).toBe('flux-2-klein-4b');
    expect(composeCharacterStill(first, mara(3), 'portrait').references).toHaveLength(3);
    const shot = { action: 'She lifts the lid', look: 'dawn light', aspect: { width: 16, height: 9 } };
    expect(composeKeyframe(first, shot, [mara(2)]).model.id).toBe('flux-2-klein-4b');
  });

  it('in the shipped catalog, still draws characters with FLUX.2 [klein]', () => {
    expect(composeCharacterStill(catalog, mara(4), 'full-body').model.id).toBe('flux-2-klein-4b');
  });

  it('gives a model named outright no more references than it reads', () => {
    const z = composeCharacterStill(catalog, mara(4), 'portrait', { model: 'z-image-turbo' });
    expect(z.references).toEqual([]);
    expect(z.prompt).not.toMatch(/same person as in reference/);
    expect(
      composeCharacterStill(catalog, mara(4), 'portrait', { model: 'qwen-image-edit-2511' }).references,
    ).toHaveLength(3);
  });

  it('refuses a catalog with no stills model that reads references', () => {
    const none: Catalog = {
      ...catalog,
      models: catalog.models.filter((m) => m.id !== 'flux-2-klein-4b' && m.id !== 'qwen-image-edit-2511'),
    };
    expect(() =>
      composeKeyframe(none, { action: 'x', look: 'y', aspect: { width: 16, height: 9 } }, [mara(1)]),
    ).toThrow(PresetError);
  });
});
