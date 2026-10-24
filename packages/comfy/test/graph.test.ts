// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Character,
  composeCharacterStill,
  composeShot,
  loadCatalog,
  loadSafety,
  ShotRequest,
  videoModels,
} from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeProxy, startFakeProxy } from '../src/fake-proxy.ts';
import {
  buildGraph,
  buildLtxGraph,
  buildStillGraph,
  ComfySdkEngine,
  catalogFiles,
  checkLinks,
  classifyFailure,
  EngineError,
  GRAPH_NODE_CLASSES,
  graphSafety,
  progressOf,
  vetGraph,
} from '../src/index.ts';

const { catalog } = loadCatalog();
const character = (id: string, refs: number, over: Partial<Character> = {}): Character => ({
  id,
  name: 'Mara',
  description: 'Early thirties, auburn side braid, light freckles',
  wardrobe: 'an undyed linen shirt and canvas apron',
  references: Array.from({ length: refs }, (_, i) => ({
    file: `${String(i).repeat(64).slice(0, 64)}.png`,
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
  ...over,
});
const mara = character('a1b2c3d4e5f60718', 3);
const konrad = character('b1b2c3d4e5f60718', 2, {
  name: 'Brother Konrad',
  description: 'A tall monk',
  wardrobe: '',
});
const shot = (over: Record<string, unknown> = {}, cast: Character[] = []) =>
  composeShot(
    catalog,
    ShotRequest.parse({
      prompt: 'A lighthouse keeper climbs the spiral stairs',
      rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
      ...over,
      ...(cast.length ? { characters: cast.map((c) => c.id) } : {}),
    }),
    cast,
  );
const classes = (g: Record<string, { class_type: string }>) => Object.values(g).map((n) => n.class_type);

describe('buildWanGraph', () => {
  const wan = (over: Record<string, unknown> = {}) => shot({ model: 'wan-2-2-ti2v-5b', ...over });

  it('renders final quality in one pass at 704p, silent, with 4n+1 frames', () => {
    const { graph, outputNode } = buildGraph({ shot: wan(), seed: 9, prefix: 'p' });
    expect(checkLinks(graph)).toEqual([]);
    expect(classes(graph)).toEqual(
      expect.arrayContaining([
        'UNETLoader',
        'ModelSamplingSD3',
        'Wan22ImageToVideoLatent',
        'KSampler',
        'HildegardLook',
      ]),
    );
    expect(classes(graph).some((c) => c.startsWith('LTX'))).toBe(false);
    const latent = Object.values(graph).find((n) => n.class_type === 'Wan22ImageToVideoLatent')!;
    expect(latent.inputs).toMatchObject({ height: 704, width: 1248 });
    expect((Number(latent.inputs.length) - 1) % 4).toBe(0);
    expect(Object.values(graph).find((n) => n.class_type === 'KSampler')!.inputs).toMatchObject({
      steps: 30,
      cfg: 5,
      seed: 9,
    });
    expect(Object.values(graph).find((n) => n.class_type === 'CreateVideo')!.inputs.audio).toBeUndefined();
    expect(graph[outputNode]!.class_type).toBe('SaveVideo');
  });

  it('caps a take at the model’s 5 seconds and feeds a start frame into the latent', () => {
    const s = wan({ format: { aspect: '16:9', seconds: 10, quality: 'draft' } });
    expect(s.seconds).toBe(5);
    expect(s.frames).toBe(121);
    const { graph, startFrameNode } = buildGraph({ shot: s, seed: 1, prefix: 'p', startFrame: 'f.png' });
    expect(graph[startFrameNode!]!.class_type).toBe('LoadImage');
    const latent = Object.values(graph).find((n) => n.class_type === 'Wan22ImageToVideoLatent')!;
    expect(Array.isArray(latent.inputs.start_image)).toBe(true);
    expect(latent.inputs.height).toBe(480);
  });
});

describe('buildLtxGraph', () => {
  it('builds a two-stage LTX-2.5 text-to-video graph with sound and the film look', () => {
    const { graph, outputNode, startFrameNode } = buildLtxGraph({
      shot: shot(),
      seed: 7,
      prefix: 'hildegard/x',
    });
    expect(checkLinks(graph)).toEqual([]);
    expect(classes(graph)).toEqual(
      expect.arrayContaining([
        'UNETLoader',
        'LTXVLatentUpsampler',
        'LTXVAudioVAEDecode',
        'HildegardLook',
        'SaveVideo',
      ]),
    );
    expect(classes(graph).filter((c) => c === 'SamplerCustomAdvanced')).toHaveLength(2);
    expect(graph[outputNode]!.class_type).toBe('SaveVideo');
    expect(startFrameNode).toBeUndefined();
    const empty = Object.values(graph).find((n) => n.class_type === 'EmptyLTXVLatentVideo')!;
    expect(empty.inputs).toMatchObject({ width: 960, height: 544, length: 121 });
    const look = Object.values(graph).find((n) => n.class_type === 'HildegardLook')!;
    expect(look.inputs.grain).toBeGreaterThan(0.4);
  });

  it('runs one stage at full size for drafts', () => {
    const { graph } = buildLtxGraph({
      shot: shot({ format: { aspect: '16:9', seconds: 3, quality: 'draft' } }),
      seed: 1,
      prefix: 'p',
    });
    expect(classes(graph)).not.toContain('LTXVLatentUpsampler');
    expect(Object.values(graph).find((n) => n.class_type === 'EmptyLTXVLatentVideo')!.inputs).toMatchObject({
      width: 960,
      height: 544,
      length: 73,
    });
  });

  it('stacks camera LoRAs on LTX-2, scaled by strength', () => {
    const { graph } = buildLtxGraph({
      shot: shot({
        model: 'ltx-2-distilled',
        motion: [
          { id: 'dolly-in', strength: 0.5 },
          { id: 'crane-up', strength: 1 },
        ],
      }),
      seed: 1,
      prefix: 'p',
    });
    expect(checkLinks(graph)).toEqual([]);
    const loras = Object.values(graph).filter((n) => n.class_type === 'LoraLoaderModelOnly');
    expect(loras.map((l) => [l.inputs.lora_name, l.inputs.strength_model])).toEqual([
      ['ltx-2-19b-lora-camera-control-dolly-in.safetensors', 0.5],
      ['ltx-2-19b-lora-camera-control-jib-up.safetensors', 1],
    ]);
  });

  it('conditions on a start frame in both stages', () => {
    const { graph, startFrameNode } = buildLtxGraph({
      shot: shot(),
      seed: 1,
      prefix: 'p',
      startFrame: 'a.png',
    });
    expect(graph[startFrameNode!]!.class_type).toBe('LoadImage');
    expect(classes(graph).filter((c) => c === 'LTXVImgToVideoInplace')).toHaveLength(2);
  });
});

describe('characters', () => {
  const byClass = (g: Record<string, { class_type: string; inputs: Record<string, unknown> }>, cls: string) =>
    Object.entries(g).filter(([, n]) => n.class_type === cls);

  it('draws a portrait with FLUX.2 [klein]: four steps, no references for a new character, saved as a PNG', () => {
    const still = composeCharacterStill(catalog, character('c1b2c3d4e5f60718', 0), 'portrait');
    expect(still.model.id).toBe('flux-2-klein-4b');
    expect(still).toMatchObject({ width: 1024, height: 1024, steps: 4, cfg: 1, references: [] });
    expect(still.prompt).toMatch(/^Character reference photograph of Mara, Early thirties/);
    expect(still.prompt).toMatch(/wearing an undyed linen shirt/);
    const b = buildStillGraph({ still, seed: 7, prefix: 'hildegard/s1' });
    expect(checkLinks(b.graph)).toEqual([]);
    expect(b.output).toBe('image');
    expect(b.referenceNodes).toEqual([]);
    expect(b.graph[b.outputNode]).toMatchObject({
      class_type: 'SaveImage',
      inputs: { filename_prefix: 'hildegard/s1' },
    });
    expect(byClass(b.graph, 'CLIPLoader')[0]![1]).toMatchObject({ inputs: { type: 'flux2' } });
    expect(byClass(b.graph, 'Flux2Scheduler')[0]![1]).toMatchObject({
      inputs: { steps: 4, width: 1024, height: 1024 },
    });
    expect(byClass(b.graph, 'RandomNoise')[0]![1]).toMatchObject({ inputs: { noise_seed: 7 } });
    expect(byClass(b.graph, 'ReferenceLatent')).toHaveLength(0);
  });

  it('keeps a sheet to the character’s references: each one checked, encoded, and given to both conditionings', () => {
    const still = composeCharacterStill(catalog, mara, 'full-body');
    expect(still.prompt).toMatch(/same person as in reference images 1, 2 and 3/);
    expect(still.height).toBeGreaterThan(still.width);
    const b = buildStillGraph({ still, seed: 7, prefix: 's' });
    expect(b.referenceNodes).toHaveLength(3);
    expect(byClass(b.graph, 'ReferenceLatent')).toHaveLength(6);
    expect(
      byClass(b.graph, 'HildegardGuard')
        .map(([, n]) => n.inputs.what)
        .sort(),
    ).toEqual(['reference', 'reference', 'reference', 'still']);
  });

  it('draws a cast shot’s start frame from both characters’ references, then animates it', () => {
    const s = shot({ model: 'wan-2-2-ti2v-5b' }, [mara, konrad]);
    expect(s.cast!.characters.map((c) => c.name)).toEqual(['Mara', 'Brother Konrad']);
    // Four references in all: two each.
    expect(s.cast!.keyframe.references).toHaveLength(4);
    expect(s.cast!.keyframe.prompt).toMatch(/Mara, .*\(the person in reference images 1 and 2\)/);
    expect(s.cast!.keyframe.prompt).toMatch(
      /Brother Konrad, A tall monk \(the person in reference images 3 and 4\)/,
    );
    expect(s.prompt).toMatch(/Featuring Mara, Early thirties.*; Brother Konrad, A tall monk\./);
    const b = buildGraph({ shot: s, seed: 5, prefix: 'p' });
    expect(checkLinks(b.graph)).toEqual([]);
    expect(b.startFrameNode).toBeUndefined();
    expect(b.referenceNodes).toHaveLength(4);
    const latent = byClass(b.graph, 'Wan22ImageToVideoLatent')[0]![1];
    const scale = b.graph[(latent.inputs.start_image as [string, number])[0]]!;
    expect(b.graph[(scale.inputs.image as [string, number])[0]]!.class_type).toBe('VAEDecode');
    const ltx = buildGraph({ shot: shot({}, [mara]), seed: 5, prefix: 'p' });
    expect(ltx.referenceNodes).toHaveLength(3);
    expect(byClass(ltx.graph, 'LTXVImgToVideoInplace').length).toBeGreaterThan(0);
  });

  it('refuses a start frame and characters together, and a stills model for a take', () => {
    expect(() => shot({ startFrame: `${'a'.repeat(64)}.png` }, [mara])).toThrow(/start frame or characters/);
    expect(() => shot({ model: 'flux-2-klein-4b' })).toThrow(/makes stills, not video/);
    expect(() =>
      composeShot(
        catalog,
        ShotRequest.parse({
          prompt: 'x',
          rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
          characters: [mara.id],
        }),
        [konrad],
      ),
    ).toThrow(/Unknown character/);
  });
});

describe('classifyFailure', () => {
  it('recognises out of memory and missing models', () => {
    expect(classifyFailure('execution_error', 'torch.OutOfMemoryError: CUDA out of memory').code).toBe(
      'out_of_memory',
    );
    expect(classifyFailure('invalid_workflow', "Value not in list: unet_name: 'x' not in []").code).toBe(
      'model_missing',
    );
  });
});

describe('ComfySdkEngine against the fake proxy', () => {
  let proxy: FakeProxy;
  const dir = mkdtempSync(join(tmpdir(), 'hg-engine-'));
  beforeAll(async () => {
    proxy = await startFakeProxy({ tickMs: 10 });
  });
  afterAll(() => proxy.close());

  it('refuses cloud endpoints', () => {
    expect(() => new ComfySdkEngine('https://cloud.comfy.org')).toThrow(/own ComfyUI/);
  });

  it('renders, streams progress and previews, and saves the video', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    expect(await engine.ping()).toBe(true);
    const built = buildLtxGraph({
      shot: shot({ format: { aspect: '16:9', seconds: 3, quality: 'draft' } }),
      seed: 1,
      prefix: 'p',
    });
    const steps: number[] = [];
    let previews = 0;
    let running = false;
    const dest = join(dir, 'out.mp4');
    await engine.render(built, {
      dest,
      handlers: {
        onRunning: () => (running = true),
        onProgress: (p) => steps.push(p.step ?? -1),
        onPreview: () => previews++,
      },
    });
    expect(running).toBe(true);
    // Every sampler step arrives, though the proxy's `value` read 1 after the text encoders and fell back after.
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(previews).toBeGreaterThan(0);
    expect(statSync(dest).size).toBe(readFileSync(new URL('../fixtures/sample.mp4', import.meta.url)).length);
  });

  it('uploads a start frame and binds it', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    const built = buildLtxGraph({
      shot: shot({ format: { aspect: '16:9', seconds: 3, quality: 'draft' } }),
      seed: 1,
      prefix: 'p',
      startFrame: 'placeholder.png',
    });
    await engine.render(built, {
      dest: join(dir, 'i2v.mp4'),
      startFrame: fileURLToPath(new URL('../fixtures/preview.jpg', import.meta.url)),
    });
    const last = [...proxy.jobs.values()].at(-1)!;
    expect(JSON.stringify(last.workflow[built.startFrameNode!]!.inputs.image)).toContain('core/ASSET');
  });

  it('renders a still and binds each reference image', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    const built = buildStillGraph({
      still: composeCharacterStill(catalog, mara, 'profile'),
      seed: 2,
      prefix: 's',
    });
    const ref = fileURLToPath(new URL('../fixtures/still.png', import.meta.url));
    const dest = join(dir, 'still.png');
    await expect(engine.render(built, { dest, references: [ref] })).rejects.toMatchObject({
      code: 'invalid_graph',
    });
    await engine.render(built, { dest, references: [ref, ref, ref] });
    expect(readFileSync(dest).subarray(1, 4).toString()).toBe('PNG');
    const last = [...proxy.jobs.values()].at(-1)!;
    for (const n of built.referenceNodes!)
      expect(JSON.stringify(last.workflow[n]!.inputs.image)).toContain('core/ASSET');
  });

  it('reports out of memory as such', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    const built = buildLtxGraph({ shot: shot({ prompt: 'too big [fail:oom]' }), seed: 1, prefix: 'p' });
    await expect(engine.render(built, { dest: join(dir, 'x.mp4') })).rejects.toMatchObject({
      code: 'out_of_memory',
    });
  });

  it('cancels', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    const built = buildLtxGraph({ shot: shot(), seed: 1, prefix: 'p' });
    const ac = new AbortController();
    const p = engine.render(built, {
      dest: join(dir, 'c.mp4'),
      signal: ac.signal,
      handlers: { onProgress: () => ac.abort() },
    });
    await expect(p).rejects.toBeInstanceOf(EngineError);
    await expect(p).rejects.toMatchObject({ code: 'canceled' });
  });

  it('says ComfyUI is not running when nothing listens', async () => {
    const engine = new ComfySdkEngine('http://127.0.0.1:9');
    expect(await engine.ping()).toBe(false);
    const built = buildLtxGraph({ shot: shot(), seed: 1, prefix: 'p' });
    await expect(engine.render(built, { dest: join(dir, 'n.mp4') })).rejects.toMatchObject({
      code: 'engine_offline',
    });
  });
});

