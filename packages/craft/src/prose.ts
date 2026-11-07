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
  /** Fewer matches than this and the rule stays quiet: one is a habit, several are a style. */
  minHits?: number;
  /** A capital in mid-sentence is a name, not the word (off a heading line): only for words with ordinary senses. */
  exemptNames?: boolean;
}

const PHRASES = RULES.phrases as Record<string, PhraseRule>;

const blank = (m: string) => m.replace(/[^\n]/g, ' ');
const whenClosed = (blanked: (m: string) => string) => (m: string, closed?: string) =>
  closed ? blanked(m) : m;

/**
 * <script>, <style>, <code> and <pre> through their closing tag, blanked; one with no closing tag is left alone. The
 * plain pattern `<(script|style|code|pre)\b[\s\S]*?<\/\1>` scans to the end of the text from every unclosed opener,
 * so this looks for each tag's last closing tag once and skips the openers after it.
 */
const BLOCK_CLOSE = /<\/(script|style|code|pre)>/gi;
function blankBlocks(text: string): string {
  const last: Record<string, number> = {};
  for (const m of text.matchAll(BLOCK_CLOSE)) last[m[1]!.toLowerCase()] = m.index;
  const open = /<(script|style|code|pre)\b/gi;
  let out = '';
  let from = 0;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const name = m[1]!.toLowerCase();
    if ((last[name] ?? -1) <= m.index) continue;
    const close = new RegExp(`</${name}>`, 'gi');
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(text)!;
    const end = c.index + c[0].length;
    out += text.slice(from, m.index) + blank(text.slice(m.index, end));
    from = end;
    open.lastIndex = end;
  }
  return out + text.slice(from);
}

/**
 * Code, URLs, link targets and HTML that isn't prose, blanked to spaces of the same length so every offset still
 * points at the text as given.
 *
 * Three of these are an opener, a run to the end of the line, and a closer. When the closer is missing, the plain
 * pattern fails from every opener on the line and rescans the line each time: '<<<<…' or '![![![…' at 200,000
 * characters took ten seconds. So each has a second alternative that consumes the doomed rest of the line (or span),
 * unchanged, and only the first alternative's match is blanked. Which text is blanked is exactly the plain pattern's.
 */
