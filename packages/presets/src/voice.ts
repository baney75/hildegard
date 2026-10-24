// SPDX-License-Identifier: Apache-2.0
/**
 * Voice: the models, built-in voices and audio tags in `presets/voices.toml`, what a person (or an agent) asks for,
 * and how a script with tags and pauses becomes the segments a model speaks. Shared by the server, the Studio and
 * the MCP tools.
 */
import { parse } from 'smol-toml';
import { z } from 'zod';
import type { SafetyCheck } from './safety.ts';
import { Id, type ModelLock } from './schema.ts';

const Text = z.string().min(1).max(400);
const Lang = z.string().regex(/^[a-z]{2}$/, 'a two-letter language code');

export const VoiceCan = z.enum(['speak', 'clone', 'design', 'convert', 'transcribe']);
export type VoiceCan = z.infer<typeof VoiceCan>;
/** The Studio's sliders and fields. A model that doesn't honour one shows it greyed out, with the reason. */
export const VoiceControl = z.enum(['speed', 'expressiveness', 'stability', 'variety', 'direction']);
export type VoiceControl = z.infer<typeof VoiceControl>;

export const VoiceFile = z
  .object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    path: z
      .string()
      .min(1)
      .refine(
        (p) => !p.split('/').includes('..') && !p.startsWith('/') && !p.includes('\\'),
        'relative path inside the repo',
      ),
    size: z.number().int().positive(),
    gated: z.boolean().default(false),
  })
  .strict();
export type VoiceFile = z.infer<typeof VoiceFile>;

export const VoiceModel = z
  .object({
    id: Id,
    name: Text,
    /** Which backend in voice-engine/hildegard_voice/backends runs it. */
    engine: z.enum(['kokoro', 'chatterbox', 'qwen3-tts', 'whisper']),
    /** The Python environment it runs in: voice-engine/requirements/<env>.txt. */
    env: z.enum(['speech', 'chatterbox', 'qwen']),
    blurb: Text,
    license: Text,
    licenseUrl: z.string().url(),
    terms: z.array(Text).min(1),
    can: z.array(VoiceCan).min(1),
    controls: z.array(VoiceControl),
    languages: z.array(Lang),
    /** GPU memory it wants; 0 runs well enough on a CPU. */
    minVramGb: z.number().min(0),
    files: z.array(VoiceFile).min(1),
  })
  .strict();
export type VoiceModel = z.infer<typeof VoiceModel>;

export const BuiltinVoice = z
  .object({
    id: Id,
    model: Id,
    /** The model's own name for it: a Kokoro voice file, or `default` for Chatterbox's built-in voice. */
    preset: z.string().regex(/^[a-z0-9_]{1,40}$/),
    name: Text,
    language: Lang,
    accent: Text,
    gender: z.enum(['female', 'male', 'neutral']),
    blurb: Text,
    uses: z.array(z.string().max(40)).default([]),
  })
  .strict();
export type BuiltinVoice = z.infer<typeof BuiltinVoice>;

export const VoiceTag = z
  .object({
    id: z.string().regex(/^[a-z][a-z ]{0,30}[a-z]$/),
    group: z.enum(['emotion', 'delivery', 'sound']),
    /** Acting direction for models that take one (Qwen3-TTS). */
    direction: Text,
    /** How much it raises (or lowers) Chatterbox's expressiveness, -1 to 1. */
    lift: z.number().min(-1).max(1),
  })
  .strict();
export type VoiceTag = z.infer<typeof VoiceTag>;

export const ConsentRules = z
  .object({
    encoder: VoiceFile,
    sameSpeaker: z.number().min(0.5).max(0.99),
    phraseMinutes: z.number().int().min(1).max(60),
    phraseMatch: z.number().min(0.5).max(1),
    markedAbove: z.number().min(0.05).max(0.95),
    quickSeconds: z.number().min(3),
    proSeconds: z.number().min(60),
  })
  .strict();
export type ConsentRules = z.infer<typeof ConsentRules>;

export const VoiceCatalog = z
  .object({
    consent: ConsentRules,
    models: z.array(VoiceModel).min(1),
    voices: z.array(BuiltinVoice),
    tags: z.array(VoiceTag),
  })
  .strict();
export type VoiceCatalog = z.infer<typeof VoiceCatalog>;

/** A voice model file's key in models.lock.json, the same shape as a video model's. */
export const voiceLockKey = (f: { repo: string; path: string }) => `${f.repo}/${f.path}`;

