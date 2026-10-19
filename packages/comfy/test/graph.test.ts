import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShotRequest, composeShot, loadCatalog } from '@hildegard/presets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeProxy, type FakeProxy } from '../src/fake-proxy.ts';
import { ComfySdkEngine, EngineError, buildLtxGraph, checkLinks, classifyFailure } from '../src/index.ts';

const { catalog } = loadCatalog();
const shot = (over: Record<string, unknown> = {}) =>
  composeShot(
    catalog,
    ShotRequest.parse({
      prompt: 'A lighthouse keeper climbs the spiral stairs',
      rig: { body: 'vintage-16mm', lens: 'clean', focal: 35, aperture: 2.8 },
      ...over,
    }),
  );
const classes = (g: Record<string, { class_type: string }>) => Object.values(g).map((n) => n.class_type);

describe('buildLtxGraph', () => {
  it('builds a two-stage LTX-2.5 text-to-video graph with sound and the film look', () => {
    const { graph, outputNode, startFrameNode } = buildLtxGraph({ shot: shot(), seed: 7, prefix: 'hildegard/x' });
    expect(checkLinks(graph)).toEqual([]);
    expect(classes(graph)).toEqual(expect.arrayContaining(['UNETLoader', 'LTXVLatentUpsampler', 'LTXVAudioVAEDecode', 'HildegardLook', 'SaveVideo']));
    expect(classes(graph).filter((c) => c === 'SamplerCustomAdvanced')).toHaveLength(2);
    expect(graph[outputNode]!.class_type).toBe('SaveVideo');
    expect(startFrameNode).toBeUndefined();
    const empty = Object.values(graph).find((n) => n.class_type === 'EmptyLTXVLatentVideo')!;
    expect(empty.inputs).toMatchObject({ width: 960, height: 544, length: 121 });
    const look = Object.values(graph).find((n) => n.class_type === 'HildegardLook')!;
    expect(look.inputs.grain).toBeGreaterThan(0.4);
  });

  it('runs one stage at full size for drafts', () => {
    const { graph } = buildLtxGraph({ shot: shot({ format: { aspect: '16:9', seconds: 3, quality: 'draft' } }), seed: 1, prefix: 'p' });
    expect(classes(graph)).not.toContain('LTXVLatentUpsampler');
    expect(Object.values(graph).find((n) => n.class_type === 'EmptyLTXVLatentVideo')!.inputs).toMatchObject({ width: 960, height: 544, length: 73 });
  });

  it('stacks camera LoRAs on LTX-2, scaled by strength', () => {
    const { graph } = buildLtxGraph({
      shot: shot({ model: 'ltx-2-distilled', motion: [{ id: 'dolly-in', strength: 0.5 }, { id: 'crane-up', strength: 1 }] }),
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
    const { graph, startFrameNode } = buildLtxGraph({ shot: shot(), seed: 1, prefix: 'p', startFrame: 'a.png' });
    expect(graph[startFrameNode!]!.class_type).toBe('LoadImage');
    expect(classes(graph).filter((c) => c === 'LTXVImgToVideoInplace')).toHaveLength(2);
  });
});

describe('classifyFailure', () => {
  it('recognises out of memory and missing models', () => {
    expect(classifyFailure('execution_error', 'torch.OutOfMemoryError: CUDA out of memory').code).toBe('out_of_memory');
    expect(classifyFailure('invalid_workflow', "Value not in list: unet_name: 'x' not in []").code).toBe('model_missing');
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
    const built = buildLtxGraph({ shot: shot({ format: { aspect: '16:9', seconds: 3, quality: 'draft' } }), seed: 1, prefix: 'p' });
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
    expect(steps.at(-1)).toBe(8);
    expect(previews).toBeGreaterThan(0);
    expect(statSync(dest).size).toBe(readFileSync(new URL('../fixtures/sample.mp4', import.meta.url)).length);
  });

  it('uploads a start frame and binds it', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    const built = buildLtxGraph({ shot: shot({ format: { aspect: '16:9', seconds: 3, quality: 'draft' } }), seed: 1, prefix: 'p', startFrame: 'placeholder.png' });
    await engine.render(built, { dest: join(dir, 'i2v.mp4'), startFrame: new URL('../fixtures/preview.jpg', import.meta.url).pathname });
    const last = [...proxy.jobs.values()].at(-1)!;
    expect(JSON.stringify(last.workflow[built.startFrameNode!]!.inputs.image)).toContain('core/ASSET');
  });

  it('reports out of memory as such', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    const built = buildLtxGraph({ shot: shot({ prompt: 'too big [fail:oom]' }), seed: 1, prefix: 'p' });
    await expect(engine.render(built, { dest: join(dir, 'x.mp4') })).rejects.toMatchObject({ code: 'out_of_memory' });
  });

  it('cancels', async () => {
    const engine = new ComfySdkEngine(proxy.url);
    const built = buildLtxGraph({ shot: shot(), seed: 1, prefix: 'p' });
    const ac = new AbortController();
    const p = engine.render(built, { dest: join(dir, 'c.mp4'), signal: ac.signal, handlers: { onProgress: () => ac.abort() } });
    await expect(p).rejects.toBeInstanceOf(EngineError);
    await expect(p).rejects.toMatchObject({ code: 'canceled' });
  });

  it('says ComfyUI is not running when nothing listens', async () => {
    const engine = new ComfySdkEngine('http://127.0.0.1:9');
    expect(await engine.ping()).toBe(false);
    const built = buildLtxGraph({ shot: shot(), seed: 1, prefix: 'p' });
    await expect(engine.render(built, { dest: join(dir, 'n.mp4') })).rejects.toMatchObject({ code: 'engine_offline' });
  });
});