export function blankNonProse(text: string): string {
  return (
    blankBlocks(
      text
        // Front matter: after an optional byte order mark, with either line ending, and at the end of the text.
        .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, blank)
        .replace(/```[\s\S]*?```/g, blank)
        .replace(/~~~[\s\S]*?~~~/g, blank)
        // Inline code reads as one word in its sentence: “call `lint_writing` on it” is not a fragment.
        .replace(/`[^`]{0,400}?`/g, (m) => `x${blank(m.slice(1))}`)
        // ![alt](target). Not closed: no ] on the line, a ] with no ( after it, or a ( with no ) after it.
        .replace(
          /(!\[[^\]\n]*\]\([^)\n]*\))|!\[[^\]\n]*\](?!\()|!\[[^\]\n]*(?=\n|$)|!\[[^\]\n]*\]\([^\n]*/g,
          whenClosed(blank),
        ),
    )
      // <tag>. Not closed: “<>”, or no > on the rest of the line.
      .replace(/(<[^>\n]+>)|<>|<[^\n]*/g, whenClosed(blank))
      // ](target). Not closed: no ) on the rest of the line.
      .replace(
        /(\]\([^)\n]*\))|\]\([^\n]*/g,
        whenClosed((m) => `](${blank(m.slice(2))}`),
      )
      .replace(/https?:\/\/[^\s)>\]]+/g, blank)
  );
}

/** Where each line starts, for the text being linted: one pass, then every match is a binary search. */
let lines: { text: string; breaks: number[] } = { text: '', breaks: [] };
/** The number of line breaks before `index`: the 0-based line it is on. */
function lineOf(text: string, index: number): number {
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
  return lo;
}
function locate(text: string, index: number, match: string): ProseMatch {
  const lo = lineOf(text, index);
  return {
    text: match,
    index,
    line: lo + 1,
    column: index - (lo ? lines.breaks[lo - 1]! : -1),
  };
}

/** True when the line `index` is on is a Markdown heading. The marker is at most ten characters in. */
function onHeading(text: string, prose: string, index: number): boolean {
  const lo = lineOf(text, index);
  const start = lo ? lines.breaks[lo - 1]! + 1 : 0;
  return /^[^\S\n]{0,3}#{1,6}\s/.test(prose.slice(start, start + 10));
}

function all(
  re: RegExp,
  prose: string,
  text: string,
  skip?: (prose: string, index: number, match: string) => boolean,
): ProseMatch[] {
  const out: ProseMatch[] = [];
  for (const m of prose.matchAll(re))
    if (!skip?.(prose, m.index, m[0]))
      out.push(locate(text, m.index, text.slice(m.index, m.index + m[0].length)));
  return out;
}

/**
 * A match that starts with a capital in the middle of a sentence (after a lowercase letter, a comma or a semicolon and
 * a space, as SPECIFIC reads it) is a name, not the word: “Pastor Mike Foster”, “Beacon Street”. Only the
 * `exemptNames` rules use it, and never on a heading, where Title Case capitalises every word.
 */
const isName = (prose: string, index: number, match: string) =>
  /^\p{Lu}/u.test(match) && /[\p{Ll},;] $/u.test(prose.slice(Math.max(0, index - 3), index));

/** Quoted words are mentioned, not used: “tapestry” in a list of banned words is no tell. */
const unquote = (prose: string) =>
  prose.replace(/"[^"\n]{1,80}"|“[^”\n]{1,80}”/g, (m) => m.replace(/[^\n]/g, ' '));

const bounded = (p: string, flags = 'gi') => new RegExp(`(?<![\\w-])(?:${p})(?![\\w-])`, flags);

/**
 * The lowercase text every match of `p` must begin with, or '' when the pattern doesn't open on plain letters: its
 * leading run of letters, digits, spaces and hyphens, less the last character when a quantifier makes that optional.
 * A pattern with a bar outside its groups has no such prefix.
 */
export function needleOf(p: string): string {
  let depth = 0;
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '\\') i++;
    else if (inClass) inClass = c !== ']';
    else if (c === '[') inClass = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '|' && depth === 0) return '';
  }
  const run = p.match(/^[a-z0-9 -]*/i)![0];
  const next = p[run.length];
  return (next === '?' || next === '*' || next === '{' ? run.slice(0, -1) : run).toLowerCase();
}

interface Phrase {
  all: RegExp;
  /** The same pattern, sticky: tried only where `needle` occurs. */
  at: RegExp;
  needle: string;
}
const compile = (p: string): Phrase => ({ all: bounded(p), at: bounded(p, 'iy'), needle: needleOf(p) });
/** Every phrase rule's patterns, compiled once. */
const COMPILED: Record<string, Phrase[]> = Object.fromEntries(
  Object.entries(PHRASES).map(([id, r]) => [id, r.patterns.map(compile)]),
);

/**
 * Where a phrase pattern matches, as RegExp.matchAll finds them. Most patterns open on a fixed word, so the text is
 * searched for that word with indexOf (fast) and the regex is tried only there: leftmost, non-overlapping, the same
 * matches as scanning the whole text with the pattern. `lower` is the lowercased text; with a different length (a few
 * capitals change length when lowercased) every pattern scans the whole text.
 */
function phraseHits(ph: Phrase, prose: string, lower: string | null): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  if (!lower || !ph.needle) {
    for (const m of prose.matchAll(ph.all)) out.push(m);
    return out;
  }
  let end = 0;
  for (let i = lower.indexOf(ph.needle); i >= 0; i = lower.indexOf(ph.needle, i + 1)) {
    if (i < end) continue;
    ph.at.lastIndex = i;
    const m = ph.at.exec(prose);
    if (!m) continue;
    end = i + m[0].length;
    out.push(m);
  }
  return out;
}

const countWords = (s: string) => s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;

/** Paragraphs with their offsets and word counts: blocks between blank lines. */
function paragraphs(prose: string): Array<{ text: string; index: number; words: number }> {
  const out: Array<{ text: string; index: number; words: number }> = [];
  // `[^\S\n]*`, not `\s*`: the lookahead must stop at the line's end, or a run of blank lines is rescanned from every line.
  const re = /[^\n]+(?:\n(?![^\S\n]*\n)[^\n]+)*/g;
  for (const m of prose.matchAll(re))
    if (m[0].trim()) out.push({ text: m[0], index: m.index, words: countWords(m[0]) });
  return out;
}

const isHeading = (p: string) => /^\s{0,3}#{1,6}\s/.test(p);
const isList = (p: string) => /^\s{0,3}(?:[-*+]|\d+[.)])\s/.test(p);

const EMOJI_LINE =
  /^\s{0,3}(?:#{1,6}\s*|[-*+]\s+|\d+\.\s+)?(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{2705}\u{274C}])/gmu;
const NOT_BUT = [
  // Only the contrasts a writer sets up, not an everyday hedge: “not about rules, but”, never “not cheap, but”.
  /\b(?:not|isn['’]?t|aren['’]?t|wasn['’]?t|weren['’]?t) (?:about|just|merely|simply|a|an|the|because|that)\b[^.\n]{1,60}?,\s*but\b/gi,
  /\b(?:it|this|that)['’]?s not\b[^.\n]{1,60}[.;]\s+(?:it|this|that)['’]?s\b/gi,
  /\b(?:it|this|that) (?:is|was) not\b[^.\n]{1,60}[.;]\s+(?:it|this|that) (?:is|was)\b/gi,
  /\bnot (?:just|merely) [^.\n]{1,60}?,?\s+but(?: also)?\b/gi,
  /\byou (?:don['’]?t|do not) need [^.\n]{1,60}\.\s+you need\b/gi,
  /\bmore than (?:just |only |merely )?(?:a|an) [^.\n]{1,50}[.;]\s+(?:it|this|that|they|these)(?: was| is| were| are|['’]s)\b/gi,
  /\bthe (?:question|problem|issue|point) (?:isn['’]?t|is not) [^.\n]{1,60}[.,;]\s+(?:it['’]?s|it is)\b/gi,
];
const NEGATIVE_LIST = /(?:^|[.!?]\s+)(Not an? [^.!?\n]{1,40}\.\s+Not an? [^.!?\n]{1,40}\.)/gim;
const ING_TAIL =
  /,\s+(?:highlighting|underscoring|reflecting|showcasing|emphasizing|emphasising|demonstrating|signaling|signalling|illustrating|cementing|solidifying|reinforcing|symbolizing)\b/gi;
const COLON_REVEAL =
  /(?:^|[.!?]\s+)((?:The|My|Our|Their|One|Here['’]s|What) (?:[\w'’-]+ ){0,5}(?:detail|part|secret|trick|catch|twist|kicker|answer|truth|reason|result|difference|fix|best part|worst part|key|something|one thing)\b[^.:!?\n]{0,40}: [a-z])/gm;
const BOLD = /\*\*[^*\n]+\*\*|__[^_\n]+__/g;
/**
 * “sleep, reading, play, or dinner”: a list of three or more, the rhythm generated prose falls into. It starts where
 * a word starts, by its own letters: `\b` is ASCII-only, so in “aéaéaé…” it fell between every pair and rescanned the word.
 */
const TRIAD =
  /(?<![\p{L}\p{N}_'’-])[\p{L}'’-]+(?: [\p{L}'’-]+){0,3}, [\p{L}'’-]+(?: [\p{L}'’-]+){0,3},? (?:and|or) [\p{L}'’-]+/gu;
const BOLD_LEAD = /^\s*(?:\*\*|__)[^*_\n]{2,80}(?:\*\*|__)/;
/** A list item that opens on a bold label: “- **When:** Saturday”. */
const BOLD_LIST_LEAD = /^[^\S\n]{0,3}[-*+][^\S\n]+(?:\*\*|__)[^*_\n]{1,60}(?:\*\*|__)/gm;
/** A heading below the title, to the end of its line. */
const HEADING_LINE = /^[^\S\n]{0,3}#{2,6}[^\S\n]+\S[^\n]*/gm;
const ENDING = /^\s*(?:ultimately|overall|in the end|in conclusion|in summary|to sum up|all in all)\b[,:]?/i;

/** The placeholder patterns, compiled once: capitals are whole words, the rest match in any case. */
const MARKERS = RULES.markers.map(
  (m) => new RegExp(/^[A-Z]+$/.test(m) ? `\\b${m}\\b` : m, /^[A-Z]+$/.test(m) ? 'g' : 'gi'),
);
/** The kinds of finding that count toward `stacked-tells`. */
const STACKED = new Set<string>(RULES.stacked.ids);

/** Lint words a person will read. `ok` is false when any finding fails. */
export function lintProse(text: string): ProseLint {
  const prose = blankNonProse(text);
  const allParas = paragraphs(prose);
  // A word never spans a line break, so the paragraphs hold every word of the text.
  const words = allParas.reduce((n, p) => n + p.words, 0);
  const findings: ProseFinding[] = [];
  const add = (id: string, severity: ProseSeverity, why: string, fix: string, matches: ProseMatch[]) => {
    if (matches.length) findings.push({ id, severity, why, fix, matches });
  };

  const unquoted = unquote(prose);
  const lower = unquoted.toLowerCase();
  const nameOrHeading = (p: string, i: number, m: string) => isName(p, i, m) && !onHeading(text, p, i);
  for (const [id, rule] of Object.entries(PHRASES)) {
    const skip = rule.exemptNames ? nameOrHeading : undefined;
    const matches = COMPILED[id]!.flatMap((ph) =>
      phraseHits(ph, unquoted, lower.length === unquoted.length ? lower : null),
    )
      .filter((m) => !skip?.(unquoted, m.index, m[0]))
      .sort((a, b) => a.index - b.index)
      // Two patterns can open on the same words (“we’re grateful to”, “we’re grateful”): one phrase is one match.
      .filter((m, i, a) => i === 0 || m.index !== a[i - 1]!.index)
      .map((m) => locate(text, m.index, text.slice(m.index, m.index + m[0].length)));
    if (rule.density !== undefined && matches.length / Math.max(1, words) <= rule.density) continue;
    if (rule.minHits !== undefined && matches.length < rule.minHits) continue;
    add(id, rule.severity, rule.why, rule.fix, matches);
  }

  // Two patterns can match the same span (“not just a tool, but”): one contrast is one match.
  const notBut = NOT_BUT.flatMap((re) => all(re, prose, text))
    .sort((a, b) => a.index - b.index)
    .filter((m, i, a) => i === 0 || m.index !== a[i - 1]!.index);
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

  const paras = allParas.filter((p) => !isHeading(p.text));
  const last = paras.at(-1);
  if (last && paras.length > 2 && ENDING.test(last.text))
    add(
      'summary-ending',
      'fail',
      'The last paragraph sums up what the reader just read.',
      'End on the last concrete point, or on what to do next.',
      [
        locate(
          text,
          last.index,
          text
            .slice(last.index, last.index + last.text.length)
            .trim()
            .split('\n')[0]!,
        ),
      ],
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
      leads.map((p) => {
        const lead = p.text.match(BOLD_LEAD)![0];
        return locate(text, p.index, text.slice(p.index, p.index + lead.length).trim());
      }),
    );

  const body = paras.filter((p) => !isList(p.text) && !/^\s*\|/.test(p.text));
  const u = RULES.uniform;
  if (
    body.length >= u.minParagraphs &&
    body.filter((p) => p.words <= u.maxWords).length / body.length >= u.share &&
    body.every((p) => p.words <= u.longest)
  )
    add(
      'uniform-paragraphs',
      'warn',
      `All ${body.length} paragraphs run ${Math.min(...body.map((p) => p.words))} to ${Math.max(...body.map((p) => p.words))} words. Generated drafts cut every paragraph to the same short size.`,
      'Let one paragraph run long where the thought needs it, and fold a one-line paragraph into its neighbor.',
      [
        locate(
          text,
          body[0]!.index,
          text
            .slice(body[0]!.index, body[0]!.index + body[0]!.text.length)
            .trim()
            .split('\n')[0]!,
        ),
      ],
    );

  const listLeads = all(BOLD_LIST_LEAD, prose, text);
  if (listLeads.length >= RULES.boldListLeads.min)
    add(
      'bold-list-leads',
      'warn',
      'Bullets that each open on a bold label read as a template.',
      'Write the items as plain lines, or as sentences that carry their own point.',
      listLeads,
    );

  const headings = all(HEADING_LINE, prose, text);
  if (
    headings.length >= RULES.headings.min &&
    (headings.length * 100) / Math.max(1, words) > RULES.headings.perHundred
  )
    add(
      'headings',
      'warn',
      `${headings.length} headings in ${words} words. A heading every few lines turns a short piece into slides.`,
      'Keep the headings a reader would scan to, and write the rest as paragraphs.',
      headings.map((h) => ({ ...h, text: h.text.trim() })),
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
      for (const h of hits)
        bold.push(
          locate(text, p.index + h.index, text.slice(p.index + h.index, p.index + h.index + h[0].length)),
        );
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
    MARKERS.flatMap((re) => all(re, unquoted, text)).sort((a, b) => a.index - b.index),
  );

  // No single weak tell proves anything. Several different ones in one piece is how generated drafts read.
  const weak = findings.filter((f) => STACKED.has(f.id));
  if (weak.length >= RULES.stacked.min)
    add(
      'stacked-tells',
      'fail',
      `${weak.length} different small tells in ${words} words (${weak.map((f) => f.id).join(', ')}). Each one is common alone; together they read as machine-made.`,
      'Rewrite the ones that are not your own voice until fewer than three kinds remain.',
      weak.map((f) => f.matches[0]!).sort((a, b) => a.index - b.index),
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
