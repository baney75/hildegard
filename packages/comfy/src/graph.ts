// SPDX-License-Identifier: AGPL-3.0-only
import { basename } from 'node:path';
import type { Catalog, ComposedShot, ComposedStill, Model, SafetyCheck } from '@hildegard/presets';

/** A link to another node's output: `[nodeId, outputIndex]`, as ComfyUI's API format writes it. */
export type Link = [string, number];
export type InputValue = string | number | boolean | Link;
export interface ApiNode {
  class_type: string;
  inputs: Record<string, InputValue>;
  _meta?: { title: string };
}
/** ComfyUI API-format prompt graph. */
export type ApiGraph = Record<string, ApiNode>;

/** Node ids the engine reads back: where previews, the video and the poster come from. */
export interface BuiltGraph {
  graph: ApiGraph;
  outputNode: string;
  /** What the output node saves: a video (a take), or one image (a still). A video when absent. */
  output?: 'video' | 'image';
  /** Set when the graph loads a start frame; the engine binds the uploaded image here. */
  startFrameNode?: string;
  /** The LoadImage nodes for reference images, in order; the engine binds each reference image to its node. */
  referenceNodes?: string[];
}

export interface GraphInput {
  shot: ComposedShot;
  seed: number;
  /** File name prefix inside ComfyUI's output folder. */
  prefix: string;
  /** Start frame file name, already in ComfyUI's input folder (or an SDK asset bound later). */
  startFrame?: string;
}

/** Placeholder names for reference images until the engine binds the real ones. */
export const referenceName = (i: number) => `reference-${i + 1}.png`;

export class GraphBuilder {
  readonly graph: ApiGraph = {};
  private next = 1;
  add(class_type: string, inputs: Record<string, InputValue>, title?: string): string {
    const id = String(this.next++);
    this.graph[id] = title ? { class_type, inputs, _meta: { title } } : { class_type, inputs };
    return id;
  }
}

export const out = (id: string, slot = 0): Link => [id, slot];

const STAGE1_SIGMAS = '1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0';
const STAGE2_SIGMAS = '0.909375, 0.725, 0.421875, 0.0';

/** File name of a model file inside its ComfyUI models folder. */
export const fileName = (path: string): string => basename(path);

function fileIn(model: Model, dir: string, match: RegExp): string {
  const f = model.files.find((x) => x.dir === dir && match.test(x.path));
  if (!f) throw new Error(`Model ${model.id} has no ${dir} file matching ${match}`);
  return fileName(f.path);
}

interface Loaded {
  model: Link;
  video_vae: Link;
  audio_vae: Link;
  clip: Link;
  upscaler: Link;
  sampler: string;
}

function loadLtx25(g: GraphBuilder, m: Model): Loaded {
  const unet = g.add(
    'UNETLoader',
    { unet_name: fileIn(m, 'diffusion_models', /transformer/), weight_dtype: 'default' },
    'Model',
  );
  const vvae = g.add('VAELoader', { vae_name: fileIn(m, 'vae', /video-vae/) }, 'Video VAE');
  const avae = g.add('VAELoader', { vae_name: fileIn(m, 'vae', /audio-vae/) }, 'Audio VAE');
  const clip = g.add(
    'CLIPLoader',
    { clip_name: fileIn(m, 'text_encoders', /./), type: 'ltxv', device: 'default' },
    'Text encoder',
  );
  const up = g.add(
    'LatentUpscaleModelLoader',
    { model_name: fileIn(m, 'latent_upscale_models', /spatial/) },
    'Upscaler',
  );
  return {
    model: out(unet),
    video_vae: out(vvae),
    audio_vae: out(avae),
    clip: out(clip),
    upscaler: out(up),
    sampler: 'euler_ancestral',
  };
}

