// SPDX-License-Identifier: Apache-2.0
/**
 * Images: a still on its own, from words, or an edit of up to four reference images. The same stills model
 * characters use (FLUX.2 [klein]) draws them, in the same camera language as Cinema: a body, a lens, a focal length,
 * an aperture, lighting, a palette, a genre and an era, each optional.
 */
import { z } from 'zod';
import { type ComposedStill, MAX_REFERENCES, pickStillModel, referencesOf } from './characters.ts';
import { apertureWords, fmtF, frameSize, PresetError } from './compose.ts';
import { type Catalog, Id, type Model } from './schema.ts';

/** An upload in the uploads folder, named by its SHA-256. */
const Upload = z.string().regex(/^[a-f0-9]{64}\.(png|jpg|webp)$/, 'Unknown reference image');

/** POST /api/images */
export const ImageRequest = z
  .object({
    prompt: z.string().trim().min(1, 'Describe the image').max(2000, 'Describe it in up to 2,000 characters'),
    aspect: z.string().default('1:1'),
    quality: z.enum(['draft', 'final']).default('final'),
    /** Images of it, each with its own seed. */
    count: z.number().int().min(1).max(4).default(1),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .optional(),
    /** Images to edit or draw from, in order: "reference image 1" is the first. */
    references: z.array(Upload).max(MAX_REFERENCES, `Up to ${MAX_REFERENCES} reference images`).default([]),
    /** The person asking says the references show no real person, or only artwork they have the rights to. */
    noRealPerson: z.literal(true).optional(),
    /** A camera, as Cinema rigs one. Any part may be left out. */
    camera: z
      .object({
        body: Id.optional(),
        lens: Id.optional(),
        focal: z.number().int().optional(),
        aperture: z.number().min(1).max(22).optional(),
      })
      .strict()
      .default({}),
    look: z
      .object({ lighting: Id.optional(), palette: Id.optional(), genre: Id.optional(), era: Id.optional() })
      .strict()
      .default({}),
    model: Id.optional(),
    priority: z.enum(['forced', 'interactive', 'agent']).optional(),
  })
  .strict()
  .refine((r) => !r.references.length || r.noRealPerson, {
    message:
      'Say that the reference images show no real person. A real person is drawn only as a character they consented to.',
    path: ['noRealPerson'],
  });
export type ImageRequest = z.infer<typeof ImageRequest>;

/** A composed image and the line that names its camera, for its card. */
export interface ComposedImage extends ComposedStill {
  aspect: string;
  quality: 'draft' | 'final';
  summary: string;
}

function find<T>(list: readonly T[], match: (x: T) => boolean, field: string, what: string): T {
  const x = list.find(match);
  if (x === undefined) throw new PresetError(`Unknown ${what}`, field);
  return x;
}

/** "A or B", "A, B or C": the names of the models that read at least this many images, for a refusal. */
function readers(catalog: Catalog, count: number): string {
  const names = catalog.models
    .filter((m): m is Model => m.kind === 'image' && referencesOf(m) >= count)
    .map((m) => m.name);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : (names[0] ?? '');
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * Everything the stills graph needs for one image. The person's words come first and stand as written; the camera
 * and look follow as sentences, and only the parts they picked. References are named in order so an edit can say
 * "the person in image 1" or "the style of image 2".
 */
export function composeImage(catalog: Catalog, req: ImageRequest): ComposedImage {
  const model = pickStillModel(catalog, req.model);
  const reads = referencesOf(model);
  if (req.references.length > reads) {
    const others = readers(catalog, req.references.length);
    const pick = others ? ` Pick ${others}.` : '';
    throw new PresetError(
      reads === 0
        ? `${model.name} draws from words only.${others ? ` Pick ${others} to edit images.` : ' No model here edits images.'}`
        : `${model.name} reads up to ${reads} reference ${reads === 1 ? 'image' : 'images'}, and you gave ${req.references.length}. Use fewer.${pick}`,
      'references',
    );
  }
  const aspect = find(catalog.aspects, (a) => a.id === req.aspect, 'aspect', 'aspect ratio');
  const { camera, look } = req;
  const body = camera.body
    ? find(catalog.bodies, (b) => b.id === camera.body, 'camera.body', 'camera body')
    : undefined;
  const lens = camera.lens
    ? find(catalog.lenses, (l) => l.id === camera.lens, 'camera.lens', 'lens')
    : undefined;
  const focal =
    camera.focal !== undefined
      ? find(catalog.focals, (f) => f.mm === camera.focal, 'camera.focal', 'focal length')
      : undefined;
  const pick = <T extends { id: string }>(
    list: readonly T[],
    id: string | undefined,
    field: string,
    what: string,
  ) => (id ? find(list, (x) => x.id === id, field, what) : undefined);
  const lighting = pick(catalog.lightings, look.lighting, 'look.lighting', 'lighting');
  const palette = pick(catalog.palettes, look.palette, 'look.palette', 'palette');
  const genre = pick(catalog.genres, look.genre, 'look.genre', 'genre');
  const era = pick(catalog.eras, look.era, 'look.era', 'era');

  const words = req.prompt.trim().replace(/[.\s]+$/, '');
  const rig = [
    body?.prompt,
    lens?.prompt,
    focal?.prompt,
    camera.aperture !== undefined ? apertureWords(camera.aperture) : undefined,
  ].filter(Boolean);
  const sentences = [
    words,
    rig.join(', '),
    [lighting?.prompt, palette?.prompt].filter(Boolean).join(', '),
    [genre?.prompt, era?.prompt].filter(Boolean).join(', '),
  ].filter((s) => s.length > 0);
  const q = model[req.quality];
  return {
    model,
    prompt: `${sentences.map(cap).join('. ')}.`,
    ...frameSize(aspect, q.height, false),
    steps: q.steps,
    cfg: q.cfg,
    references: req.references,
    guard: {
      classifier: catalog.safety.classifier.path.split('/').pop()!,
      threshold: catalog.safety.threshold,
    },
    aspect: aspect.id,
    quality: req.quality,
    summary: [
      body?.name,
      lens?.name,
      focal ? `${focal.mm}mm` : undefined,
      camera.aperture !== undefined ? `f/${fmtF(camera.aperture)}` : undefined,
      lighting?.name,
      palette?.name,
      genre?.name,
      era?.name,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}
