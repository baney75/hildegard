// SPDX-License-Identifier: Apache-2.0
/**
 * Characters: who someone is in words and in reference images, so every still and shot draws the same face and
 * clothes. The stills model (FLUX.2 [klein]) reads up to four reference images at once and keeps who is in them.
 */
import { z } from 'zod';
import type { Character, CharacterRef, CharacterView } from './api.ts';
import { frameSize, PresetError } from './compose.ts';
import type { Catalog, Model } from './schema.ts';

/** Images a stills render reads at most, across every character in it. */
export const MAX_REFERENCES = 4;
/** Images a character keeps; the best four go into each render. */
export const MAX_CHARACTER_REFS = 8;

const Name = z
  .string()
  .trim()
  .min(1, 'Give the character a name')
  .max(60, 'Names up to 60 characters')
  .refine((s) => !/[\n\r]/.test(s), 'One line for the name');
const Description = z.string().trim().max(600, 'Describe them in up to 600 characters');
const Wardrobe = z.string().trim().max(300, 'Describe the outfit in up to 300 characters');

export const CreateCharacter = z
  .object({
    name: Name,
    description: Description.default(''),
    wardrobe: Wardrobe.default(''),
    likeness: z.enum(['invented', 'real']).default('invented'),
  })
  .strict();
export type CreateCharacter = z.infer<typeof CreateCharacter>;

export const EditCharacter = z
  .object({
    name: Name.optional(),
    description: Description.optional(),
    wardrobe: Wardrobe.optional(),
    voice: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'Unknown voice')
      .nullable()
      .optional(),
    cover: z
      .string()
      .regex(/^[a-f0-9]{64}\.(png|jpg|webp)$/)
      .nullable()
      .optional(),
  })
  .strict();
export type EditCharacter = z.infer<typeof EditCharacter>;

export const CharacterViewSchema = z.enum(['portrait', 'three-quarter', 'profile', 'full-body']);

/** POST /api/characters/:id/stills */
export const StillRequest = z
  .object({
    view: CharacterViewSchema.default('portrait'),
    /** Takes of it, each with its own seed: four portraits to pick a face from, say. */
    count: z.number().int().min(1).max(4).default(1),
    /** Extra words for this still only: a setting, a mood, an expression. */
    note: z.string().trim().max(300).default(''),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .optional(),
    priority: z.enum(['forced', 'interactive', 'agent']).optional(),
  })
  .strict();
export type StillRequest = z.infer<typeof StillRequest>;

/** How each view is asked for. */
export const VIEW_WORDS: Record<CharacterView, { name: string; prompt: string; aspect: string }> = {
  portrait: {
    name: 'Portrait',
    prompt:
      'head-and-shoulders portrait, facing the camera, looking straight into the lens, neutral expression',
    aspect: '1:1',
  },
  'three-quarter': {
    name: 'Three-quarter',
    prompt: 'head-and-shoulders portrait, head turned three-quarters to the left',
    aspect: '1:1',
  },
  profile: {
    name: 'Profile',
    prompt: 'head-and-shoulders portrait in strict side profile, facing left',
    aspect: '1:1',
  },
  'full-body': {
    name: 'Full body',
    prompt: 'full-length shot from head to feet, standing relaxed, arms at the sides, whole outfit visible',
    aspect: '9:16',
  },
};

/** The order a sheet is made and references are read in: the face first, then the outfit, then the other angles. */
const VIEW_RANK: Record<CharacterView, number> = {
  portrait: 0,
  'full-body': 1,
  'three-quarter': 2,
  profile: 3,
};

/** Whether a character may appear in renders now: real people only with consent that stands. */
export function usable(c: Character): { ok: true } | { ok: false; why: string } {
  if (c.likeness === 'real' && c.consent?.status !== 'active')
    return {
      ok: false,
      why:
        c.consent?.status === 'revoked'
          ? `${c.name}’s consent was taken back, so Hildegard won’t draw them anymore.`
          : `${c.name} is based on a real person, who hasn’t given consent yet.`,
    };
  return { ok: true };
}

