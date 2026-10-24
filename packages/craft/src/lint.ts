// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The prompt lint: the words and habits that make generated work look generated, caught before a GPU spends minutes
 * on them. Each finding says what to write instead, so a small model can fix its prompt in one step.
 */

export type Medium = 'video' | 'image' | 'music' | 'voice' | 'words';

export interface Finding {
  id: string;
  /** `fail` must be fixed before rendering; `warn` is a judgment the agent should make on purpose. */
  severity: 'fail' | 'warn';
  /** The words in the prompt that set it off, if any. */
  match?: string[];
  detail: string;
  fix: string;
}

export interface Lint {
  ok: boolean;
  findings: Finding[];
}

/**
 * Words that ask for "quality" instead of describing anything. Models learned them from scraped captions of
 * attention-seeking images, so they pull every result toward the same glossy, oversaturated average.
 */
const BOOSTERS = [
  '4k',
  '8k',
  '16k',
  'uhd',
  'hdr',
  'masterpiece',
  'best quality',
  'high quality',
  'ultra detailed',
  'ultra-detailed',
  'highly detailed',
  'hyper detailed',
  'hyperdetailed',
  'hyperrealistic',
  'hyper-realistic',
  'hyper realistic',
  'photorealistic',
  'ultra realistic',
  'ultra-realistic',
  'award winning',
  'award-winning',
  'trending on artstation',
  'artstation',
  'octane render',
  'unreal engine',
  'ray tracing',
  'sharp focus',
  'intricate details',
  'stunning',
  'breathtaking',
  'gorgeous',
  'beautiful',
  'amazing',
  'epic',
  'majestic',
  'mesmerizing',
  'jaw-dropping',
  'cinematic',
  'dramatic lighting',
  'volumetric lighting',
  'god rays',
  'perfect',
  'professional',
  'vibrant colors',
  'vibrant colours',
];

/** Camera words that belong in Hildegard's camera fields, where they are applied precisely, not in the prompt. */
const CAMERA = [
  'shot on',
  'shot with',
  'lens',
  'mm',
  'f/',
  'aperture',
  'bokeh',
  'depth of field',
  'dolly',
  'tracking shot',
  'crane shot',
  'drone shot',
  'pan left',
  'pan right',
  'zoom in',
  'zoom out',
  'film grain',
  'anamorphic',
  'arri',
  'red camera',
  '35mm film',
  '16mm',
  'kodak',
  'portra',
];

/** Words that, in writing for titles, captions, lyrics or narration, mark text as machine-made. */
const WORDS_CLICHES = [
  'delve',
  'tapestry',
  'testament to',
  'in a world where',
  'unleash',
  'unlock the',
  'elevate',
  'embark on',
  'journey of',
  'symphony of',
  'dance of',
  'a beacon of',
  'ever-evolving',
  'in the realm of',
  'navigate the',
  'game-changer',
  'seamless',
  'whispers of',
  'echoes of',
  'neon-lit',
  'not just',
  'more than just',
];

/** Lyric clichés that make generated songs sound alike. */
const LYRIC_CLICHES = [
  'fire in my soul',
  'set me free',
  'into the night',
  'chasing dreams',
  'chasing the light',
  'heart of gold',
  'rise above',
  'break these chains',
  'we are infinite',
  'neon lights',
  'electric dreams',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** Whole-word, case-insensitive matches of `terms` in `text`, in the order of `terms`. */
function find(text: string, terms: string[]): string[] {
  const hits: string[] = [];
  for (const t of terms) {
    const pattern =
      t === 'mm'
        ? /\b\d{2,3}\s?mm\b/i
        : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'iu');
    const m = text.match(pattern);
    if (m) hits.push(t === 'mm' ? m[0].trim() : t);
  }
  return hits;
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/** A comma-separated heap of tags with no sentence in it, the way scraped image captions read. */
function tagSalad(prompt: string): boolean {
  const parts = prompt
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 5) return false;
  const short = parts.filter((p) => words(p).length <= 3).length;
  return short / parts.length >= 0.7;
}