function loadLtx2(g: GraphBuilder, m: Model, shot: ComposedShot): Loaded {
  const ckptName = fileIn(m, 'checkpoints', /./);
  const ckpt = g.add('CheckpointLoaderSimple', { ckpt_name: ckptName }, 'Model');
  const avae = g.add('LTXVAudioVAELoader', { ckpt_name: ckptName }, 'Audio VAE');
  const clip = g.add(
    'LTXAVTextEncoderLoader',
    { text_encoder: fileIn(m, 'text_encoders', /./), ckpt_name: ckptName, device: 'default' },
    'Text encoder',
  );
  const up = g.add(
    'LatentUpscaleModelLoader',
    { model_name: fileIn(m, 'latent_upscale_models', /spatial/) },
    'Upscaler',
  );
  // Camera-control LoRAs stack on the model; their strength scales with how strongly the move was asked for.
  let model: Link = out(ckpt);
  for (const motion of shot.motions) {
    if (motion.impl.kind !== 'lora') continue;
    const lora = m.loras[motion.impl.lora];
    if (!lora) throw new Error(`Model ${m.id} lacks LoRA ${motion.impl.lora}`);
    const id = g.add(
      'LoraLoaderModelOnly',
      {
        model,
        lora_name: fileName(lora.path),
        strength_model: round2(motion.impl.strength * motion.strength),
      },
      `Camera: ${motion.name}`,
    );
    model = out(id);
  }
  return {
    model,
    video_vae: out(ckpt, 2),
    audio_vae: out(avae),
    clip: out(clip),
    upscaler: out(up),
    sampler: 'euler',
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Hildegard's safety check: stops the render if a frame looks sexual, else passes the frames on untouched. */
function guard(
  g: GraphBuilder,
  shot: { guard: { classifier: string; threshold: number } },
  images: Link,
  what: GuardWhat,
): Link {
  return out(
    g.add(
      'HildegardGuard',
      { images, classifier: shot.guard.classifier, threshold: shot.guard.threshold, what },
      what === 'take' ? 'Safety check' : `Safety check: ${what}`,
    ),
  );
}

/** What a HildegardGuard is checking, as the node names it when it refuses. */
export type GuardWhat = 'take' | 'start frame' | 'reference' | 'still';

/**
 * FLUX.2 [klein], distilled: one still from words and up to four reference images. Each reference is checked, scaled
 * to a megapixel, encoded and attached to both conditionings (BFL's multi-reference recipe), so the still keeps the
 * people in them. Returns the decoded image, not yet checked.
 */
function klein(
  g: GraphBuilder,
  still: ComposedStill,
  seed: number,
  refs: string[],
): { image: Link; nodes: string[] } {
  const m = still.model;
  const unet = g.add(
    'UNETLoader',
    { unet_name: fileIn(m, 'diffusion_models', /klein/), weight_dtype: 'default' },
    'Stills model',
  );
  const clip = g.add(
    'CLIPLoader',
    { clip_name: fileIn(m, 'text_encoders', /qwen/), type: 'flux2', device: 'default' },
    'Stills text encoder',
  );
  const vae = g.add('VAELoader', { vae_name: fileIn(m, 'vae', /flux2/) }, 'Stills VAE');
  const text = g.add('CLIPTextEncode', { text: still.prompt, clip: out(clip) }, 'Still prompt');
  let pos: Link = out(text);
  let neg: Link = out(g.add('ConditioningZeroOut', { conditioning: out(text) }));
  const nodes: string[] = [];
  refs.forEach((name, i) => {
    const load = g.add('LoadImage', { image: name }, `Reference ${i + 1}`);
    nodes.push(load);
    const scaled = g.add('ImageScaleToTotalPixels', {
      image: guard(g, still, out(load), 'reference'),
      upscale_method: 'lanczos',
      megapixels: 1,
      resolution_steps: 1,
    });
    const latent = g.add('VAEEncode', { pixels: out(scaled), vae: out(vae) });
    pos = out(g.add('ReferenceLatent', { conditioning: pos, latent: out(latent) }));
    neg = out(g.add('ReferenceLatent', { conditioning: neg, latent: out(latent) }));
  });
  const guider = g.add('CFGGuider', { model: out(unet), positive: pos, negative: neg, cfg: still.cfg });
  const sampled = g.add(
    'SamplerCustomAdvanced',
    {
      noise: out(g.add('RandomNoise', { noise_seed: seed })),
      guider: out(guider),
      sampler: out(g.add('KSamplerSelect', { sampler_name: 'euler' })),
      sigmas: out(g.add('Flux2Scheduler', { steps: still.steps, width: still.width, height: still.height })),
      latent_image: out(
        g.add('EmptyFlux2LatentImage', { width: still.width, height: still.height, batch_size: 1 }),
      ),
    },
    'Still sampler',
  );
  return { image: out(g.add('VAEDecode', { samples: out(sampled), vae: out(vae) })), nodes };
}

export interface StillInput {
  still: ComposedStill;
  seed: number;
  /** File name prefix inside ComfyUI's output folder. */
  prefix: string;
}

/** One still, checked, then saved as a PNG. */
export function buildStillGraph({ still, seed, prefix }: StillInput): BuiltGraph {
  const g = new GraphBuilder();
  const { image, nodes } = klein(
    g,
    still,
    seed,
    still.references.map((_, i) => referenceName(i)),
  );
  const save = g.add(
    'SaveImage',
    { images: guard(g, still, image, 'still'), filename_prefix: prefix },
    'Save',
  );
  return { graph: g.graph, outputNode: save, output: 'image', referenceNodes: nodes };
}

/**
 * Where a take starts from, if anywhere: the uploaded start frame, checked; or, for a shot with characters, a still
 * the stills model draws of them from their references.
 */
function startImage(
  g: GraphBuilder,
  { shot, seed, startFrame }: GraphInput,
): { image?: Link; startFrameNode?: string; referenceNodes?: string[] } {
  if (startFrame) {
    const node = g.add('LoadImage', { image: startFrame }, 'Start frame');
    return { image: guard(g, shot, out(node), 'start frame'), startFrameNode: node };
  }
  if (shot.cast) {
    const k = shot.cast.keyframe;
    const { image, nodes } = klein(
      g,
      k,
      seed,
      k.references.map((_, i) => referenceName(i)),
    );
    return { image, referenceNodes: nodes };
  }
  return {};
}

/**
 * LTX video with joint audio, distilled sampling. Final quality renders at half size, upsamples the latent ×2 and
 * refines with three more steps (Lightricks' two-stage recipe); draft runs stage one only at full size.
 */
export function buildLtxGraph(input: GraphInput): BuiltGraph {
  const { shot, seed, prefix } = input;
  const g = new GraphBuilder();
  const m = shot.model;
  const L = m.graph === 'ltx-2.5-distilled' ? loadLtx25(g, m) : loadLtx2(g, m, shot);

  const pos = g.add('CLIPTextEncode', { text: shot.prompt, clip: L.clip }, 'Prompt');
  const neg = g.add('CLIPTextEncode', { text: shot.negative, clip: L.clip }, 'Negative prompt');
  const cond = g.add('LTXVConditioning', { positive: out(pos), negative: out(neg), frame_rate: shot.fps });

  const w1 = shot.twoStage ? shot.width / 2 : shot.width;
  const h1 = shot.twoStage ? shot.height / 2 : shot.height;
  let video: Link = out(
    g.add('EmptyLTXVLatentVideo', { width: w1, height: h1, length: shot.frames, batch_size: 1 }),
  );

  let image: Link | undefined;
  const start = startImage(g, input);
  if (start.image) {
    const scaled = g.add('ImageScale', {
      image: start.image,
      upscale_method: 'lanczos',
      width: shot.width,
      height: shot.height,
      crop: 'center',
    });
    image = out(g.add('LTXVPreprocess', { image: out(scaled), img_compression: 18 }));
    video = out(
      g.add('LTXVImgToVideoInplace', {
        vae: L.video_vae,
        image,
        latent: video,
        strength: 0.7,
        bypass: false,
      }),
    );
  }

  const audio = g.add('LTXVEmptyLatentAudio', {
    frames_number: shot.frames,
    frame_rate: shot.fps,
    batch_size: 1,
    audio_vae: L.audio_vae,
  });
  const sampler = g.add('KSamplerSelect', { sampler_name: L.sampler });
  const guider = g.add('CFGGuider', {
    model: L.model,
    positive: out(cond, 0),
    negative: out(cond, 1),
    cfg: m[shot.quality].cfg,
  });

  const stage = (latent: Link, sigmas: string, noiseSeed: number, title: string): string => {
    const av = g.add('LTXVConcatAVLatent', { video_latent: latent, audio_latent: [audio, 0] });
    return stageFrom(out(av), sigmas, noiseSeed, title);
  };
  const stageFrom = (av: Link, sigmas: string, noiseSeed: number, title: string): string => {
    const noise = g.add('RandomNoise', { noise_seed: noiseSeed });
    const sig = g.add('ManualSigmas', { sigmas });
    const s = g.add(
      'SamplerCustomAdvanced',
      { noise: out(noise), guider: out(guider), sampler: out(sampler), sigmas: out(sig), latent_image: av },
      title,
    );
    return g.add('LTXVSeparateAVLatent', { av_latent: out(s) });
  };

  let separated = stage(video, STAGE1_SIGMAS, seed, 'Stage 1');
  if (shot.twoStage) {
    let up: Link = out(
      g.add('LTXVLatentUpsampler', {
        samples: out(separated, 0),
        upscale_model: L.upscaler,
        vae: L.video_vae,
      }),
    );
    if (image)
      up = out(
        g.add('LTXVImgToVideoInplace', { vae: L.video_vae, image, latent: up, strength: 1, bypass: false }),
      );
    const av = g.add('LTXVConcatAVLatent', { video_latent: up, audio_latent: out(separated, 1) });
    separated = stageFrom(out(av), STAGE2_SIGMAS, (seed + 1) % 2 ** 32, 'Stage 2');
  }

  const frames = g.add('VAEDecodeTiled', {
    samples: out(separated, 0),
    vae: L.video_vae,
    tile_size: 512,
    overlap: 64,
    temporal_size: 64,
    temporal_overlap: 8,
  });
  const sound = g.add('LTXVAudioVAEDecode', { samples: out(separated, 1), audio_vae: L.audio_vae });
  const look = g.add(
    'HildegardLook',
    { images: guard(g, shot, out(frames), 'take'), seed, ...shot.post },
    'Film look',
  );
  const vid = g.add('CreateVideo', { images: out(look), fps: shot.fps, audio: out(sound) });
  const save = g.add('SaveVideo', { video: out(vid), filename_prefix: prefix, format: 'mp4' }, 'Save');
  return built(g, save, start);
}

const built = (
  g: GraphBuilder,
  save: string,
  start: { startFrameNode?: string; referenceNodes?: string[] },
): BuiltGraph => ({
  graph: g.graph,
  outputNode: save,
  ...(start.startFrameNode ? { startFrameNode: start.startFrameNode } : {}),
  ...(start.referenceNodes?.length ? { referenceNodes: start.referenceNodes } : {}),
});

/**
 * Wan 2.2 TI2V-5B: one dense model for text-to-video and image-to-video, 24 fps, no sound. A plain KSampler run over
 * Wan's own latent, with the start frame (if any) encoded into the first latent frame.
 */
export function buildWanGraph(input: GraphInput): BuiltGraph {
  const { shot, seed, prefix } = input;
  const g = new GraphBuilder();
  const m = shot.model;
  const q = m[shot.quality];
  const unet = g.add(
    'UNETLoader',
    { unet_name: fileIn(m, 'diffusion_models', /ti2v/), weight_dtype: 'default' },
    'Model',
  );
  const model = g.add('ModelSamplingSD3', { model: out(unet), shift: 8 });
  const clip = g.add(
    'CLIPLoader',
    { clip_name: fileIn(m, 'text_encoders', /umt5/), type: 'wan', device: 'default' },
    'Text encoder',
  );
  const vae = g.add('VAELoader', { vae_name: fileIn(m, 'vae', /wan2\.2_vae/) }, 'VAE');
  const pos = g.add('CLIPTextEncode', { text: shot.prompt, clip: out(clip) }, 'Prompt');
  const neg = g.add('CLIPTextEncode', { text: shot.negative, clip: out(clip) }, 'Negative prompt');

  const latentInputs: Record<string, InputValue> = {
    vae: out(vae),
    width: shot.width,
    height: shot.height,
    length: shot.frames,
    batch_size: 1,
  };
  const start = startImage(g, input);
  if (start.image) {
    latentInputs.start_image = out(
      g.add('ImageScale', {
        image: start.image,
        upscale_method: 'lanczos',
        width: shot.width,
        height: shot.height,
        crop: 'center',
      }),
    );
  }
  const latent = g.add('Wan22ImageToVideoLatent', latentInputs);
  const sampled = g.add(
    'KSampler',
    {
      model: out(model),
      seed,
      steps: q.steps,
      cfg: q.cfg,
      sampler_name: 'uni_pc',
      scheduler: 'simple',
      positive: out(pos),
      negative: out(neg),
      latent_image: out(latent),
      denoise: 1,
    },
    'Sampler',
  );
  const frames = g.add('VAEDecode', { samples: out(sampled), vae: out(vae) });
  const look = g.add(
    'HildegardLook',
    { images: guard(g, shot, out(frames), 'take'), seed, ...shot.post },
    'Film look',
  );
  const vid = g.add('CreateVideo', { images: out(look), fps: shot.fps });
  const save = g.add('SaveVideo', { video: out(vid), filename_prefix: prefix, format: 'mp4' }, 'Save');
  return built(g, save, start);
}

/** The graph for whichever model the shot uses. */
export function buildGraph(input: GraphInput): BuiltGraph {
  return input.shot.model.graph === 'wan-2.2-ti2v' ? buildWanGraph(input) : buildLtxGraph(input);
}

/** Every link must point at an existing node; a graph that fails this never reaches ComfyUI. */
export function checkLinks(graph: ApiGraph): string[] {
  const problems: string[] = [];
  for (const [id, node] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && !graph[v[0]])
        problems.push(`node ${id} (${node.class_type}).${k} links to missing node ${v[0]}`);
    }
  }
  return problems;
}