/** The references a render reads for one character: the cover first, then one of each view, best first. */
export function pickRefs(c: Character, max: number): CharacterRef[] {
  const sorted = [...c.references].sort((a, b) => {
    const cover = Number(b.file === c.cover) - Number(a.file === c.cover);
    if (cover) return cover;
    return (a.view ? VIEW_RANK[a.view] : 9) - (b.view ? VIEW_RANK[b.view] : 9);
  });
  // One per view before any second of a view: angles say more about a face than repeats do.
  const seen = new Set<string>();
  const firsts = sorted.filter((r) => {
    const k = r.view ?? r.file;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const rest = sorted.filter((r) => !firsts.includes(r));
  return [...firsts, ...rest].slice(0, max);
}

/** Split the reference budget between characters, as evenly as it goes; each gets at least one. */
export function castRefs(cast: readonly Character[]): Array<{ character: Character; refs: CharacterRef[] }> {
  const each = Math.max(1, Math.floor(MAX_REFERENCES / Math.max(1, cast.length)));
  let spare = MAX_REFERENCES - each * cast.length;
  return cast.map((character) => {
    const extra = spare > 0 && character.references.length > each ? 1 : 0;
    spare -= extra;
    return { character, refs: pickRefs(character, each + extra) };
  });
}

const clean = (s: string) =>
  s
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '');

/** "Mara, early thirties, auburn braid…, wearing an undyed linen shirt": how a prompt names a character. */
export function describe(c: Pick<Character, 'name' | 'description' | 'wardrobe'>): string {
  return [clean(c.name), clean(c.description), c.wardrobe.trim() ? `wearing ${clean(c.wardrobe)}` : '']
    .filter(Boolean)
    .join(', ');
}

/** "image 1", "images 2 and 3": how FLUX.2 prompts point at reference images, in the order the graph feeds them. */
export function imageWords(from: number, count: number): string {
  if (count <= 0) return '';
  if (count === 1) return `image ${from}`;
  const n = Array.from({ length: count }, (_, i) => from + i);
  return `images ${n.slice(0, -1).join(', ')} and ${n.at(-1)}`;
}

/** Everything a stills graph needs, with no catalog lookups left to do. */
export interface ComposedStill {
  model: Model;
  prompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  /** The reference images, in the order the graph reads them: uploads-folder file names. */
  references: string[];
  guard: { classifier: string; threshold: number };
}

/** The stills model: the one named, or the first in the catalog. */
export function pickStillModel(catalog: Catalog, id?: string): Model {
  const stills = catalog.models.filter((m) => m.kind === 'image');
  const m = id ? stills.find((x) => x.id === id) : stills[0];
  if (!m) throw new PresetError(id ? 'Unknown stills model' : 'This catalog has no stills model', 'model');
  return m;
}

const guardOf = (catalog: Catalog) => ({
  classifier: catalog.safety.classifier.path.split('/').pop()!,
  threshold: catalog.safety.threshold,
});

/**
 * One view of a character: a reference photo on a plain ground, so the next render can read the face and the outfit
 * cleanly. Once the character has references, the new view keeps to them.
 */
export function composeCharacterStill(
  catalog: Catalog,
  c: Character,
  view: CharacterView,
  opts: { note?: string; quality?: 'draft' | 'final'; model?: string } = {},
): ComposedStill {
  const model = pickStillModel(catalog, opts.model);
  const words = VIEW_WORDS[view];
  const aspect = catalog.aspects.find((a) => a.id === words.aspect) ?? catalog.aspects[0]!;
  const q = model[opts.quality ?? 'final'];
  const refs = pickRefs(c, MAX_REFERENCES).map((r) => r.file);
  const keep = refs.length
    ? `The same person as in reference ${imageWords(1, refs.length)}: keep their face, hair, build and clothes exactly`
    : '';
  const prompt = [
    `Character reference photograph of ${describe(c)}`,
    keep,
    words.prompt,
    opts.note ? clean(opts.note) : '',
    'Plain light grey studio backdrop, soft even key light, sharp focus, natural skin texture, true colour, photographic',
  ]
    .filter(Boolean)
    .map((s) => `${s[0]!.toUpperCase()}${s.slice(1)}`)
    .join('. ');
  return {
    model,
    prompt: `${prompt}.`,
    ...frameSize(aspect, q.height, false),
    steps: q.steps,
    cfg: q.cfg,
    references: refs,
    guard: guardOf(catalog),
  };
}

/**
 * A shot's start frame, drawn from its cast's references: the shot's own words with each character named and pointed
 * at their reference images. Rendered at the stills model's final size, then scaled to the shot's frame.
 */
export function composeKeyframe(
  catalog: Catalog,
  shot: { action: string; look: string; aspect: { width: number; height: number } },
  cast: readonly Character[],
): ComposedStill {
  const model = pickStillModel(catalog);
  const q = model.final;
  let at = 1;
  const references: string[] = [];
  const who = castRefs(cast).map(({ character, refs }) => {
    const words = `${describe(character)} (the person in reference ${imageWords(at, refs.length)})`;
    at += refs.length;
    references.push(...refs.map((r) => r.file));
    return words;
  });
  const prompt = [
    clean(shot.action),
    `In the frame: ${who.join('; ')}. Keep each face, hair and outfit exactly as in their references`,
    clean(shot.look),
    'A single cinematic film still, photographic',
  ]
    .filter(Boolean)
    .join('. ');
  return {
    model,
    prompt: `${prompt}.`,
    ...frameSize(shot.aspect, q.height, false),
    steps: q.steps,
    cfg: q.cfg,
    references,
    guard: guardOf(catalog),
  };
}

/** Every word a character carries into prompts, for the safety check. */
export function characterText(c: Pick<Character, 'name' | 'description' | 'wardrobe'>): string {
  return [c.name, c.description, c.wardrobe].join('\n');
}

/** "Three-quarter", for a reference's label. */
export function viewName(v: CharacterView | null): string {
  return v ? VIEW_WORDS[v].name : 'Reference';
}

export const CHARACTER_VIEWS: readonly CharacterView[] = [
  'portrait',
  'three-quarter',
  'profile',
  'full-body',
];