/** Negative phrasing ("no people", "without text"): most image and video models read the noun and ignore the "no". */
const NEGATION = /\b(no|without|don't|do not|never|avoid)\s+(\w+)/gi;

/** "In the style of <Name Surname>": imitating a working artist by name. */
const ARTIST_STYLE = /\b(in the style of|style of|by the artist)\s+([A-Z][\p{L}'-]+\s+[A-Z][\p{L}'-]+)/u;

/**
 * Lints a prompt for `medium`. `fieldsSetCamera` says the camera, lens and motion come from Hildegard's fields, so
 * camera words in the prompt fight them.
 */
export function lintPrompt(prompt: string, medium: Medium = 'video', fieldsSetCamera = true): Lint {
  const findings: Finding[] = [];
  const text = prompt.trim();
  const n = words(text).length;

  if (medium === 'video' || medium === 'image') {
    const boost = find(text, BOOSTERS);
    if (boost.length)
      findings.push({
        id: 'quality-words',
        severity: 'fail',
        match: boost,
        detail:
          'Words that ask for quality instead of describing something pull every result toward the same glossy, oversaturated average: the generated look.',
        fix: 'Delete them. Spend the words on what is actually there: the material, the weather, the time of day, what the person is doing with their hands.',
      });
    if (fieldsSetCamera) {
      const cam = find(text, CAMERA);
      if (cam.length)
        findings.push({
          id: 'camera-in-prompt',
          severity: 'warn',
          match: cam,
          detail:
            'Camera, lens and movement words in the prompt fight the camera Hildegard sets from its fields.',
          fix: 'Move them to camera_body, lens, focal_mm, aperture and motion (ids from list_presets), and keep the prompt to what happens in front of the camera.',
        });
    }
    if (n < 12)
      findings.push({
        id: 'too-thin',
        severity: 'fail',
        detail: `${n} words leaves the model to fill the frame with its defaults, which is where slop comes from.`,
        fix: 'Write one or two plain sentences: who or what, doing what, where, at what time of day, in what light, with one specific detail nobody would guess (a chipped mug, rain on one window).',
      });
    if (n > 140)
      findings.push({
        id: 'too-much',
        severity: 'warn',
        detail: `${n} words: past about 120, models drop details at random, so you can't tell which ones will appear.`,
        fix: 'Keep the subject, the action, the place and the light. Cut adjectives that repeat an idea.',
      });
    if (tagSalad(text))
      findings.push({
        id: 'tag-salad',
        severity: 'fail',
        detail: 'A comma heap of tags reads like a scraped caption and gets the scraped-caption look.',
        fix: 'Rewrite it as sentences in the order things happen: "A fisherman in a yellow oilskin hauls a crab pot over the rail as spray hits the deck."',
      });
    const neg = [...text.matchAll(NEGATION)].map((m) => m[0]);
    if (neg.length)
      findings.push({
        id: 'negation',
        severity: 'warn',
        match: neg,
        detail:
          'Most image and video models see the noun and ignore the "no", so "no people" can add people.',
        fix: 'Describe what is there instead: "an empty street" rather than "a street with no people".',
      });
    if (medium === 'video') {
      const beats = (text.match(/\b(then|after that|next|finally|suddenly|meanwhile)\b/gi) ?? []).length;
      if (beats >= 2)
        findings.push({
          id: 'too-many-beats',
          severity: 'warn',
          detail:
            'A few seconds of video holds one action. Several "then"s become a blur of half-finished moves and morphing.',
          fix: 'Give each beat its own shot (make_sequence), each with one clear action.',
        });
    }
  }

  if (medium === 'words' || medium === 'music' || medium === 'voice') {
    const cl = find(text, WORDS_CLICHES);
    if (cl.length)
      findings.push({
        id: 'stock-phrases',
        severity: 'fail',
        match: cl,
        detail: 'Phrases that machine-written text leans on. Readers spot them and stop trusting the rest.',
        fix: 'Say the plain thing, with a specific noun or number from this project.',
      });
    const dashes = (text.match(/—/g) ?? []).length;
    if (dashes >= 2 && dashes / Math.max(1, n) > 0.02)
      findings.push({
        id: 'dashes',
        severity: 'warn',
        detail: 'Heavy em-dash use is a tell of generated prose.',
        fix: 'Use full stops and commas; split long sentences.',
      });
  }

  if (medium === 'music') {
    const ly = find(text, LYRIC_CLICHES);
    if (ly.length)
      findings.push({
        id: 'lyric-cliches',
        severity: 'fail',
        match: ly,
        detail: 'Stock lyric lines make every generated song sound like the same song.',
        fix: 'Write from one concrete scene: a place, an object, a name, a time. Let the feeling come from those.',
      });
    if (find(text, ['epic', 'uplifting', 'inspiring', 'cinematic', 'emotional']).length && n < 25)
      findings.push({
        id: 'mood-only',
        severity: 'warn',
        detail: 'A mood word alone gets library music: the same build, the same drop.',
        fix: 'Name the instruments, the tempo in BPM, the key or mode, the form (verse, chorus, bridge) and one reference era or scene.',
      });
  }

  const artist = text.match(ARTIST_STYLE);
  if (artist && medium !== 'words')
    findings.push({
      id: 'named-artist',
      severity: 'warn',
      match: [artist[0]],
      detail:
        'Imitating a working artist by name copies their signature instead of making a choice of your own.',
      fix: 'Describe the qualities you want instead: the palette, the brushwork, the framing, the era.',
    });

  return { ok: !findings.some((f) => f.severity === 'fail'), findings };
}
