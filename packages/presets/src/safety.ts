// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { defaultPresetsDir } from './load.ts';

/**
 * What Hildegard refuses to make or load: sexual content, and anything sexual or suggestive involving children. The
 * lists live in `presets/safety.toml`; this file reads them and checks prompts and model metadata against them. It is
 * the first of three layers (prompts and models here, start frames and rendered frames through the HildegardGuard
 * ComfyUI node, model files by hash in the model manager). See docs/safety.md.
 */

const Words = z.array(z.string().min(1));
export const SafetyPolicy = z
  .object({
    version: z.literal(1),
    prompt: z
      .object({
        sexual: Words,
        sexualPhrases: Words,
        childSexual: Words,
        suggestive: Words,
        minors: Words,
        minorPhrases: Words,
        allowed: Words,
        negations: Words,
      })
      .strict(),
    models: z
      .object({
        blockedTags: Words,
        civitaiBlockedNsfwBits: z.number().int().min(0),
        blockedRepos: Words,
        blockedSha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
        trustedRepos: Words,
      })
      .strict(),
  })
  .strict();
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

export type Refusal = 'sexual' | 'minor';

export type TextVerdict = { ok: true } | { ok: false; reason: Refusal; message: string; matched: string[] };

export const REFUSAL_MESSAGE: Record<Refusal, string> = {
  sexual: 'Hildegard doesn’t make sexual content, so this can’t render. Describe the shot another way.',
  minor:
    'Hildegard never makes sexual or suggestive images involving children. This can’t render, on any device.',
};

// Letters that look like Latin ones, from Cyrillic and Greek, and digits and symbols used for letters.
const LOOKALIKE: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
};
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '@': 'a',
  $: 's',
  '!': 'i',
  '|': 'i',
  '+': 't',
};

const latinOnly = (s: string) => /^[\p{Script=Latin}\p{N}]+$/u.test(s);
const SYMBOLS = /[@$!|+]/g;

/** Fold case, accents and invisible characters; keep scripts as they are. */
function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\u200B-\u200F\u2060-\u2064\uFEFF\u00AD]/g, '')
    .toLowerCase();
}

/**
 * Every way to read a word: as written (symbols dropped), with look-alike Cyrillic and Greek letters read as Latin
 * ("nаked" with a Cyrillic а), and with l33t read as letters ("p0rn", "$ex"). An all-Cyrillic word stays as it is.
 */
function readings(word: string): string[] {
  const out = new Set<string>();
  const plain = word.replace(SYMBOLS, '');
  if (plain) out.add(plain);
  const latin = [...word].map((ch) => LOOKALIKE[ch] ?? ch).join('');
  if (/[a-z]/.test(latin)) {
    const leet = [...latin].map((ch) => LEET[ch] ?? ch).join('');
    for (const r of [latin.replace(SYMBOLS, ''), leet]) if (r && latinOnly(r)) out.add(r);
  }
  return [...out];
}

const squeeze = (s: string) => s.replace(/(.)\1+/gu, '$1');

interface Token {
  /** Every way to read it. */
  forms: string[];
  /** The same, with repeated letters squeezed to one ("nuuude" → "nude"). */
  squeezed: string[];
}

const token = (w: string): Token => {
  const forms = readings(w);
  return { forms, squeezed: forms.map(squeeze) };
};

/** One position per word. A position may hold a second reading: a run of single letters ("n u d e") joined up. */
function tokenize(text: string): Token[][] {
  const raw = fold(text)
    .split(/[^\p{L}\p{N}@$!|+]+/u)
    .filter((w) => w && w.replace(SYMBOLS, '').length > 0);
  const tokens: Token[][] = raw.map((w) => [token(w)]);
  for (let i = 0; i < raw.length; ) {
    let j = i;
    while (j < raw.length && [...raw[j]!].length === 1) j++;
    // Every stretch of 3 or more letters in the run, so a stray "a" before "n u d e" doesn't hide it.
    for (let k = i; k < j; k++)
      for (let e = k + 3; e <= Math.min(j, k + 24); e++) tokens[k]!.push(token(raw.slice(k, e).join('')));
    i = Math.max(j, i + 1);
  }
  return tokens;
}

interface Word {
  stem: string;
  prefix: boolean;
  /** A stem with no doubled letters also matches words squeezed of theirs; "boob" and "xxx" don't squeeze. */
  squeezable: boolean;
}