export function parseVoiceCatalog(toml: string, lock?: ModelLock, safety?: SafetyCheck): VoiceCatalog {
  const catalog = VoiceCatalog.parse(parse(toml));
  const problems = checkVoiceCatalog(catalog, lock, safety);
  if (problems.length)
    throw new Error(`Voice catalog has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  return catalog;
}

export function checkVoiceCatalog(c: VoiceCatalog, lock?: ModelLock, safety?: SafetyCheck): string[] {
  const problems: string[] = [];
  const twice = (what: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`${what} "${id}" is defined twice`);
      seen.add(id);
    }
  };
  twice(
    'voice model',
    c.models.map((m) => m.id),
  );
  twice(
    'voice',
    c.voices.map((v) => v.id),
  );
  twice(
    'tag',
    c.tags.map((t) => t.id),
  );
  const models = new Map(c.models.map((m) => [m.id, m]));
  for (const v of c.voices) {
    const m = models.get(v.model);
    if (!m) {
      problems.push(`voice "${v.id}" uses unknown model "${v.model}"`);
      continue;
    }
    if (!m.can.includes('speak')) problems.push(`voice "${v.id}": ${m.name} can't speak in its own voices`);
    if (m.engine === 'kokoro' && !m.files.some((f) => f.path === `voices/${v.preset}.pt`))
      problems.push(`voice "${v.id}": Kokoro's voices/${v.preset}.pt isn't in its files`);
    if (m.languages.length && !m.languages.includes(v.language))
      problems.push(`voice "${v.id}" speaks ${v.language}, which ${m.name} doesn't`);
  }
  for (const m of c.models) {
    twice(
      `file of ${m.id}`,
      m.files.map((f) => f.path),
    );
    for (const f of m.files) {
      const pin = lock?.files[voiceLockKey(f)];
      if (pin && Math.abs(pin.size - f.size) / pin.size > 0.25)
        problems.push(`${voiceLockKey(f)}: size in voices.toml is far from the locked size; update it`);
      const why = safety?.model({
        repo: f.repo,
        name: m.name,
        description: m.blurb,
        files: [{ name: f.path }],
      });
      if (why?.length) problems.push(`${voiceLockKey(f)} is refused: ${why.join('; ')}`);
    }
  }
  if (!c.models.some((m) => m.can.includes('transcribe')))
    problems.push('no model can transcribe, so no clone can pass the consent check');
  return problems;
}

// ── Scripts ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A piece of a paragraph: words to speak, a tag in brackets (never spoken), or a pause. */
export type ScriptPart =
  | { kind: 'text'; text: string }
  | { kind: 'tag'; id: string; known: boolean }
  | { kind: 'pause'; seconds: number };

const PAUSE = /^(?:pause|break)(?:\s+(\d+(?:\.\d+)?)\s*(ms|s)?)?$/;
const MAX_PAUSE = 10;

/**
 * Split a paragraph into words, `[tags]` and `[pause 0.5s]`. Brackets that don't close are words. `[[` is a literal
 * bracket. Tags are matched without case; an unknown tag is kept (and flagged) rather than spoken.
 */
export function parseScript(text: string, tags: readonly VoiceTag[]): ScriptPart[] {
  const known = new Set(tags.map((t) => t.id));
  const parts: ScriptPart[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = parts.at(-1);
    if (last?.kind === 'text') last.text += t;
    else parts.push({ kind: 'text', text: t });
  };
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('[', i);
    if (open < 0) {
      push(text.slice(i));
      break;
    }
    push(text.slice(i, open));
    if (text[open + 1] === '[') {
      push('[');
      i = open + 2;
      continue;
    }
    const close = text.indexOf(']', open + 1);
    const inner =
      close < 0
        ? null
        : text
            .slice(open + 1, close)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');
    if (inner === null || !inner || inner.length > 40 || inner.includes('[')) {
      push('[');
      i = open + 1;
      continue;
    }
    const p = PAUSE.exec(inner);
    if (p) {
      const n = p[1] ? Number(p[1]) : 0.5;
      const seconds = p[2] === 'ms' ? n / 1000 : n;
      parts.push({ kind: 'pause', seconds: Math.min(MAX_PAUSE, Math.max(0, seconds)) });
    } else parts.push({ kind: 'tag', id: inner, known: known.has(inner) });
    i = close + 1;
  }
  return parts;
}

