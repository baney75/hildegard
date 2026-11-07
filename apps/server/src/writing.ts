// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A writer's own voice, kept per person under `<data>/writing/<personId>/`: `voice.md` (the rules learned from their
 * words and habits, with every earlier version kept in `history/`), `samples/<id>.json` (their own writing, pasted or
 * uploaded) and `edits.jsonl` (what they changed in drafts an agent wrote for them). Directories are 0700, files 0600,
 * and every write goes through a temporary file and a rename. A person is only ever a folder name here: who may name
 * which person is decided by the routes (writing-routes.ts).
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { lintProse } from '@hildegard/craft';

export const WRITING_LIMITS = {
  sampleChars: 50_000,
  samples: 200,
  voiceChars: 50_000,
  editLines: 2000,
  history: 20,
  phrases: 40,
  textChars: 200_000,
} as const;

export interface Sample {
  id: string;
  title: string;
  text: string;
  source: string;
  addedAt: string;
  words: number;
}
export type SampleSummary = Omit<Sample, 'text'>;

export interface LintCount {
  fails: number;
  warns: number;
}
export interface EditRecord {
  at: string;
  draftWords: number;
  finalWords: number;
  /** Phrases the writer cut from the draft. */
  removed: string[];
  /** Phrases the writer put in. */
  added: string[];
  lintBefore: LintCount;
  lintAfter: LintCount;
  note: string;
}

export class WritingError extends Error {
  readonly status: 400 | 404 | 409 | 413 | 422;
  readonly code: string;
  constructor(status: WritingError['status'], code: string, message: string) {
    super(message);
    this.name = 'WritingError';
    this.status = status;
    this.code = code;
  }
}

const PERSON = /^[\w-]{1,64}$/;
const SAMPLE = /^[a-f0-9]{16}$/;

export const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ── What changed between a draft and the final ───────────────────────────────────────────────────────────────────

