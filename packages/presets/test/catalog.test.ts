// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import {
  composeShot,
  frameCount,
  frameSize,
  loadCatalog,
  mergePost,
  parseCatalog,
  ShotRequest,
  takeSeeds,
} from '../src/index.ts';

const { catalog } = loadCatalog();
const req = (over: Record<string, unknown> = {}) =>
  ShotRequest.parse({
    prompt: 'A beekeeper lifts the lid of a hive at dawn',
    rig: { body: 'full-frame', lens: 'anamorphic', focal: 35, aperture: 2 },
    ...over,
  });

describe('catalog', () => {
  it('loads and cross-checks the shipped presets', () => {
    expect(catalog.motions.length).toBeGreaterThanOrEqual(20);
    expect(catalog.models.map((m) => m.id)).toContain('ltx-2-5-distilled');
  });

  it('rejects a motion that points at a LoRA the model lacks', () => {
    const bad = `version = 1
durations = [5]
bodies = [{ id = "a", name = "A", blurb = "a", prompt = "a" }]
lenses = [{ id = "a", name = "A", blurb = "a", prompt = "a" }]
focals = [{ mm = 35, label = "N", prompt = "35" }]
motions = [{ id = "m", name = "M", category = "push", prompt = "p", path = "M0 0", impl = { x = { kind = "lora", lora = "nope" } } }]
lightings = [{ id = "a", name = "A", blurb = "a", prompt = "a" }]
palettes = [{ id = "a", name = "A", blurb = "a", prompt = "a", colors = ["#000000","#000000","#000000","#000000","#000000"] }]
genres = [{ id = "a", name = "A", prompt = "a" }]
eras = [{ id = "a", name = "A", prompt = "a" }]
aspects = [{ id = "16:9", name = "W", width = 1280, height = 720 }]`;
    const models = `[[models]]
id = "x"
name = "X"
family = "x"
blurb = "x"
license = "x"
licenseUrl = "https://example.com"
terms = ["x"]
graph = "ltx-2-distilled"
minVramGb = 1
fps = 24
frameMultiple = 8
maxSeconds = 5
audio = false
draft = { height = 512, steps = 8, cfg = 1 }
final = { height = 1024, steps = 8, cfg = 1 }
files = []`;
    expect(() => parseCatalog(bad, models, '{"version":1,"files":{}}')).toThrow(/needs LoRA "nope"/);
  });
});

describe('composeShot', () => {
  it('writes action, camera, rig and look in order', () => {
    const shot = composeShot(
      catalog,
      req({
        motion: [{ id: 'dolly-in' }],
        look: { lighting: 'golden-hour', palette: 'honey-moss', genre: 'pastoral' },
      }),
    );
    expect(shot.prompt).toMatch(
      /^A beekeeper lifts the lid of a hive at dawn\. The camera slowly dollies in/,
    );
    expect(shot.prompt).toContain('vintage anamorphic lens');
    expect(shot.prompt).toContain('f/2.0, very shallow depth of field');
    expect(shot.prompt).toContain('Golden hour light');
    expect(shot.summary).toBe('Full-frame cinema · Vintage anamorphic · 35mm · f/2.0');
  });

  it('says the camera holds when no motion is picked', () => {
    expect(composeShot(catalog, req()).prompt).toContain('The camera holds steady');
  });

  it('uses the LoRA recipe on LTX-2 and the prompt on LTX-2.5', () => {
    const a = composeShot(catalog, req({ model: 'ltx-2-distilled', motion: [{ id: 'crane-up' }] }));
    expect(a.motions[0]!.impl).toEqual({ kind: 'lora', lora: 'camera-jib-up', strength: 1 });
    const b = composeShot(catalog, req({ model: 'ltx-2-5-distilled', motion: [{ id: 'crane-up' }] }));
    expect(b.motions[0]!.impl).toEqual({ kind: 'prompt' });
  });

  it('sizes frames for each quality', () => {
    const draft = composeShot(catalog, req({ format: { aspect: '16:9', seconds: 5, quality: 'draft' } }));
    expect([draft.width, draft.height, draft.twoStage]).toEqual([960, 544, false]);
    const fin = composeShot(catalog, req({ format: { aspect: '2.39:1', seconds: 5, quality: 'final' } }));
    expect(fin.width % 64).toBe(0);
    expect(fin.height % 64).toBe(0);
    expect(fin.frames).toBe(121);
  });

  it('names the field when a preset is unknown', () => {
    expect(() =>
      composeShot(catalog, req({ rig: { body: 'nope', lens: 'clean', focal: 35, aperture: 2 } })),
    ).toThrow(expect.objectContaining({ field: 'rig.body' }));
  });

  it('refuses more than two motions', () => {
    expect(() => req({ motion: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })).toThrow(/up to two/);
  });
});

describe('helpers', () => {
  it('frame counts are 8n+1', () => {
    for (const s of [1, 3, 5, 8, 10]) expect((frameCount(24, s, 8) - 1) % 8).toBe(0);
  });
  it('frame sizes are multiples of 32', () => {
    const s = frameSize({ width: 1280, height: 720 }, 544, false);
    expect(s).toEqual({ width: 960, height: 544 });
  });
  it('merges post settings with clamps', () => {
    const p = mergePost({ grain: 0.8 }, { grain: 0.5, saturation: 0.5 }, { saturation: 0.5 });
    expect(p.grain).toBe(1);
    expect(p.saturation).toBe(0.25);
  });
  it('locked seeds count up', () => {
    expect(takeSeeds(3, 10)).toEqual([10, 11, 12]);
    expect(takeSeeds(2, undefined, () => 0.5)).toEqual([2 ** 31, 2 ** 31]);
  });
});
