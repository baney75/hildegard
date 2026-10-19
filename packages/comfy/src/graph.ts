import { basename } from 'node:path';
import type { ComposedShot, Model } from '@hildegard/presets';

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
  /** Set when the graph loads a start frame; the engine binds the uploaded image here. */
  startFrameNode?: string;
}

export interface GraphInput {
  shot: ComposedShot;
  seed: number;
  /** File name prefix inside ComfyUI's output folder. */
  prefix: string;
  /** Start frame file name, already in ComfyUI's input folder (or an SDK asset bound later). */
  startFrame?: string;
}

class GraphBuilder {
  readonly graph: ApiGraph = {};
  private next = 1;
  add(class_type: string, inputs: Record<string, InputValue>, title?: string): string {
    const id = String(this.next++);
    this.graph[id] = title ? { class_type, inputs, _meta: { title } } : { class_type, inputs };
    return id;
  }
}

const out = (id: string, slot = 0): Link => [id, slot];

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
  const unet = g.add('UNETLoader', { unet_name: fileIn(m, 'diffusion_models', /transformer/), weight_dtype: 'default' }, 'Model');
  const vvae = g.add('VAELoader', { vae_name: fileIn(m, 'vae', /video-vae/) }, 'Video VAE');
  const avae = g.add('VAELoader', { vae_name: fileIn(m, 'vae', /audio-vae/) }, 'Audio VAE');
  const clip = g.add('CLIPLoader', { clip_name: fileIn(m, 'text_encoders', /./), type: 'ltxv', device: 'default' }, 'Text encoder');
  const up = g.add('LatentUpscaleModelLoader', { model_name: fileIn(m, 'latent_upscale_models', /spatial/) }, 'Upscaler');
  return { model: out(unet), video_vae: out(vvae), audio_vae: out(avae), clip: out(clip), upscaler: out(up), sampler: 'euler_ancestral' };
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
  const up = g.add('LatentUpscaleModelLoader', { model_name: fileIn(m, 'latent_upscale_models', /spatial/) }, 'Upscaler');
  // Camera-control LoRAs stack on the model; their strength scales with how strongly the move was asked for.
  let model: Link = out(ckpt);
  for (const motion of shot.motions) {
    if (motion.impl.kind !== 'lora') continue;
    const lora = m.loras[motion.impl.lora];
    if (!lora) throw new Error(`Model ${m.id} lacks LoRA ${motion.impl.lora}`);
    const id = g.add(
      'LoraLoaderModelOnly',
      { model, lora_name: fileName(lora.path), strength_model: round2(motion.impl.strength * motion.strength) },
      `Camera: ${motion.name}`,
    );
    model = out(id);
  }
  return { model, video_vae: out(ckpt, 2), audio_vae: out(avae), clip: out(clip), upscaler: out(up), sampler: 'euler' };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * LTX video with joint audio, distilled sampling. Final quality renders at half size, upsamples the latent ×2 and
 * refines with three more steps (Lightricks' two-stage recipe); draft runs stage one only at full size.
 */
export function buildLtxGraph({ shot, seed, prefix, startFrame }: GraphInput): BuiltGraph {
  const g = new GraphBuilder();
  const m = shot.model;
  const L = m.graph === 'ltx-2.5-distilled' ? loadLtx25(g, m) : loadLtx2(g, m, shot);

  const pos = g.add('CLIPTextEncode', { text: shot.prompt, clip: L.clip }, 'Prompt');
  const neg = g.add('CLIPTextEncode', { text: shot.negative, clip: L.clip }, 'Negative prompt');
  const cond = g.add('LTXVConditioning', { positive: out(pos), negative: out(neg), frame_rate: shot.fps });

  const w1 = shot.twoStage ? shot.width / 2 : shot.width;
  const h1 = shot.twoStage ? shot.height / 2 : shot.height;
  let video: Link = out(g.add('EmptyLTXVLatentVideo', { width: w1, height: h1, length: shot.frames, batch_size: 1 }));

  let image: Link | undefined;
  let startFrameNode: string | undefined;
  if (startFrame) {
    startFrameNode = g.add('LoadImage', { image: startFrame }, 'Start frame');
    const scaled = g.add('ImageScale', {
      image: out(startFrameNode),
      upscale_method: 'lanczos',
      width: shot.width,
      height: shot.height,
      crop: 'center',
    });
    image = out(g.add('LTXVPreprocess', { image: out(scaled), img_compression: 18 }));
    video = out(g.add('LTXVImgToVideoInplace', { vae: L.video_vae, image, latent: video, strength: 0.7, bypass: false }));
  }

  const audio = g.add('LTXVEmptyLatentAudio', {
    frames_number: shot.frames,
    frame_rate: shot.fps,
    batch_size: 1,
    audio_vae: L.audio_vae,
  });
  const sampler = g.add('KSamplerSelect', { sampler_name: L.sampler });
  const guider = g.add('CFGGuider', { model: L.model, positive: out(cond, 0), negative: out(cond, 1), cfg: m[shot.quality].cfg });

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
    let up: Link = out(g.add('LTXVLatentUpsampler', { samples: out(separated, 0), upscale_model: L.upscaler, vae: L.video_vae }));
    if (image) up = out(g.add('LTXVImgToVideoInplace', { vae: L.video_vae, image, latent: up, strength: 1, bypass: false }));
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
  const look = g.add('HildegardLook', { images: out(frames), seed, ...shot.post }, 'Film look');
  const vid = g.add('CreateVideo', { images: out(look), fps: shot.fps, audio: out(sound) });
  const save = g.add('SaveVideo', { video: out(vid), filename_prefix: prefix, format: 'mp4' }, 'Save');
  return { graph: g.graph, outputNode: save, startFrameNode };
}

/** Every link must point at an existing node; a graph that fails this never reaches ComfyUI. */
export function checkLinks(graph: ApiGraph): string[] {
  const problems: string[] = [];
  for (const [id, node] of Object.entries(graph)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && !graph[v[0]]) problems.push(`node ${id} (${node.class_type}).${k} links to missing node ${v[0]}`);
    }
  }
  return problems;
}
