// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

/** Lower-case ids with dashes: stable keys used by the UI, the MCP tools and saved projects. */
export const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'ids are lower-case letters, digits and dashes');

const Text = z.string().min(1).max(400);

/** Film-look post settings, applied by the HildegardLook node after decode. 0 means off. */
export const Post = z
  .object({
    grain: z.number().min(0).max(1).default(0),
    halation: z.number().min(0).max(1).default(0),
    vignette: z.number().min(0).max(1).default(0),
    gateWeave: z.number().min(0).max(1).default(0),
    softness: z.number().min(0).max(1).default(0),
    saturation: z.number().min(0).max(2).default(1),
    contrast: z.number().min(0).max(2).default(1),
    warmth: z.number().min(-1).max(1).default(0),
    lift: z.number().min(0).max(0.3).default(0),
  })
  .strict();
export type Post = z.infer<typeof Post>;
const PartialPost = Post.partial();

export const Body = z
  .object({ id: Id, name: Text, blurb: Text, prompt: Text, post: PartialPost.default({}) })
  .strict();

export const Lens = z
  .object({
    id: Id,
    name: Text,
    blurb: Text,
    prompt: Text,
    post: PartialPost.default({}),
    /** Anamorphic lenses default the frame to 2.39:1. */
    aspect: z.string().optional(),
  })
  .strict();

export const Focal = z.object({ mm: z.number().int().min(4).max(800), label: Text, prompt: Text }).strict();

export const MotionCategory = z.enum(['push', 'orbit', 'vertical', 'handheld', 'time', 'reveal', 'static']);

/**
 * How a model achieves a move. `lora` uses a camera-control LoRA, `guide` conditions on a reference clip
 * through IC-LoRA motion transfer, `prompt` relies on the text alone.
 */
export const MotionImpl = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('lora'), lora: Id, strength: z.number().min(0).max(2).default(1) }).strict(),
  z
    .object({
      kind: z.literal('guide'),
      clip: z.string().min(1),
      strength: z.number().min(0).max(2).default(1),
    })
    .strict(),
  z.object({ kind: z.literal('prompt') }).strict(),
]);

export const Motion = z
  .object({
    id: Id,
    name: Text,
    category: MotionCategory,
    prompt: Text,
    /** SVG path on a 160×100 box, drawn on the motion card: the camera starts at the path's first point. */
    path: z.string().min(1).max(400),
    impl: z.record(Id, MotionImpl).default({}),
  })
  .strict();

export const Lighting = z
  .object({ id: Id, name: Text, blurb: Text, prompt: Text, post: PartialPost.default({}) })
  .strict();
export const Palette = z
  .object({
    id: Id,
    name: Text,
    blurb: Text,
    prompt: Text,
    colors: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).length(5),
    post: PartialPost.default({}),
  })
  .strict();
export const Named = z.object({ id: Id, name: Text, prompt: Text }).strict();

export const Aspect = z
  .object({
    id: z.string().regex(/^\d+(\.\d+)?:\d+$/),
    name: Text,
    width: z.number().int(),
    height: z.number().int(),
  })
  .strict();

export const ModelDir = z.enum([
  'checkpoints',
  'diffusion_models',
  'loras',
  'text_encoders',
  'vae',
  'latent_upscale_models',
  'upscale_models',
]);

/** A file as written in `models.toml`. Its exact revision, hash and size come from `models.lock.json`. */
export const ModelFile = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    path: z
      .string()
      .min(1)
      .refine((p) => !p.includes('..') && !p.startsWith('/'), 'relative path inside the repo'),
    /** Where it goes under ComfyUI's models folder. */
    dir: ModelDir,
    /** Approximate size in bytes, shown before the lock is fetched. */
    size: z.number().int().positive(),
    gated: z.boolean().default(false),
  })
  .strict();