interface Pattern {
  words: Word[];
  source: string;
}

function compile(list: readonly string[]): Pattern[] {
  return list.map((source) => ({
    source,
    words: fold(source)
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((w) => {
        const prefix = w.endsWith('*');
        const stem = prefix ? w.slice(0, -1) : w;
        return { stem, prefix, squeezable: squeeze(stem) === stem };
      }),
  }));
}

const formMatches = (form: string, w: Word) =>
  w.prefix ? form.startsWith(w.stem) : form === w.stem || form === `${w.stem}s` || form === `${w.stem}es`;
const wordMatches = (t: Token, w: Word) =>
  t.forms.some((f) => formMatches(f, w)) || (w.squeezable && t.squeezed.some((f) => formMatches(f, w)));

/** Where each pattern matches: the index of the first word and how many words it spans. */
function findAll(
  tokens: Token[][],
  patterns: Pattern[],
): Array<{ source: string; start: number; end: number }> {
  const hits: Array<{ source: string; start: number; end: number }> = [];
  for (const p of patterns) {
    for (let i = 0; i < tokens.length; i++) {
      if (p.words.length === 1) {
        if (tokens[i]!.some((t) => wordMatches(t, p.words[0]!)))
          hits.push({ source: p.source, start: i, end: i + 1 });
        continue;
      }
      if (i + p.words.length > tokens.length) break;
      const ok = p.words.every((w, k) => wordMatches(tokens[i + k]![0]!, w));
      if (ok) hits.push({ source: p.source, start: i, end: i + p.words.length });
    }
  }
  return hits;
}

const AGE =
  /\b(?:aged?|age\s+of)\s*(\d{1,2})\b|\b(\d{1,2})\s*-?\s*(?:years?|yrs?)\s*-?\s*old\b|\b(\d{1,2})\s*(?:yo|y\s*\/\s*o)\b/gu;
// Written-out ages under 18.
const AGE_WORDS =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[\s-]+years?[\s-]+old\b/u;

function underage(folded: string): boolean {
  for (const m of folded.matchAll(AGE)) {
    const n = Number(m[1] ?? m[2] ?? m[3]);
    if (n < 18) return true;
  }
  return AGE_WORDS.test(folded);
}

/** A policy compiled once, so each check is a pass over the words. */
export class SafetyCheck {
  readonly policy: SafetyPolicy;
  private readonly sexual: Pattern[];
  private readonly childSexual: Pattern[];
  private readonly suggestive: Pattern[];
  private readonly minors: Pattern[];
  private readonly allowed: Pattern[];
  private readonly negations: Set<string>;
  private readonly blockedTags: Set<string>;
  private readonly blockedSha: Set<string>;

  constructor(policy: SafetyPolicy) {
    this.policy = policy;
    const p = policy.prompt;
    this.sexual = compile([...p.sexual, ...p.sexualPhrases]);
    this.childSexual = compile(p.childSexual);
    this.suggestive = compile(p.suggestive);
    this.minors = compile([...p.minors, ...p.minorPhrases]);
    this.allowed = compile(p.allowed);
    this.negations = new Set(p.negations.map((w) => squeeze(fold(w))));
    this.blockedTags = new Set(policy.models.blockedTags.map((t) => t.toLowerCase()));
    this.blockedSha = new Set(policy.models.blockedSha256);
  }

  /** Check text someone wrote: a prompt, a title, a model's name or card. */
  text(text: string): TextVerdict {
    const tokens = tokenize(text);
    const allowed = findAll(tokens, this.allowed);
    const covered = (h: { start: number; end: number }) =>
      allowed.some((a) => a.start <= h.start && a.end >= h.end);
    const negated = (h: { start: number; end: number }) => {
      const before = (k: number) => (h.start - k >= 0 ? tokens[h.start - k]![0]!.squeezed : []);
      const isNeg = (forms: string[]) => forms.some((f) => this.negations.has(f));
      return isNeg(before(1)) || (before(1).includes('any') && isNeg(before(2)));
    };
    // A phrase ("no clothes") is never undone by its own first word.
    const sexual = findAll(tokens, this.sexual).filter(
      (h) => !covered(h) && (h.end - h.start > 1 || !negated(h)),
    );
    const suggestive = findAll(tokens, this.suggestive).filter((h) => !covered(h) && !negated(h));
    const childSexual = findAll(tokens, this.childSexual).filter((h) => !covered(h));
    const minors = findAll(tokens, this.minors);
    const child = minors.length > 0 || underage(fold(text));
    const matched = [...childSexual, ...sexual, ...suggestive, ...minors].map((h) => h.source);
    if (childSexual.length || (child && (sexual.length || suggestive.length)))
      return { ok: false, reason: 'minor', message: REFUSAL_MESSAGE.minor, matched };
    if (sexual.length) return { ok: false, reason: 'sexual', message: REFUSAL_MESSAGE.sexual, matched };
    return { ok: true };
  }