describe('vetGraph', () => {
  const files = catalogFiles(catalog.models);
  const safety = graphSafety(catalog, loadSafety());
  const variants = [
    ...videoModels(catalog).flatMap((m) =>
      (['draft', 'final'] as const).flatMap((quality) =>
        [undefined, 'start.png', 'cast'].map((start) =>
          buildGraph({
            shot: shot(
              {
                model: m.id,
                format: { aspect: '16:9', seconds: 3, quality },
                motion: [{ id: 'dolly-in', strength: 0.5 }],
              },
              start === 'cast' ? [mara, konrad] : [],
            ),
            seed: 3,
            prefix: 'p',
            startFrame: start === 'start.png' ? start : undefined,
          }),
        ),
      ),
    ),
    ...(['portrait', 'full-body'] as const).flatMap((view) =>
      [character('c1b2c3d4e5f60718', 0), mara].map((c) =>
        buildStillGraph({ still: composeCharacterStill(catalog, c, view), seed: 4, prefix: 's' }),
      ),
    ),
  ];

  it('accepts every graph the builders make, and the allowlist names only classes they use', () => {
    const used = new Set<string>();
    for (const b of variants) {
      expect(vetGraph(b, files, safety)).toEqual([]);
      for (const c of classes(b.graph)) used.add(c);
    }
    expect([...used].sort()).toEqual([...GRAPH_NODE_CLASSES].sort());
  });

  it('refuses nodes Hildegard never builds, files outside the catalog, and stray image loads', () => {
    const base = variants[0]!;
    const withNode = (node: object) => ({ ...base, graph: { ...base.graph, 999: node } }) as never;
    expect(
      vetGraph(withNode({ class_type: 'ExecutePython', inputs: { code: 'x' } }), files, safety).join(),
    ).toMatch(/ExecutePython, which Hildegard never uses/);
    expect(
      vetGraph(
        withNode({ class_type: 'VAELoader', inputs: { vae_name: '../../etc/passwd' } }),
        files,
        safety,
      ).join(),
    ).toMatch(/not in the catalog/);
    expect(
      vetGraph(withNode({ class_type: 'LoadImage', inputs: { image: 'secret.png' } }), files, safety).join(),
    ).toMatch(/neither the start frame nor a reference/);
    expect(
      vetGraph(withNode({ class_type: 'SaveVideo', inputs: { video: ['1', 0] } }), files, safety).join(),
    ).toMatch(/one video/);
    expect(
      vetGraph(withNode({ class_type: 'KSampler', inputs: { x: { y: 1 } } }), files, safety).join(),
    ).toMatch(/plain value/);
    expect(vetGraph({ ...base, graph: {} }, files, safety)).not.toEqual([]);
  });

  const find = (b: (typeof variants)[number], cls: string, what?: string) =>
    Object.entries(b.graph).find(([, n]) => n.class_type === cls && (!what || n.inputs.what === what))!;
  const clone = (b: (typeof variants)[number]) => structuredClone(b);

  it('refuses a graph whose frames skip the safety check', () => {
    for (const b of variants) {
      const g = clone(b);
      if (g.output === 'image') {
        const [, check] = find(g, 'HildegardGuard', 'still');
        g.graph[g.outputNode]!.inputs.images = check.inputs.images!;
        expect(vetGraph(g, files, safety).join()).toMatch(/saved without the safety check/);
        continue;
      }
      const [, look] = find(g, 'HildegardLook');
      const [, check] = find(g, 'HildegardGuard', 'take');
      look.inputs.images = check.inputs.images!;
      expect(vetGraph(g, files, safety).join()).toMatch(/without the safety check/);
    }
  });

  it('checks every reference image before the stills model reads it', () => {
    const cast = variants.filter((v) => v.referenceNodes?.length);
    // Two characters' references in every cast shot, and the still that keeps to Mara's.
    expect(cast.length).toBe(videoModels(catalog).length * 2 + 2);
    for (const b of cast) {
      expect(b.referenceNodes!.length).toBeLessThanOrEqual(4);
      const g = clone(b);
      const [id, check] = find(g, 'HildegardGuard', 'reference');
      const scale = Object.values(g.graph).find(
        (n) => n.class_type === 'ImageScaleToTotalPixels' && (n.inputs.image as [string, number])[0] === id,
      )!;
      scale.inputs.image = check.inputs.images!;
      expect(vetGraph(g, files, safety).join()).toMatch(/reference image is used before the safety check/);
    }
    // A reference image that isn't bound as one is a stray load.
    const stray = clone(cast[0]!);
    stray.referenceNodes = stray.referenceNodes!.slice(1);
    expect(vetGraph(stray, files, safety).join()).toMatch(/neither the start frame nor a reference/);
    // More than four, or a reference that is the start frame, is not a graph Hildegard makes.
    expect(vetGraph({ ...cast[0]!, referenceNodes: ['1', '2', '3', '4', '5'] }, files, safety)).toEqual([
      'the reference images are not ones Hildegard binds',
    ]);
  });

  it('refuses a still that saves a video, or a take that saves an image', () => {
    const still = variants.find((v) => v.output === 'image')!;
    expect(vetGraph({ ...still, output: 'video' }, files, safety).join()).toMatch(/save one video/);
    const take = variants.find((v) => !v.output)!;
    expect(vetGraph({ ...take, output: 'image' }, files, safety).join()).toMatch(/save one image/);
    expect(vetGraph({ ...take, output: 'gif' as never }, files, safety).join()).toMatch(/never makes/);
  });

  it('checks the words of a still prompt too', () => {
    const g = clone(variants.find((v) => v.output === 'image')!);
    const [, text] = Object.entries(g.graph).find(([, n]) => n.class_type === 'CLIPTextEncode')!;
    text.inputs.text = 'a nude portrait';
    expect(vetGraph(g, files, safety).join()).toMatch(/sexual content/);
  });

  it('refuses a start frame used before its check, a weaker check or another classifier', () => {
    const b = variants.find((v) => v.startFrameNode)!;
    const skip = clone(b);
    const [, check] = find(skip, 'HildegardGuard', 'start frame');
    const [, scale] = Object.entries(skip.graph).find(
      ([, n]) => n.class_type === 'ImageScale' && Array.isArray(n.inputs.image),
    )!;
    scale.inputs.image = check.inputs.images!;
    expect(vetGraph(skip, files, safety).join()).toMatch(/start frame is used before the safety check/);

    const weak = clone(b);
    find(weak, 'HildegardGuard', 'take')[1].inputs.threshold = 0.95;
    expect(vetGraph(weak, files, safety).join()).toMatch(/less strictly/);

    const other = clone(b);
    find(other, 'HildegardGuard', 'take')[1].inputs.classifier = 'always-fine.safetensors';
    expect(vetGraph(other, files, safety).join()).toMatch(/another classifier/);
  });

  it('refuses a sexual prompt from a paired device, but not the negative prompt', () => {
    const g = clone(variants[0]!);
    const [, pos] = Object.entries(g.graph).find(([, n]) => n._meta?.title === 'Prompt')!;
    pos.inputs.text = 'a naked woman on a bed';
    expect(vetGraph(g, files, safety).join()).toMatch(/asks for sexual content/);
    // The builders' own negative prompt names nudity, to steer away from it.
    expect(vetGraph(variants[0]!, files, safety)).toEqual([]);
  });
});

describe('progressOf', () => {
  it('reads only the sampler’s steps', () => {
    expect(progressOf({ step: 5, steps: 20 })).toBe(0.25);
    expect(progressOf({ step: 20, steps: 20 })).toBe(1);
  });
  it('says nothing outside sampling, where the proxy’s own numbers read 100% too early', () => {
    expect(progressOf({ step: null, steps: null })).toBeNull();
    expect(progressOf({ step: 0, steps: 0 })).toBeNull();
  });
});