/**
 * Every ComfyUI node class the builders above use, and no others. A device sharing its GPU in a Choir runs a paired
 * device's graph only when every node is one of these, so a peer can never run arbitrary ComfyUI nodes on it. A test
 * keeps this list in step with the builders.
 */
export const GRAPH_NODE_CLASSES: ReadonlySet<string> = new Set([
  'CFGGuider',
  'CLIPLoader',
  'CLIPTextEncode',
  'CheckpointLoaderSimple',
  'ConditioningZeroOut',
  'CreateVideo',
  'EmptyFlux2LatentImage',
  'EmptyLTXVLatentVideo',
  'Flux2Scheduler',
  'HildegardGuard',
  'HildegardLook',
  'ImageScale',
  'ImageScaleToTotalPixels',
  'KSampler',
  'KSamplerSelect',
  'LTXAVTextEncoderLoader',
  'LTXVAudioVAEDecode',
  'LTXVAudioVAELoader',
  'LTXVConcatAVLatent',
  'LTXVConditioning',
  'LTXVEmptyLatentAudio',
  'LTXVImgToVideoInplace',
  'LTXVLatentUpsampler',
  'LTXVPreprocess',
  'LTXVSeparateAVLatent',
  'LatentUpscaleModelLoader',
  'LoadImage',
  'LoraLoaderModelOnly',
  'ManualSigmas',
  'ModelSamplingSD3',
  'RandomNoise',
  'ReferenceLatent',
  'SamplerCustomAdvanced',
  'SaveImage',
  'SaveVideo',
  'UNETLoader',
  'VAEDecode',
  'VAEDecodeTiled',
  'VAEEncode',
  'VAELoader',
  'Wan22ImageToVideoLatent',
]);

