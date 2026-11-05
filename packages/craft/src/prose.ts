// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The prose lint: the tells that make writing read as machine-made, found where they are, each with why and what to
 * do instead. It checks words a person reads (a blog post, an email, a page), not prompts: `lintPrompt` does those.
 * The rules live in prose-rules.json, shared with skills/hildegard/scripts/prose_lint.py so an agent with no
 * Hildegard installed lints the same way.
 */
import RULES from './prose-rules.json' with { type: 'json' };

export type ProseSeverity = 'fail' | 'warn';

export interface ProseMatch {
  text: string;
  /** Offset into the text as given. */
  index: number;
  /** 1-based. */
  line: number;
  column: number;
}

export interface ProseFinding {
  id: string;
  severity: ProseSeverity;
  why: string;
  fix: string;
  matches: ProseMatch[];
}

export interface ProseLint {
  /** No finding fails. Warnings are for the writer to weigh. */
  ok: boolean;
  words: number;
  findings: ProseFinding[];
}

interface PhraseRule {
  severity: ProseSeverity;
  why: string;
  fix: string;
  patterns: string[];
  density?: number;
}

const PHRASES = RULES.phrases as Record<string, PhraseRule>;

/**
 * Code, URLs, link targets and HTML that isn't prose, blanked to spaces of the same length so every offset still
 * points at the text as given.
 */
