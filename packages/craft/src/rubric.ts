// SPDX-License-Identifier: AGPL-3.0-only
/**
 * What "slop" means in Hildegard, and the questions an agent answers about its own work before it shows anyone.
 * Questions are yes/no about things you can point at in the frame, so a small model can answer them honestly; every
 * "no" names what to change. docs/craft.md explains each one at length.
 */
import type { Medium } from './lint.ts';

export const SLOP =
  'Slop is generated work whose choices were left to the model’s defaults: nobody decided what it is for, what is in the frame, or what to cut, and nobody looked hard at it before it shipped. You can see it in the result as the average look (glossy, oversaturated, centred, glowing), as mistakes nobody fixed (melting hands, garbled text, flicker, faces that change between shots, sound that clips), and as filler (more takes, more shots and more words than the idea needs).';

export interface Question {
  id: string;
  /** Answer yes or no, by pointing at the frame, the time or the line that shows it. */
  ask: string;
  /** What to change when the answer is no. */
  fix: string;
}

const PICTURE: Question[] = [
  {
    id: 'intent',
    ask: 'Can you say in one sentence what this is for and who it is for, and does the frame serve that sentence?',
    fix: 'Write that sentence first. Then cut or change whatever in the frame doesn’t serve it.',
  },
  {
    id: 'subject',
    ask: 'Is there one clear thing to look at first, placed on purpose (not just dead centre by default)?',
    fix: 'Pick the subject, then place it: off-centre on a third, or centred for a reason (symmetry, confrontation).',
  },
  {
    id: 'specific',
    ask: 'Is there a specific, unexpected detail that makes this place and person particular rather than generic?',
    fix: 'Add one true detail to the prompt: a worn object, a local material, a particular weather.',
  },
  {
    id: 'anatomy',
    ask: 'Are hands, faces, teeth, eyes and limbs whole and correct in every frame you checked?',
    fix: 'Choose another take or seed, frame tighter or wider to avoid the hands, or simplify the action.',
  },
  {
    id: 'text',
    ask: 'Is every piece of visible writing (signs, labels, screens) either correct or absent?',
    fix: 'Remove writing from the prompt and add real text afterwards in an edit, or frame it out.',
  },
  {
    id: 'light',
    ask: 'Does the light come from a place that exists in the scene, with shadows that agree with it?',
    fix: 'Name the source in the prompt (a window on the left, a sodium street lamp) and the time of day.',
  },
  {
    id: 'colour',
    ask: 'Is colour natural or deliberately graded, without the oversaturated, teal-and-orange, glowing look?',
    fix: 'Choose a palette preset or describe a restrained one; grade down saturation in the edit.',
  },
  {
    id: 'surface',
    ask: 'Do skin, cloth and materials have real texture, not the waxy, airbrushed, plastic look?',
    fix: 'Describe the material (pores, wool, rust) and use a film body preset for grain; avoid "perfect" and "flawless".',
  },
];

const MOTION: Question[] = [
  {
    id: 'one-action',
    ask: 'Does the shot hold one readable action that starts and lands, without morphing between ideas?',
    fix: 'One action per shot. Split extra beats into their own shots.',
  },
  {
    id: 'motivated-camera',
    ask: 'Does the camera move for a reason (follow, reveal, close in on a feeling), or hold still?',
    fix: 'Lock the camera, or pick the one move that serves the moment.',
  },
  {
    id: 'stable',
    ask: 'Do objects and people keep their shape, count and identity from start to end (no melting, popping, flicker)?',
    fix: 'Another seed, a shorter clip, less motion strength, or a start frame to anchor it.',
  },
  {
    id: 'physics',
    ask: 'Do weight, speed and contact look right: feet on the ground, liquids falling, cloth moving with the body?',
    fix: 'Slow the action, simplify it, or choose a take where it holds.',
  },
];

const SEQUENCE: Question[] = [
  {
    id: 'continuity',
    ask: 'Across shots, do faces, wardrobe, props, light direction and time of day stay the same where they should?',
    fix: 'Repeat the exact descriptions shot to shot, reuse a start frame, keep lighting and palette presets fixed.',
  },
  {
    id: 'cut',
    ask: 'Does each cut change something (size, angle, information) and land on an action or a look?',
    fix: 'Reorder or drop shots. A sequence is better shorter than padded.',
  },
  {
    id: 'length',
    ask: 'Is it as short as the idea allows, with no shot that is there only to fill time?',
    fix: 'Cut the weakest shot and watch it again.',
  },
];

const SOUND: Question[] = [
  {
    id: 'fits',
    ask: 'Does the sound belong to what is on screen (place, distance, energy), not stock “epic” filler?',
    fix: 'Describe the actual sources and space; for music name instruments, tempo and form.',
  },
  {
    id: 'clean',
    ask: 'Is it free of clicks at cuts, sudden level jumps, robotic artefacts and clipping?',
    fix: 'Short fades at every cut, level-match, re-generate the bad line, normalise to about -14 LUFS.',
  },
];

const VOICE: Question[] = [
  {
    id: 'delivery',
    ask: 'Does the voice vary pace and pitch with the meaning, with breaths and stresses where a person would put them?',
    fix: 'Rewrite the line for speaking (short sentences, punctuation for pauses), then re-generate.',
  },
  {
    id: 'consent',
    ask: 'Is the voice either synthetic or one whose owner has agreed to this use?',
    fix: 'Stop. Never clone or imitate a real person’s voice without their consent.',
  },
];

const WORDS: Question[] = [
  {
    id: 'plain',
    ask: 'Is every sentence plain and specific, free of stock phrases (“delve”, “tapestry”, “in a world where”)?',
    fix: 'Say the plain thing with a concrete noun or number from this project.',
  },
  {
    id: 'true',
    ask: 'Is every claim true of this work, with nothing oversold (“stunning”, “breathtaking”)?',
    fix: 'Describe what it is and let the viewer judge.',
  },
];

/** Questions everything must pass, whatever the medium. */
const ALWAYS: Question[] = [
  {
    id: 'looked',
    ask: 'Did you actually look at the result (the contact sheet, the frames, or listened through) rather than assume?',
    fix: 'Look now. Never describe or deliver work you haven’t seen or heard.',
  },
  {
    id: 'people',
    ask: 'Is every real, identifiable person in it there with their consent, and nobody shown doing what they didn’t do?',
    fix: 'Stop. Hildegard doesn’t make deepfakes or put real people in scenes they didn’t agree to.',
  },
];

export function rubric(medium: Medium | 'sequence'): Question[] {
  switch (medium) {
    case 'image':
      return [...PICTURE, ...ALWAYS];
    case 'video':
      return [...PICTURE, ...MOTION, ...ALWAYS];
    case 'sequence':
      return [...PICTURE, ...MOTION, ...SEQUENCE, ...SOUND, ...ALWAYS];
    case 'music':
      return [...SOUND, ...WORDS, ...ALWAYS];
    case 'voice':
      return [...VOICE, ...SOUND, ...ALWAYS];
    case 'words':
      return [...WORDS, ...ALWAYS];
  }
}

/** The rubric as a numbered list, to answer one line each: `id: yes|no, evidence`. */
export function describeRubric(medium: Medium | 'sequence'): string {
  return [
    'Answer each, one line each, as `id: yes|no — the frame, time or line that shows it`. Any "no" means change something and render again (at most three rounds), or tell your user plainly what is still wrong.',
    ...rubric(medium).map((q, i) => `${i + 1}. ${q.id}: ${q.ask} If no: ${q.fix}`),
  ].join('\n');
}