const sentences = (s: string) =>
  s
    .split(/(?<=[.!?…])["”’')\]]*\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
/** A sentence or word as the comparison sees it: no case, no punctuation at its edges. */
const key = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const trimEdges = (s: string) => s.replace(/^[\s"“”‘’'([—–-]+|[\s"“”‘’'.,;:!?…)\]—–-]+$/g, '');
const MAX_PHRASE_WORDS = 12;
/** Longest the comparison goes inside one changed stretch before it keeps whole sentences (a table of n × m cells). */
const DIFF_WORDS = 2500;
const words = (s: string[]) => s.join(' ').split(/\s+/).filter(Boolean);

interface Hunk<T> {
  cut: T[];
  put: T[];
}

/** What changed between two lists, in order: each stretch that is only in `a` (cut) and/or only in `b` (put). */
function hunks<T>(a: T[], b: T[], same: (x: T, y: T) => boolean): Hunk<T>[] {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  const eq = (i: number, j: number) => same(a[i]!, b[j]!);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = eq(i, j)
        ? t[(i + 1) * w + j + 1]! + 1
        : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const out: Hunk<T>[] = [];
  let cut: T[] = [];
  let put: T[] = [];
  const flush = () => {
    if (cut.length || put.length) out.push({ cut, put });
    cut = [];
    put = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && eq(i, j)) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || t[i * w + j + 1]! >= t[(i + 1) * w + j]!)) put.push(b[j++]!);
    else cut.push(a[i++]!);
  }
  flush();
  return out;
}

const phrase = (ws: string[]) => {
  const p = trimEdges(ws.slice(0, MAX_PHRASE_WORDS).join(' '));
  return /[\p{L}\p{N}]/u.test(p) ? p : '';
};
/** Distinct phrases, in order, up to the limit. One short word is noise ("the", "a"), not a habit. */
const distinct = (runs: string[][]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const run of runs) {
    const p = phrase(run);
    if (!p || (!p.includes(' ') && p.length <= 3) || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
    if (out.length >= WRITING_LIMITS.phrases) break;
  }
  return out;
};

/**
 * The phrases cut from `draft` and the phrases added in `final`. Sentences are compared first, in order. A sentence
 * that is only in one side is a phrase of its own; where sentences were rewritten, the words inside the rewrite are
 * compared too, so “delve into” becoming “look at” shows as that.
 */
export function diffPhrases(draft: string, final: string): { removed: string[]; added: string[] } {
  const cut: string[][] = [];
  const put: string[][] = [];
  for (const h of hunks(sentences(draft), sentences(final), (x, y) => key(x) === key(y))) {
    const a = words(h.cut);
    const b = words(h.put);
    if (a.length && b.length && a.length <= DIFF_WORDS && b.length <= DIFF_WORDS) {
      for (const g of hunks(a, b, (x, y) => key(x) === key(y))) {
        if (g.cut.length) cut.push(g.cut);
        if (g.put.length) put.push(g.put);
      }
    } else {
      for (const s of h.cut) cut.push(s.split(/\s+/));
      for (const s of h.put) put.push(s.split(/\s+/));
    }
  }
  return { removed: distinct(cut), added: distinct(put) };
}

const lintCount = (text: string): LintCount => {
  const l = lintProse(text);
  return {
    fails: l.findings.filter((f) => f.severity === 'fail').length,
    warns: l.findings.filter((f) => f.severity === 'warn').length,
  };
};

// ── The store ────────────────────────────────────────────────────────────────────────────────────────────────────

export class WritingStore {
  readonly dir: string;
  private readonly now: () => Date;
  private readonly editLines: number;
  constructor(dir: string, now = () => new Date(), limits: { editLines?: number } = {}) {
    this.dir = dir;
    this.now = now;
    this.editLines = limits.editLines ?? WRITING_LIMITS.editLines;
  }

  private root(person: string) {
    if (!PERSON.test(person)) throw new WritingError(404, 'no_person', 'There’s no such person.');
    return join(this.dir, person);
  }
  private folder(path: string) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  }
  private put(path: string, data: string) {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, data, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }
  /** The first owner's folder, when what a computer wrote before there was an account (`local`) belongs to them now. */
  adopt(from: string, to: string) {
    if (from === to || !PERSON.test(from) || !PERSON.test(to)) return;
    const a = join(this.dir, from);
    const b = join(this.dir, to);
    if (existsSync(a) && !existsSync(b)) renameSync(a, b);
  }

  // Voice
  voice(person: string): { md: string; updatedAt: string | null; versions: number } {
    const root = this.root(person);
    const file = join(root, 'voice.md');
    const hist = join(root, 'history');
    return {
      md: existsSync(file) ? readFileSync(file, 'utf8') : '',
      updatedAt: existsSync(file) ? statSync(file).mtime.toISOString() : null,
      versions: existsSync(hist) ? readdirSync(hist).filter((f) => f.startsWith('voice-')).length : 0,
    };
  }

  /** Replaces voice.md. The version it replaces is kept in history/, the last 20. */
  setVoice(person: string, md: string) {
    if (md.length > WRITING_LIMITS.voiceChars)
      throw new WritingError(
        413,
        'size',
        `Your voice notes can be up to ${WRITING_LIMITS.voiceChars.toLocaleString('en-US')} characters.`,
      );
    const root = this.folder(this.root(person));
    const file = join(root, 'voice.md');
    const at = this.now().toISOString();
    if (existsSync(file)) {
      const hist = this.folder(join(root, 'history'));
      const base = `voice-${at.replace(/[:.]/g, '-')}`;
      let name = `${base}.md`;
      for (let n = 1; existsSync(join(hist, name)); n++) name = `${base}-${n}.md`;
      this.put(join(hist, name), readFileSync(file, 'utf8'));
      const old = readdirSync(hist)
        .filter((f) => f.startsWith('voice-'))
        .sort();
      for (const f of old.slice(0, Math.max(0, old.length - WRITING_LIMITS.history)))
        rmSync(join(hist, f), { force: true });
    }
    this.put(file, md);
    return this.voice(person);
  }

  // Samples
  samples(person: string): SampleSummary[] {
    const dir = join(this.root(person), 'samples');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json') && SAMPLE.test(f.slice(0, -5)))
      .map((f) => {
        const { text: _text, ...rest } = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Sample;
        return rest;
      })
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
  }

  addSample(person: string, input: { title: string; text: string; source?: string }): SampleSummary {
    const text = input.text.replace(/\r\n?/g, '\n').trim();
    if (!text) throw new WritingError(422, 'empty', 'Paste some of your writing first.');
    if (text.length > WRITING_LIMITS.sampleChars)
      throw new WritingError(
        413,
        'size',
        `A sample can be up to ${WRITING_LIMITS.sampleChars.toLocaleString('en-US')} characters. Split it into pieces.`,
      );
    if (this.samples(person).length >= WRITING_LIMITS.samples)
      throw new WritingError(
        409,
        'limit',
        `You can keep ${WRITING_LIMITS.samples} samples. Remove one to add another.`,
      );
    const root = this.folder(this.root(person));
    const dir = this.folder(join(root, 'samples'));
    const sample: Sample = {
      id: randomBytes(8).toString('hex'),
      title: input.title.trim().slice(0, 200) || 'Untitled',
      text,
      source: (input.source ?? 'pasted').trim().slice(0, 200) || 'pasted',
      addedAt: this.now().toISOString(),
      words: countWords(text),
    };
    this.put(join(dir, `${sample.id}.json`), `${JSON.stringify(sample, null, 2)}\n`);
    const { text: _text, ...rest } = sample;
    return rest;
  }

  removeSample(person: string, id: string) {
    const file = join(this.root(person), 'samples', `${id}.json`);
    if (!SAMPLE.test(id) || !existsSync(file))
      throw new WritingError(404, 'no_sample', 'There’s no such sample.');
    rmSync(file);
  }

  // Edits
  private editsFile(person: string) {
    return join(this.root(person), 'edits.jsonl');
  }
  edits(person: string): EditRecord[] {
    const file = this.editsFile(person);
    if (!existsSync(file)) return [];
    const out: EditRecord[] = [];
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as EditRecord);
      } catch {}
    }
    return out;
  }

  /** What the writer changed in a draft: the phrases cut and added, and the prose lint of each side, counted. */
  recordEdit(person: string, input: { draft: string; final: string; note?: string }): EditRecord {
    const { removed, added } = diffPhrases(input.draft, input.final);
    const rec: EditRecord = {
      at: this.now().toISOString(),
      draftWords: countWords(input.draft),
      finalWords: countWords(input.final),
      removed,
      added,
      lintBefore: lintCount(input.draft),
      lintAfter: lintCount(input.final),
      note: (input.note ?? '').trim().slice(0, 500),
    };
    this.folder(this.root(person));
    const all = [...this.edits(person), rec].slice(-this.editLines);
    this.put(this.editsFile(person), `${all.map((e) => JSON.stringify(e)).join('\n')}\n`);
    return rec;
  }

  /** The phrases cut most often across all the edits kept, most often first. */
  topCut(person: string, n = 30): { phrase: string; count: number }[] {
    const seen = new Map<string, { phrase: string; count: number; last: number }>();
    this.edits(person).forEach((e, i) => {
      for (const p of e.removed) {
        const k = p.toLowerCase();
        const cur = seen.get(k);
        if (cur) {
          cur.count++;
          cur.last = i;
        } else seen.set(k, { phrase: p, count: 1, last: i });
      }
    });
    return [...seen.values()]
      .sort((a, b) => b.count - a.count || b.last - a.last)
      .slice(0, n)
      .map(({ phrase, count }) => ({ phrase, count }));
  }
}