/** Most reference images a graph may load (FLUX.2 [klein]'s budget, MAX_REFERENCES in presets). */
const MAX_REFERENCE_NODES = 4;

/** Inputs that name a model file; on a shared GPU they may only name files from the catalog. */
const FILE_INPUTS = new Set([
  'unet_name',
  'vae_name',
  'clip_name',
  'ckpt_name',
  'lora_name',
  'model_name',
  'text_encoder',
]);
const MAX_NODES = 200;
const MAX_TEXT = 20_000;

/**
 * Check a graph that came from another device before it goes anywhere near ComfyUI: it must look like one these
 * builders make. Only known node classes, plain values or links between its own nodes, model files from the catalog,
 * one SaveVideo as the output, and a LoadImage only where the start frame is bound. Returns what is wrong; empty
 * means it may run.
 */
export function vetGraph(built: BuiltGraph, modelFiles: ReadonlySet<string>, safety: GraphSafety): string[] {
  const problems: string[] = [];
  const graph = built.graph;
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return ['the graph is not an object'];
  const ids = Object.keys(graph);
  if (!ids.length || ids.length > MAX_NODES) return [`the graph has ${ids.length} nodes`];
  if (built.output !== undefined && built.output !== 'video' && built.output !== 'image')
    return ['the graph saves something Hildegard never makes'];
  const refs = built.referenceNodes ?? [];
  if (
    !Array.isArray(refs) ||
    refs.length > MAX_REFERENCE_NODES ||
    refs.some((r) => typeof r !== 'string' || r === built.startFrameNode) ||
    new Set(refs).size !== refs.length
  )
    return ['the reference images are not ones Hildegard binds'];
  const negatives = new Set(
    Object.values(graph).flatMap((n) => {
      const v = n?.inputs?.negative;
      return Array.isArray(v) && typeof v[0] === 'string' ? [v[0]] : [];
    }),
  );
  for (const [id, node] of Object.entries(graph)) {
    if (!/^\d{1,4}$/.test(id)) problems.push(`node id ${JSON.stringify(id).slice(0, 40)} is not a number`);
    if (!node || typeof node !== 'object' || typeof node.class_type !== 'string') {
      problems.push(`node ${id} has no class`);
      continue;
    }
    if (!GRAPH_NODE_CLASSES.has(node.class_type))
      problems.push(`node ${id} is a ${node.class_type.slice(0, 60)}, which Hildegard never uses`);
    if (!node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) {
      problems.push(`node ${id} has no inputs`);
      continue;
    }
    for (const [k, v] of Object.entries(node.inputs)) {
      const ok =
        (typeof v === 'string' && v.length <= MAX_TEXT) ||
        (typeof v === 'number' && Number.isFinite(v)) ||
        typeof v === 'boolean' ||
        (Array.isArray(v) &&
          v.length === 2 &&
          typeof v[0] === 'string' &&
          Number.isInteger(v[1]) &&
          v[1] >= 0 &&
          v[1] < 16);
      if (!ok) problems.push(`node ${id} input ${k.slice(0, 40)} is not a plain value or link`);
      if (FILE_INPUTS.has(k) && (typeof v !== 'string' || !modelFiles.has(v)))
        problems.push(`node ${id} names a model file that is not in the catalog`);
    }
    if (node.class_type === 'LoadImage' && id !== built.startFrameNode && !refs.includes(id))
      problems.push(`node ${id} loads an image that is neither the start frame nor a reference`);
    if (node.class_type === 'HildegardGuard') {
      const { classifier, threshold } = node.inputs;
      if (classifier !== safety.classifier) problems.push(`node ${id} checks frames with another classifier`);
      if (typeof threshold !== 'number' || threshold > safety.threshold)
        problems.push(`node ${id} checks frames less strictly than this device does`);
    }
    // The device rendering it checks the words too: a paired device's own checks may have been taken out. A
    // negative prompt steers away from what it names, so only prompts that feed a `negative` input are let be.
    if (
      node.class_type === 'CLIPTextEncode' &&
      typeof node.inputs.text === 'string' &&
      !negatives.has(id) &&
      !safety.text(node.inputs.text).ok
    )
      problems.push(`node ${id} asks for sexual content`);
  }
  // One output, of the kind the graph says it makes, and nothing else saved.
  const want = built.output === 'image' ? 'SaveImage' : 'SaveVideo';
  const saves = Object.entries(graph).filter(
    ([, n]) => n?.class_type === 'SaveVideo' || n?.class_type === 'SaveImage',
  );
  if (saves.length !== 1 || saves[0]![0] !== built.outputNode || saves[0]![1].class_type !== want)
    problems.push(
      `the graph must save one ${built.output === 'image' ? 'image' : 'video'}, from its output node`,
    );
  if (built.startFrameNode !== undefined && graph[built.startFrameNode]?.class_type !== 'LoadImage')
    problems.push('the start frame node is not a LoadImage');
  if (refs.some((r) => graph[r]?.class_type !== 'LoadImage'))
    problems.push('a reference image node is not a LoadImage');
  if (!problems.length) problems.push(...checkLinks(graph));
  if (!problems.length) problems.push(...guarded(built));
  return problems;
}