/** What a paragraph says aloud: its words alone, without tags or pauses. */
export function spokenText(text: string, tags: readonly VoiceTag[]): string {
  return parseScript(text, tags)
    .map((p) => (p.kind === 'text' ? p.text : ' '))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One stretch a model speaks in one go. */
export interface Segment {
  text: string;
  language: string;
  /** Acting direction, for models that take it. */
  instruct?: string;
  /** Silence after it, in seconds. */
  pause?: number;
  /** Expressiveness to add for this stretch, from its tags (-1 to 1). */
  lift?: number;
}

/**
 * A paragraph as segments: split at pauses, each carrying the paragraph's direction and its own tags as direction
 * words (Qwen3-TTS) or an expressiveness lift (Chatterbox). Tags a model can't act on are dropped, never spoken.
 */
export function compileParagraph(
  p: { text: string; direction?: string; language: string },
  tags: readonly VoiceTag[],
): Segment[] {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const out: Segment[] = [];
  let words = '';
  let acting: VoiceTag[] = [];
  const flush = (pause?: number) => {
    const text = words.replace(/\s+/g, ' ').trim();
    if (text) {
      const direction = [p.direction?.trim(), ...acting.map((t) => t.direction)].filter(Boolean).join('; ');
      const lift = acting.reduce((n, t) => n + t.lift, 0);
      const seg: Segment = { text, language: p.language };
      if (direction) seg.instruct = direction.slice(0, 300);
      if (lift) seg.lift = Math.max(-1, Math.min(1, Math.round(lift * 100) / 100));
      if (pause) seg.pause = pause;
      out.push(seg);
    } else if (pause && out.length) {
      out[out.length - 1]!.pause = Math.min(MAX_PAUSE, (out[out.length - 1]!.pause ?? 0) + pause);
    }
    words = '';
    acting = [];
  };
  for (const part of parseScript(p.text, tags)) {
    if (part.kind === 'text') words += part.text;
    else if (part.kind === 'pause') flush(part.seconds);
    else {
      const t = byId.get(part.id);
      if (t) acting.push(t);
    }
  }
  flush();
  return out;
}

// ── Requests ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Sliders, 0 to 1, labelled in words at both ends; speed is a rate. */
export const VoiceSettings = z
  .object({
    speed: z.number().min(0.5).max(2).default(1),
    /** More stable (0) to more expressive (1). */
    expressiveness: z.number().min(0).max(1).default(0.5),
    /** Looser (0) to closer to the voice (1). */
    stability: z.number().min(0).max(1).default(0.5),
    /** The same each time (0) to more varied (1). */
    variety: z.number().min(0).max(1).default(0.5),
  })
  .strict();
export type VoiceSettings = z.infer<typeof VoiceSettings>;

const VoiceRef = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'a voice id from list_voices');
const MAX_SCRIPT = 50_000;

