import type { Catalog, Model, MotionImpl, Post, ShotRequest } from './schema.ts';
import { Post as PostSchema } from './schema.ts';

export interface ResolvedMotion {
  id: string;
  name: string;
  strength: number;
  impl: MotionImpl;
}

/** Everything a graph builder needs, with no catalog lookups left to do. */
export interface ComposedShot {
  model: Model;
  prompt: string;
  negative: string;
  width: number;
  height: number;
  frames: number;
  fps: number;
  seconds: number;
  quality: 'draft' | 'final';
  /** Two-stage models render at half size, then upscale the latent ×2. */
  twoStage: boolean;
  motions: ResolvedMotion[];
  post: Post;
  /** Short human summary for cards, the slate and the Shot Card: "Full-frame cinema · Vintage anamorphic · 35mm · f/2.0". */
  summary: string;
}

export class PresetError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.field = field;
    this.name = 'PresetError';
  }
}

const NEGATIVE =
  'blurry, low quality, still frame, frozen, watermark, text overlay, subtitles, logo, distorted faces, extra limbs, jitter, flicker';

export function apertureWords(f: number): string {
  if (f <= 2.0) return `shot wide open at f/${fmtF(f)}, very shallow depth of field, creamy background blur`;
  if (f <= 4.0) return `shot at f/${fmtF(f)}, shallow depth of field, soft background`;
  if (f <= 8.0) return `shot at f/${fmtF(f)}, moderate depth of field`;
  return `shot at f/${fmtF(f)}, deep focus, foreground and background sharp`;
}

export const fmtF = (f: number): string =>
  Number.isInteger(f) ? f.toFixed(1) : String(Math.round(f * 10) / 10);

function need<T>(value: T | undefined, field: string, what: string): T {
  if (value === undefined) throw new PresetError(`Unknown ${what}`, field);
  return value;
}

/** Combine look settings: amounts add (clamped), multipliers multiply. */
export function mergePost(...parts: Array<Partial<Post> | undefined>): Post {
  const out = PostSchema.parse({});
  for (const p of parts) {
    if (!p) continue;
    for (const k of ['grain', 'halation', 'vignette', 'gateWeave', 'softness'] as const) {
      if (p[k] !== undefined) out[k] = Math.min(1, out[k] + p[k]);
    }
    if (p.saturation !== undefined) out.saturation = Math.min(2, out.saturation * p.saturation);
    if (p.contrast !== undefined) out.contrast = Math.min(2, out.contrast * p.contrast);
    if (p.warmth !== undefined) out.warmth = Math.max(-1, Math.min(1, out.warmth + p.warmth));
    if (p.lift !== undefined) out.lift = Math.min(0.3, out.lift + p.lift);
  }
  for (const k of Object.keys(out) as Array<keyof Post>) out[k] = Math.round(out[k] * 1000) / 1000;
  return out;
}

const round = (n: number, to: number) => Math.max(to, Math.round(n / to) * to);

/** Output size for an aspect at a quality: `shortSide` is the short edge in pixels. */
export function frameSize(aspect: { width: number; height: number }, shortSide: number, twoStage: boolean) {
  const scale = shortSide / Math.min(aspect.width, aspect.height);
  // Two-stage graphs halve the size for stage one, and LTX wants multiples of 32 at every stage.
  const step = twoStage ? 64 : 32;
  return { width: round(aspect.width * scale, step), height: round(aspect.height * scale, step) };
}

/** LTX wants 8n + 1 frames, Wan 4n + 1. */
export function frameCount(fps: number, seconds: number, multiple: number): number {
  return 1 + Math.max(1, Math.round((fps * seconds) / multiple)) * multiple;
}

export function pickModel(catalog: Catalog, id?: string): Model {
  if (id)
    return need(
      catalog.models.find((m) => m.id === id),
      'model',
      'model',
    );
  return catalog.models[0]!;
}

export function composeShot(catalog: Catalog, req: ShotRequest): ComposedShot {
  const model = pickModel(catalog, req.model);
  const body = need(
    catalog.bodies.find((b) => b.id === req.rig.body),
    'rig.body',
    'camera body',
  );
  const lens = need(
    catalog.lenses.find((l) => l.id === req.rig.lens),
    'rig.lens',
    'lens',
  );
  const focal = need(
    catalog.focals.find((f) => f.mm === req.rig.focal),
    'rig.focal',
    'focal length',
  );
  const aspect = need(
    catalog.aspects.find((a) => a.id === req.format.aspect),
    'format.aspect',
    'aspect ratio',
  );
  const look = req.look;
  const lighting = look.lighting
    ? need(
        catalog.lightings.find((l) => l.id === look.lighting),
        'look.lighting',
        'lighting',
      )
    : undefined;
  const palette = look.palette
    ? need(
        catalog.palettes.find((p) => p.id === look.palette),
        'look.palette',
        'palette',
      )
    : undefined;
  const genre = look.genre
    ? need(
        catalog.genres.find((g) => g.id === look.genre),
        'look.genre',
        'genre',
      )
    : undefined;
  const era = look.era
    ? need(
        catalog.eras.find((e) => e.id === look.era),
        'look.era',
        'era',
      )
    : undefined;

  const motions: ResolvedMotion[] = req.motion.map((m, i) => {
    const motion = need(
      catalog.motions.find((x) => x.id === m.id),
      `motion.${i}`,
      'camera motion',
    );
    return {
      id: motion.id,
      name: motion.name,
      strength: m.strength,
      impl: motion.impl[model.id] ?? { kind: 'prompt' },
    };
  });
  const motionText = req.motion
    .map((m) => catalog.motions.find((x) => x.id === m.id)!.prompt)
    .join(', while ');

  const seconds = Math.min(req.format.seconds, model.maxSeconds);
  const twoStage = req.format.quality === 'final' && model.twoStageFinal;
  const quality = model[req.format.quality];
  const { width, height } = frameSize(aspect, quality.height, twoStage);

  // LTX follows long, literal, chronological prompts: action first, then camera, then the look.
  const sentences = [
    req.prompt.trim().replace(/[.\s]+$/, ''),
    motionText ? cap(motionText) : 'The camera holds steady',
    `${cap(body.prompt)}, ${lens.prompt}, ${focal.prompt}, ${apertureWords(req.rig.aperture)}`,
    [lighting?.prompt, palette?.prompt].filter(Boolean).join(', '),
    [genre?.prompt, era?.prompt].filter(Boolean).join(', '),
  ].filter((s) => s.length > 0);

  return {
    model,
    prompt: `${sentences.map(cap).join('. ')}.`,
    negative: NEGATIVE,
    width,
    height,
    frames: frameCount(model.fps, seconds, model.frameMultiple),
    fps: model.fps,
    seconds,
    quality: req.format.quality,
    twoStage,
    motions,
    post: mergePost(body.post, lens.post, lighting?.post, palette?.post),
    summary: [body.name, lens.name, `${focal.mm}mm`, `f/${fmtF(req.rig.aperture)}`].join(' · '),
  };
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Seeds for each take: a locked seed counts up from itself, otherwise each take gets a fresh one. */
export function takeSeeds(takes: number, seed?: number, random: () => number = Math.random): number[] {
  return Array.from({ length: takes }, (_, i) =>
    seed === undefined ? Math.floor(random() * 2 ** 32) : (seed + i) % 2 ** 32,
  );
}