/** One pinned file: the commit it was read at, its SHA-256 and exact size. Written by `pnpm lock-models`. */
export const LockedFile = z
  .object({
    revision: z.string().regex(/^[0-9a-f]{40}$/, 'a full 40-character commit'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive(),
  })
  .strict();
export const ModelLock = z
  .object({ version: z.literal(1), files: z.record(z.string(), LockedFile) })
  .strict();
export type LockedFile = z.infer<typeof LockedFile>;
export type ModelLock = z.infer<typeof ModelLock>;
export const lockKey = (f: { repo: string; path: string }) => `${f.repo}/${f.path}`;

export const Quality = z
  .object({
    height: z.number().int(),
    steps: z.number().int().min(1).max(80),
    cfg: z.number().min(0).max(20),
  })
  .strict();

export const Model = z
  .object({
    id: Id,
    name: Text,
    family: z.string(),
    blurb: Text,
    license: Text,
    gated: z.boolean().default(false),
    licenseUrl: z.string().url(),
    /** The license's main conditions in plain words, shown before the first download. */
    terms: z.array(Text).min(1),
    /** Which graph builder in @hildegard/comfy renders this model. */
    graph: z.enum(['ltx-2.5-distilled', 'ltx-2-distilled', 'wan-2.2-ti2v']),
    /** Final quality renders at half size and upsamples the latent (LTX's two-stage recipe). */
    twoStageFinal: z.boolean().default(true),
    minVramGb: z.number().positive(),
    /** False when its weights need int8 or fp8 kernels that Apple's GPU (MPS) lacks. */
    mps: z.boolean().default(true),
    fps: z.number().int().positive(),
    /** Frames come in multiples of this, plus one: 8n+1 for LTX, 4n+1 for Wan. */
    frameMultiple: z.number().int().positive(),
    maxSeconds: z.number().positive(),
    audio: z.boolean(),
    draft: Quality,
    final: Quality,
    files: z.array(ModelFile),
    loras: z.record(Id, ModelFile).default({}),
  })
  .strict();

export const Catalog = z
  .object({
    version: z.number().int(),
    bodies: z.array(Body).min(1),
    lenses: z.array(Lens).min(1),
    focals: z.array(Focal).min(1),
    motions: z.array(Motion).min(1),
    lightings: z.array(Lighting).min(1),
    palettes: z.array(Palette).min(1),
    genres: z.array(Named).min(1),
    eras: z.array(Named).min(1),
    aspects: z.array(Aspect).min(1),
    durations: z.array(z.number().positive()).min(1),
    models: z.array(Model).min(1),
  })
  .strict();

export type Catalog = z.infer<typeof Catalog>;
export type Body = z.infer<typeof Body>;
export type Lens = z.infer<typeof Lens>;
export type Focal = z.infer<typeof Focal>;
export type Motion = z.infer<typeof Motion>;
export type MotionImpl = z.infer<typeof MotionImpl>;
export type Lighting = z.infer<typeof Lighting>;
export type Palette = z.infer<typeof Palette>;
export type Named = z.infer<typeof Named>;
export type Aspect = z.infer<typeof Aspect>;
export type Model = z.infer<typeof Model>;
export type ModelFile = z.infer<typeof ModelFile>;

/** What a person (or an agent) asks for: one shot, any number of takes. */
export const ShotRequest = z
  .object({
    prompt: z.string().trim().min(1, 'Describe the shot').max(2000),
    rig: z
      .object({
        body: Id,
        lens: Id,
        focal: z.number().int(),
        aperture: z.number().min(1).max(22),
      })
      .strict(),
    motion: z
      .array(z.object({ id: Id, strength: z.number().min(0).max(1).default(0.8) }).strict())
      .max(2, 'Pick up to two motions')
      .default([]),
    look: z
      .object({ lighting: Id.optional(), palette: Id.optional(), genre: Id.optional(), era: Id.optional() })
      .strict()
      .default({}),
    format: z
      .object({
        aspect: z.string().default('16:9'),
        seconds: z.number().positive().max(20).default(5),
        quality: z.enum(['draft', 'final']).default('final'),
      })
      .strict()
      .default({ aspect: '16:9', seconds: 5, quality: 'final' }),
    model: Id.optional(),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .optional(),
    takes: z.number().int().min(1).max(4).default(1),
    /** An uploaded still to start from (image to video). */
    startFrame: z
      .string()
      .regex(/^[a-f0-9]{64}\.(png|jpg|webp)$/)
      .optional(),
  })
  .strict();
export type ShotRequest = z.infer<typeof ShotRequest>;
export type ShotRequestInput = z.input<typeof ShotRequest>;