export function blankNonProse(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/^---\n[\s\S]*?\n---\n/, blank)
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/~~~[\s\S]*?~~~/g, blank)
    // Inline code reads as one word in its sentence: “call `lint_writing` on it” is not a fragment.
    .replace(/`[^`]{0,400}?`/g, (m) => `x${blank(m.slice(1))}`)
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/<(script|style|code|pre)\b[\s\S]*?<\/\1>/gi, blank)
    .replace(/<[^>\n]+>/g, blank)
    .replace(/\]\([^)\n]*\)/g, (m) => `](${blank(m.slice(2))}`)
    .replace(/https?:\/\/[^\s)>\]]+/g, blank);
}

/** Where each line starts, for the text being linted: one pass, then every match is a binary search. */
let lines: { text: string; breaks: number[] } = { text: '', breaks: [] };
function locate(text: string, index: number, match: string): ProseMatch {
  if (lines.text !== text) {
    const breaks: number[] = [];
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) breaks.push(i);
    lines = { text, breaks };
  }
  const { breaks } = lines;
  let lo = 0;
  let hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (breaks[mid]! < index) lo = mid + 1;
    else hi = mid;
  }
  return { text: match, index, line: lo + 1, column: index - (lo ? breaks[lo - 1]! : -1) };
}

function all(re: RegExp, prose: string, text: string): ProseMatch[] {
  const out: ProseMatch[] = [];
  for (const m of prose.matchAll(re))
    out.push(locate(text, m.index, text.slice(m.index, m.index + m[0].length)));
  return out;
}

/** Quoted words are mentioned, not used: “tapestry” in a list of banned words is no tell. */
const unquote = (prose: string) =>
  prose.replace(/"[^"\n]{1,80}"|“[^”\n]{1,80}”/g, (m) => m.replace(/[^\n]/g, ' '));

const bounded = (p: string) => new RegExp(`(?<![\\w-])(?:${p})(?![\\w-])`, 'gi');

const countWords = (s: string) => s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;

/** Paragraphs with their offsets: blocks between blank lines. */
function paragraphs(prose: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g;
  for (const m of prose.matchAll(re)) if (m[0].trim()) out.push({ text: m[0], index: m.index });
  return out;
}

const isHeading = (p: string) => /^\s{0,3}#{1,6}\s/.test(p);
const isList = (p: string) => /^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(p);

/** Sentences of running prose (not headings or list items), with offsets. */
function sentences(prose: string): Array<{ text: string; index: number; words: number }> {
  const out: Array<{ text: string; index: number; words: number }> = [];
  for (const p of paragraphs(prose)) {
    if (isHeading(p.text) || isList(p.text)) continue;
    for (const m of p.text.matchAll(/\S[\s\S]*?(?:[.!?]+["”’)]*(?=\s|$)|$)/g)) {
      const t = m[0].trim();
      if (!t) continue;
      const lead = m[0].length - m[0].trimStart().length;
      out.push({ text: t, index: p.index + m.index + lead, words: countWords(t) });
    }
  }
  return out;
}

const EMOJI_LINE =
  /^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+\.\s+)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}])/gmu;
const NOT_BUT = [
  /\b(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t)\b[^.\n]{1,60}?,\s*but\b/gi,
  /\b(?:it|this|that)['’]?s not\b[^.\n]{1,60}[.;]\s+(?:it|this|that)['’]?s\b/gi,
  /\b(?:it|this|that) (?:is|was) not\b[^.\n]{1,60}[.;]\s+(?:it|this|that) (?:is|was)\b/gi,
  /\bnot (?:just|only|merely) [^.\n]{1,60}?,?\s+but(?: also)?\b/gi,
  /\byou (?:don['’]?t|do not) need [^.\n]{1,60}\.\s+you need\b/gi,
  /\bthe (?:question|problem|issue|point) (?:isn['’]?t|is not) [^.\n]{1,60}[.,;]\s+(?:it['’]?s|it is)\b/gi,
];
const NEGATIVE_LIST = /(?:^|[.!?]\s+)(Not an? [^.!?\n]{1,40}\.\s+Not an? [^.!?\n]{1,40}\.)/gim;
const ING_TAIL =
  /,\s+(?:highlighting|underscoring|reflecting|showcasing|emphasizing|emphasising|demonstrating|signaling|signalling|illustrating|cementing|solidifying|reinforcing|symbolizing)\b/gi;
const COLON_REVEAL =
  /(?:^|[.!?]\s+)((?:The|My|Our|Their|One|Here['’]s|What) (?:[\w'’-]+ ){0,5}(?:detail|part|secret|trick|catch|twist|kicker|answer|truth|reason|result|difference|fix|best part|worst part|key|something|one thing)\b[^.:!?\n]{0,40}: [a-z])/gm;
/** An em dash anywhere; an en dash or a double hyphen only between words, never in a range like 9 – 5. */
const DASHES = /—|(?<=\p{L}[,]?) (?:–|--) (?=\p{L})/gu;
const BOLD = /\*\*[^*\n]+\*\*|__[^_\n]+__/g;
/** “sleep, reading, play, or dinner”: a list of three or more, the rhythm generated prose falls into. */
const TRIAD =
  /\b[\p{L}'’-]+(?: [\p{L}'’-]+){0,3}, [\p{L}'’-]+(?: [\p{L}'’-]+){0,3},? (?:and|or) [\p{L}'’-]+/gu;
const BOLD_LEAD = /^\s*(?:\*\*|__)[^*_\n]{2,80}(?:\*\*|__)/;
/** Numbers, and capitalised words that don't start a sentence: the names, dates and amounts a real piece is made of. */
const SPECIFIC = /\b\d[\d,.:]*\b|(?<=[\p{Ll},;] )\p{Lu}\p{Ll}+/gu;
const ENDING = /^\s*(?:ultimately|overall|in the end|in conclusion|in summary|to sum up|all in all)\b[,:]?/i;

/** Lint words a person will read. `ok` is false when any finding fails. */
export function lintProse(text: string): ProseLint {
  const prose = blankNonProse(text);
  const words = countWords(prose);
  const findings: ProseFinding[] = [];
  const add = (id: string, severity: ProseSeverity, why: string, fix: string, matches: ProseMatch[]) => {
    if (matches.length) findings.push({ id, severity, why, fix, matches });
  };

  const unquoted = unquote(prose);
  for (const [id, rule] of Object.entries(PHRASES)) {
    const matches = rule.patterns
      .flatMap((p) => all(bounded(p), unquoted, text))
      .sort((a, b) => a.index - b.index);
    if (rule.density !== undefined && matches.length / Math.max(1, words) <= rule.density) continue;
    add(id, rule.severity, rule.why, rule.fix, matches);
  }

  // Dashes: none in short copy, a couple in a long piece, never two in one paragraph.
  const dashes = all(DASHES, prose, text);
  if (dashes.length) {
    const d = RULES.dashes;
    const crowded = paragraphs(prose).some((p) => (p.text.match(DASHES) ?? []).length > d.perParagraph);
    const fail = words <= d.shortWords || dashes.length > d.perDocument || crowded;
    add(
      'dashes',
      fail ? 'fail' : 'warn',
      'Dashes as a rhythm crutch are the best-known tell of generated prose.',
      'Use a full stop, a comma, a colon or parentheses. Keep a dash only where nothing else works.',
      dashes,
    );
  }

  const notBut = NOT_BUT.flatMap((re) => all(re, prose, text)).sort((a, b) => a.index - b.index);
  if (notBut.length)
    add(
      'not-but',
      notBut.length > RULES.notBut.perDocument ? 'fail' : 'warn',
      '“It’s not X, it’s Y” contrasts set up a point the writer could just make.',
      'State Y directly.',
      notBut,
    );

  add(
    'negative-list',
    'fail',
    '“Not a X. Not a Y.” builds suspense the reader didn’t ask for.',
    'Say what it is.',
    [...prose.matchAll(NEGATIVE_LIST)].map((m) => {
      const at = m.index + m[0].indexOf(m[1]!);
      return locate(text, at, text.slice(at, at + m[1]!.length));
    }),
  );

  add(
    'ing-tail',
    'fail',
    'A trailing “-ing” clause that claims meaning instead of explaining it.',
    'Say what actually follows, or end the sentence.',
    all(ING_TAIL, prose, text),
  );

  add(
    'colon-reveal',
    'warn',
    'A noun phrase, a colon, then a reveal: fake drama.',
    'Write it as a plain sentence. Keep colons for lists, labels and quotes.',
    [...prose.matchAll(COLON_REVEAL)]
      .filter((m) => !isList(prose.slice(prose.lastIndexOf('\n', m.index) + 1)))
      .map((m) => {
        const at = m.index + m[0].indexOf(m[1]!);
        return locate(text, at, text.slice(at, at + m[1]!.length));
      }),
  );

  const said = sentences(prose);
  const { run, maxWords } = RULES.fragments;
  const frags: ProseMatch[] = [];
  let start = -1;
  for (let i = 0; i <= said.length; i++) {
    if (i < said.length && said[i]!.words > 0 && said[i]!.words <= maxWords) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0 && i - start >= run)
      frags.push(
        locate(
          text,
          said[start]!.index,
          said
            .slice(start, i)
            .map((s) => s.text)
            .join(' '),
        ),
      );
    start = -1;
  }
  add(
    'fragments',
    'warn',
    'Stacked short fragments, “That’s it. That’s the whole thing.”, read as a performance.',
    'Join them into full sentences.',
    frags,
  );

  const lengths = said.map((s) => s.words).filter((n) => n > 0);
  if (lengths.length >= RULES.rhythm.minSentences) {
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
    if (sd / mean < RULES.rhythm.minSpread)
      add(
        'rhythm',
        'warn',
        `Every sentence runs about ${Math.round(mean)} words. Even length is a machine rhythm.`,
        'Vary it where the point allows: a short sentence for weight, a longer one to carry a thought through.',
        [locate(text, said[0]!.index, said[0]!.text)],
      );
  }

  const paras = paragraphs(prose).filter((p) => !isHeading(p.text));
  const last = paras.at(-1);
  if (last && paras.length > 2 && ENDING.test(last.text))
    add(
      'summary-ending',
      'fail',
      'The last paragraph sums up what the reader just read.',
      'End on the last concrete point, or on what to do next.',
      [locate(text, last.index, last.text.trim().split('\n')[0]!)],
    );

  const triads = all(TRIAD, prose, text);
  if (words >= RULES.triads.minWords && (triads.length * 100) / words > RULES.triads.perHundred)
    add(
      'triads',
      'warn',
      `${triads.length} lists of three or more in ${words} words. Generated prose falls into that rhythm.`,
      'Keep the lists that are real lists. Elsewhere, name the one thing that matters.',
      triads,
    );

  const leads = paras.filter((p) => BOLD_LEAD.test(p.text));
  if (leads.length >= RULES.boldLeads.min && leads.length / paras.length >= RULES.boldLeads.share)
    add(
      'bold-leads',
      'warn',
      'Paragraph after paragraph opens on a bold label, like slides.',
      'Write paragraphs that lead with their point, or use real headings if it is a reference page.',
      leads.map((p) => locate(text, p.index, p.text.match(BOLD_LEAD)![0].trim())),
    );

  const specifics = (unquoted.match(SPECIFIC) ?? []).length;
  if (words >= RULES.specifics.minWords && (specifics * 100) / words < RULES.specifics.perHundred && said[0])
    add(
      'specifics',
      'warn',
      `Only ${specifics} names, numbers or dates in ${words} words. A piece with none could be about anyone.`,
      'Add the specific: who, where, how many, which year, what it cost.',
      [locate(text, said[0].index, said[0].text)],
    );

  add(
    'emoji-heading',
    'fail',
    'Emoji as section markers.',
    'Delete them. Headings carry the structure.',
    all(EMOJI_LINE, prose, text),
  );

  const bold: ProseMatch[] = [];
  for (const p of paras) {
    if (isList(p.text) || /^\s*\|/.test(p.text)) continue;
    const hits = [...p.text.matchAll(BOLD)];
    if (hits.length > RULES.bold.perParagraph)
      for (const h of hits) bold.push(locate(text, p.index + h.index, h[0]));
  }
  add(
    'bold',
    'warn',
    'Bold sprinkled through a paragraph shouts.',
    'Let the sentence carry the weight.',
    bold,
  );

  add(
    'unfinished',
    'fail',
    'Placeholder text left in.',
    'Write the real words, or cut the line.',
    RULES.markers
      .flatMap((m) =>
        all(
          new RegExp(/^[A-Z]+$/.test(m) ? `\\b${m}\\b` : m, /^[A-Z]+$/.test(m) ? 'g' : 'gi'),
          unquoted,
          text,
        ),
      )
      .sort((a, b) => a.index - b.index),
  );

  return { ok: !findings.some((f) => f.severity === 'fail'), words, findings };
}

/** The lint as lines a person or an agent reads: each finding, where it is, and what to do. */
export function describeProseLint(l: ProseLint, max = 6): string {
  if (!l.findings.length) return `Clean: no tells in ${l.words} words.`;
  const fails = l.findings.filter((f) => f.severity === 'fail').length;
  const head = l.ok
    ? `Passes, with ${l.findings.length} to weigh (${l.words} words).`
    : `Fails: ${fails} ${fails === 1 ? 'tell' : 'tells'} to fix (${l.words} words).`;
  return [
    head,
    ...l.findings.map((f) => {
      const where = f.matches
        .slice(0, max)
        .map((m) => `${m.line}:${m.column} “${m.text.length > 60 ? `${m.text.slice(0, 57)}…` : m.text}”`)
        .join('; ');
      const more = f.matches.length > max ? ` and ${f.matches.length - max} more` : '';
      return `- ${f.severity} ${f.id}: ${f.why} ${f.fix} At ${where}${more}.`;
    }),
  ].join('\n');
}