export const SpeakRequest = z
  .object({
    paragraphs: z
      .array(
        z
          .object({
            text: z.string().trim().min(1, 'Write something to say').max(5000),
            /** This paragraph's voice, when it isn't the request's. */
            voice: VoiceRef.optional(),
            /** One line of acting direction: "hushed, close to the mic". */
            direction: z.string().trim().max(100).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(400)
      .refine(
        (ps) => ps.reduce((n, p) => n + p.text.length, 0) <= MAX_SCRIPT,
        'The script is too long; split it',
      ),
    voice: VoiceRef,
    /** Which model speaks; the voice's own by default. */
    model: Id.optional(),
    language: Lang.optional(),
    settings: VoiceSettings.default({ speed: 1, expressiveness: 0.5, stability: 0.5, variety: 0.5 }),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .optional(),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type SpeakRequest = z.infer<typeof SpeakRequest>;
export type SpeakRequestInput = z.input<typeof SpeakRequest>;

export const DesignRequest = z
  .object({
    /** The voice in words: who, age, accent, timbre, pace, mood. */
    description: z.string().trim().min(8, 'Describe the voice in a few words').max(500),
    /** What the candidates say. */
    text: z.string().trim().min(1).max(600),
    language: Lang.default('en'),
    candidates: z.number().int().min(1).max(3).default(3),
    seed: z
      .number()
      .int()
      .min(0)
      .max(2 ** 32 - 1)
      .optional(),
  })
  .strict();
export type DesignRequest = z.infer<typeof DesignRequest>;

const Upload = z
  .string()
  .regex(/^[a-f0-9]{64}\.(wav|mp3|m4a|ogg|flac|webm|mp4|mov)$/, 'an uploaded recording');

export const ConvertRequest = z
  .object({
    /** The recording to say again in another voice. */
    source: Upload,
    voice: VoiceRef,
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type ConvertRequest = z.infer<typeof ConvertRequest>;

export const DubRequest = z
  .object({
    source: Upload,
    /** The language to dub into. */
    language: Lang,
    /** Who speaks the dub: a voice from the library. */
    voice: VoiceRef,
    /** The translation, line by line, when you have one; otherwise a local model translates. */
    lines: z
      .array(
        z.object({
          start: z.number().min(0),
          end: z.number().min(0),
          text: z.string().trim().min(1).max(2000),
        }),
      )
      .max(2000)
      .optional(),
    title: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
export type DubRequest = z.infer<typeof DubRequest>;

export const TranscribeRequest = z
  .object({ source: Upload, language: Lang.optional(), title: z.string().trim().min(1).max(120).optional() })
  .strict();
export type TranscribeRequest = z.infer<typeof TranscribeRequest>;

// ── Controls ────────────────────────────────────────────────────────────────────────────────────────────────────

export const CONTROL_NAMES: Record<VoiceControl, string> = {
  speed: 'Speed',
  expressiveness: 'Expressiveness',
  stability: 'Similarity',
  variety: 'Variety',
  direction: 'Acting direction',
};

/**
 * Whether a model honours a control, and when it doesn't, which installed (or catalog) model does: "Kokoro doesn't
 * support this. Chatterbox does."
 */
export function controlState(
  model: VoiceModel,
  control: VoiceControl,
  others: readonly VoiceModel[],
): { enabled: boolean; why: string | null } {
  if (model.controls.includes(control)) return { enabled: true, why: null };
  const alt = others.find(
    (m) => m.id !== model.id && m.controls.includes(control) && m.can.some((c) => c !== 'transcribe'),
  );
  return {
    enabled: false,
    why: `${model.name} doesn’t support this.${alt ? ` ${alt.name} does.` : ''}`,
  };
}

/** The Studio's sliders as each engine's own settings. Tags lift expressiveness for one segment. */
export function engineSettings(model: VoiceModel, s: VoiceSettings, lift = 0): Record<string, number> {
  const out: Record<string, number> = { speed: s.speed };
  if (model.engine === 'chatterbox') {
    const e = Math.max(0, Math.min(1, s.expressiveness + lift * 0.5));
    // Chatterbox's own advice: 0.5 and 0.5 for most; more exaggeration wants a lower cfg to keep the pace natural.
    out.exaggeration = Math.round((0.25 + e * 1.25) * 100) / 100;
    out.cfg = Math.round((0.15 + s.stability * 0.7 - Math.max(0, e - 0.5) * 0.3) * 100) / 100;
    out.temperature = Math.round((0.5 + s.variety * 0.6) * 100) / 100;
  } else if (model.engine === 'qwen3-tts') {
    out.temperature = Math.round((0.6 + s.variety * 0.6) * 100) / 100;
  }
  return out;
}

// ── State the Studio and agents see ─────────────────────────────────────────────────────────────────────────────

export type VoiceKind = 'builtin' | 'designed' | 'clone';

/** A voice in the library. */
export interface Voice {
  id: string;
  kind: VoiceKind;
  name: string;
  language: string;
  accent: string | null;
  gender: 'female' | 'male' | 'neutral' | null;
  blurb: string;
  uses: string[];
  /** The model it speaks with by default. */
  model: string;
  /** Models that can speak in it, best first. */
  models: string[];
  /** A short clip to preview, when one exists. */
  preview: string | null;
  createdAt: string | null;
  /** Clones: who agreed, how, and whether that still holds. */
  consent?: ConsentSummary;
  /** Designed voices: the description they came from. */
  description?: string;
  /** Hue for the voice's orb, 0 to 359, the same everywhere it shows. */
  hue: number;
}

export interface ConsentSummary {
  /** The speaker's name as they said it. */
  speaker: string;
  /** Whose voice it is to them: their own, someone who agreed, or a voice actor under license. */
  relation: 'self' | 'agreed' | 'licensed';
  status: 'active' | 'revoked' | 'expired';
  recordedAt: string;
  /** The consent recording, to play. */
  recording: string;
  /** How alike the samples and the consent recording were, lowest first: the encoder's cosine. */
  match: number;
  /** When the license ends, if it does. */
  until: string | null;
  /** The signed certificate, as JSON. */
  certificate: string;
}

/** What the consent check found. Every part must pass before a voice is cloned. */
export interface ConsentCheck {
  ok: boolean;
  /** Whisper heard the consent line: every random word, and most of the rest. */
  heard: { ok: boolean; text: string; score: number; missing: string[] };
  /** The consent recording doesn’t carry Hildegard’s AI watermark. */
  live: { ok: boolean; score: number };
  /** Every sample is the voice that read the line. */
  speaker: { ok: boolean; scores: number[]; lowest: number };
  /** Enough speech to clone from. */
  length: { ok: boolean; seconds: number; need: number };
  /** Plain sentences saying what failed. */
  why: string[];
}

/** A clone being made: the consent line, the recording, the samples and the check. */
export interface ConsentSessionView {
  id: string;
  speaker: string;
  relation: ConsentSummary['relation'];
  language: string;
  line: string;
  expiresAt: string;
  /** Where the speaker can record on their own phone, when this Hildegard has an https link. */
  link: string | null;
  recording: { url: string; seconds: number; via: 'here' | 'link' } | null;
  samples: Array<{ name: string; url: string; seconds: number; quality: SampleQuality }>;
  checking: boolean;
  check: ConsentCheck | null;
  /** The voice made from it, once made. */
  voice: string | null;
}

/** How clean a sample is, from its levels. A tip says what to change when something isn’t right. */
export interface SampleQuality {
  level: 'ok' | 'quiet' | 'clipped';
  noise: 'ok' | 'noisy';
  tip: string | null;
}

/** Quality from the engine's analysis of a recording. */
export function sampleQuality(a: { peakDb?: number; snrDb?: number; clipping?: number }): SampleQuality {
  const level = (a.clipping ?? 0) > 0.001 ? 'clipped' : (a.peakDb ?? 0) < -24 ? 'quiet' : ('ok' as const);
  const noise = (a.snrDb ?? 99) < 20 ? 'noisy' : ('ok' as const);
  const tip =
    level === 'clipped'
      ? 'It’s too loud in places. Move back from the mic a little.'
      : level === 'quiet'
        ? 'It’s very quiet. Move closer to the mic.'
        : noise === 'noisy'
          ? 'There’s background noise. A quieter room, or a closet full of clothes, helps.'
          : null;
  return { level, noise, tip };
}

/** What “Is this ours?” found in a recording. */
export interface MarkCheck {
  /** How sure the watermark detector is, 0 to 1. */
  score: number;
  verdict: 'ours' | 'likely' | 'no';
  /** The exact file, when Hildegard made it here. */
  job: { id: string; title: string; voice: string | null; createdAt: string } | null;
}

/** One use of a cloned voice. */
export interface VoiceUse {
  at: string;
  job: string;
  kind: VoiceJobKind;
  title: string;
  /** The Studio, or an agent by name. */
  by: string;
  seconds: number | null;
  sha256: string | null;
}

export type VoiceJobKind = 'speak' | 'design' | 'convert' | 'dub' | 'transcribe' | 'clone-check';
export type VoiceJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'canceled';

export interface VoiceJob {
  id: string;
  kind: VoiceJobKind;
  status: VoiceJobStatus;
  title: string;
  /** The voice it speaks in, when it speaks. */
  voice: string | null;
  model: string;
  /** The Studio, or an agent by name. */
  source: { kind: 'studio' } | { kind: 'agent'; name: string };
  priority: 'forced' | 'interactive' | 'agent';
  queuePosition: number | null;
  progress: { done: number; total: number } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  ms: number | null;
  /** Which device made it. */
  device: string | null;
  error: { code: string; message: string; hint: string; detail?: string } | null;
  /** The finished clip (or clips: design makes candidates). */
  audio: string[];
  seconds: number | null;
  /** Where each paragraph starts and ends in the clip, for highlighting as it plays. */
  segments: Array<{ start: number; end: number }> | null;
  /** Transcribe: the transcript. */
  transcript?: Transcript;
  /** What it was asked to do, as sent. */
  request: unknown;
  seed: number | null;
  kept: boolean;
}

export interface Transcript {
  language: string;
  seconds: number;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
    words: Array<{ start: number; end: number; word: string; p?: number }>;
  }>;
}

export interface VoiceModelState {
  id: string;
  installed: boolean;
  missingBytes: number;
  downloading: { done: number; total: number; file: string; bytesPerSec: number } | null;
  licenseAccepted: boolean;
  /** The Python environment it runs in is set up. */
  ready: boolean;
  /** Fits this computer's GPU (or runs on its CPU). */
  fit: 'good' | 'slow' | 'no' | null;
  error: string | null;
}

export interface VoiceState {
  /** The models, tags and consent rules from presets/voices.toml. */
  catalog: Omit<VoiceCatalog, 'voices'>;
  voices: Voice[];
  models: VoiceModelState[];
  jobs: VoiceJob[];
  /** Where voice work runs: this computer, or a device in the Choir. */
  device: string;
  /** The engine can run here at all: Python environments set up. */
  engine: { ready: boolean; fake: boolean; problem: string | null };
}

/** A stable hue from an id, for voice orbs. */
export function voiceHue(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}