  /** A file known to make sexual content, by its SHA-256. */
  blockedHash(sha256: string | null | undefined): boolean {
    return !!sha256 && this.blockedSha.has(sha256.toLowerCase());
  }

  /** A repo refused by name, or by its author. */
  blockedRepo(repo: string): boolean {
    const r = repo.toLowerCase();
    const author = r.split('/')[0];
    return this.policy.models.blockedRepos.some((b) => {
      const x = b.toLowerCase();
      return x === r || (x.endsWith('/*') && x.slice(0, -2) === author);
    });
  }

  trusted(repo: string): boolean {
    return this.policy.models.trustedRepos.some((t) => t.toLowerCase() === repo.toLowerCase());
  }

  /**
   * Whether a model or LoRA may be installed, from what Hugging Face or Civitai says about it. Every reason it's
   * refused, or an empty list. Ask this before anything downloads, for every model a person or an agent adds.
   */
  model(m: ModelFacts): string[] {
    const why: string[] = [];
    const trusted = m.repo ? this.trusted(m.repo) : false;
    if (m.repo && this.blockedRepo(m.repo)) why.push(`${m.repo} is on Hildegard’s blocklist`);
    for (const f of m.files ?? [])
      if (this.blockedHash(f.sha256)) why.push(`${f.name ?? 'a file'} is a known sexual model file`);
    if (trusted) return why;
    const tags = (m.tags ?? []).map((t) => t.toLowerCase().trim());
    const bad = tags.filter((t) => this.blockedTags.has(t) || this.blockedTags.has(t.replace(/^tag:/, '')));
    if (bad.length) why.push(`it’s tagged ${bad.map((t) => `“${t}”`).join(', ')}`);
    if (m.nsfw === true) why.push('it’s marked NSFW');
    if (typeof m.nsfwLevel === 'number' && (m.nsfwLevel & this.policy.models.civitaiBlockedNsfwBits) !== 0)
      why.push('it’s rated for mature content');
    if (m.minor === true) why.push('it’s made to depict children');
    if (m.poi === true) why.push('it’s made to depict a real person');
    const words = [
      m.repo?.replace(/[/_]/g, ' '),
      m.name,
      ...(m.files ?? []).map((f) => f.name),
      m.description,
      ...tags,
    ]
      .filter(Boolean)
      .join('\n');
    const v = this.text(words);
    if (!v.ok)
      why.push(
        v.reason === 'minor' ? 'its description involves children' : 'its name or description is sexual',
      );
    return why;
  }
}

/** What a model page says about a model: Hugging Face's tags and card, or Civitai's flags. */
export interface ModelFacts {
  /** "author/name" on Hugging Face, or "civitai:<id>". */
  repo?: string;
  name?: string;
  description?: string;
  tags?: string[];
  /** Civitai's `nsfw` flag. */
  nsfw?: boolean;
  /** Civitai's `nsfwLevel` bit field, of the model or the version being installed. */
  nsfwLevel?: number;
  /** Civitai: made to depict children. */
  minor?: boolean;
  /** Civitai: made to depict a real person. */
  poi?: boolean;
  files?: Array<{ name?: string; sha256?: string | null }>;
}

export function parseSafety(toml: string): SafetyPolicy {
  return SafetyPolicy.parse(parse(toml));
}

let cached: { dir: string; check: SafetyCheck } | null = null;

/** The policy shipped in `presets/safety.toml`, compiled. */
export function loadSafety(dir = defaultPresetsDir()): SafetyCheck {
  if (cached?.dir === dir) return cached.check;
  const check = new SafetyCheck(parseSafety(readFileSync(join(dir, 'safety.toml'), 'utf8')));
  cached = { dir, check };
  return check;
}