/** Follow a link back through nodes of these classes, by their `images` input, to the node that made the frames. */
function source(graph: ApiGraph, link: InputValue | undefined, through: ReadonlySet<string>): ApiNode[] {
  const path: ApiNode[] = [];
  let at = link;
  for (let hops = 0; Array.isArray(at) && hops < MAX_NODES; hops++) {
    const node = graph[at[0]];
    if (!node) break;
    path.push(node);
    if (!through.has(node.class_type)) break;
    at = node.inputs.images;
  }
  return path;
}

/**
 * Every frame that reaches the video passes a HildegardGuard, and so does the start frame before anything uses it.
 * Run after the other checks, so every link resolves.
 */
function guarded(built: BuiltGraph): string[] {
  const graph = built.graph;
  const problems: string[] = [];
  const save = graph[built.outputNode]!;
  let frames: InputValue | undefined;
  if (built.output === 'image') frames = save.inputs.images;
  else {
    const video = Array.isArray(save.inputs.video) ? graph[save.inputs.video[0]] : undefined;
    if (video?.class_type !== 'CreateVideo') return ['the video is not made by CreateVideo'];
    frames = video.inputs.images;
  }
  const path = source(graph, frames, new Set(['HildegardLook', 'HildegardGuard']));
  if (!path.some((n) => n.class_type === 'HildegardGuard'))
    problems.push(
      built.output === 'image'
        ? 'the image is saved without the safety check'
        : 'the frames reach the video without the safety check',
    );
  // Every image the graph loads is checked before anything else touches it.
  const checkedFirst = (node: string, what: string) => {
    const users = Object.values(graph).filter((n) =>
      Object.values(n.inputs).some((v) => Array.isArray(v) && v[0] === node),
    );
    return (
      users.length > 0 && users.every((n) => n.class_type === 'HildegardGuard' && n.inputs.what === what)
    );
  };
  if (built.startFrameNode !== undefined && !checkedFirst(built.startFrameNode, 'start frame'))
    problems.push('the start frame is used before the safety check');
  for (const r of built.referenceNodes ?? [])
    if (!checkedFirst(r, 'reference')) problems.push('a reference image is used before the safety check');
  return problems;
}

/** What vetGraph needs to hold a graph to this device's safety rules. */
export interface GraphSafety {
  classifier: string;
  threshold: number;
  text: (t: string) => { ok: boolean };
}

export function graphSafety(catalog: Catalog, check: SafetyCheck): GraphSafety {
  return {
    classifier: fileName(catalog.safety.classifier.path),
    threshold: catalog.safety.threshold,
    text: (t) => check.text(t),
  };
}

/** The file names a graph may load: every model file and camera LoRA in the catalog. */
export function catalogFiles(models: readonly Model[]): Set<string> {
  return new Set(models.flatMap((m) => [...m.files, ...Object.values(m.loras)].map((f) => fileName(f.path))));
}
