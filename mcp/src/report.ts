// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bug reports and ideas for Hildegard's makers, drafted by the agent that ran into them. Nothing here sends anything:
 * it writes the text (with private things taken out), the link that opens the repository's issue form filled in, and
 * looks for issues already open that sound the same. Filing is the server's, and only after the person said yes.
 */

export type ReportKind = 'bug' | 'idea';

export interface ReportInput {
  kind: ReportKind;
  /** One line: what broke, or what they want. */
  title: string;
  /** A bug: what was done, what was expected, and what happened. An idea: the work they want to make or do. */
  what: string;
  /** A bug: the steps that make it happen again. An idea: how they do it today. */
  now?: string;
  /** Anything else: the prompt, the model, an error's words. */
  more?: string;
  /** How Hildegard runs, as the bug form names it. */
  how?: (typeof HOW)[number];
  /** The agent drafting it, as it names itself. */
  agent?: string;
}

/** What the computer says about itself: a few facts, the doctor's checks, and the end of the server's log. */
export interface Diagnostics {
  facts: Record<string, string>;
  checks?: string[];
  log?: string[];
  /** The bug form's "Computer". */
  os?: (typeof OS)[number];
}

export interface Similar {
  number: number;
  title: string;
  url: string;
  state: string;
  comments: number;
}

export interface Draft {
  id: string;
  kind: ReportKind;
  at: string;
  repo: string;
  title: string;
  /** Exactly what is filed. */
  body: string;
  labels: string[];
  /** The issue form, filled in, for the person to send from their own browser. */
  url: string;
  /** What was taken out, by kind: the person sees the count and the text, never what was removed. */
  removed: Record<string, number>;
  similar: Similar[] | null;
  filed?: { url: string; at: string; on?: number };
}

export const OS = ['Windows', 'macOS', 'Linux', 'Omarchy', 'Other'] as const;
export const HOW = [
  'The desktop app',
  'The one-line installer',
  'Hildegard at a link',
  'An AI app over MCP',
  'Built from source',
] as const;

export const ISSUES_REPO = 'baney75/hildegard';
/** GitHub refuses longer links; the filled-in form drops the log first, then shortens the rest. */
const MAX_URL = 7500;

export interface Known {
  /** The home folder, and any other folders to name only as `~`. */
  home?: string;
  user?: string;
  host?: string;
  /** Device and people names that are no one else's business. */
  names?: string[];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Takes out what a stranger reading a public issue shouldn't see: keys and tokens, home folders and the account name,
 * this computer's and the tailnet's names, addresses and emails. Each kind is counted, so the person can be told.
 */
export function redact(text: string, known: Known = {}): { text: string; removed: Record<string, number> } {
  const removed: Record<string, number> = {};
  let out = text;
  const sub = (kind: string, re: RegExp, by: string | ((...m: string[]) => string)) => {
    out = out.replace(re, (...m: string[]) => {
      removed[kind] = (removed[kind] ?? 0) + 1;
      return typeof by === 'string' ? by : by(...m);
    });
  };
  // Secrets first, before any path or name inside one is touched.
  sub('key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '<private key>');
  sub('key', /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<token>');
  sub(
    'key',
    /\b(?:hf_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-(?:ant-|proj-)?[\w-]{16,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16}|AIza[\w-]{30,}|hg[kargoc]_[\w-]{16,}|rpa_[\w-]{16,}|tskey-[\w-]{10,})/g,
    '<key>',
  );
  sub('key', /\b(Bearer|Basic|token)\s+[\w.~+/=-]{12,}/gi, (_m, scheme) => `${scheme} <key>`);
  sub(
    'key',
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passphrase|passwd|pwd|signature|key)["']?\s*[:=]\s*["']?)([^\s"'&,;]{6,})/gi,
    (_m, k) => `${k}<key>`,
  );
  sub('key', /([?&](?:code|sig|state|exp)=)[^\s&#"']+/g, (_m, k) => `${k}<key>`);
  sub('key', /(\/\/)[^/\s:@]+:[^/\s@]+@/g, (_m, s) => `${s}<user>:<key>@`);
  // Folders: this home first, then anyone's.
  for (const h of [known.home].filter((x): x is string => !!x && x.length > 3))
    for (const form of new Set([h, h.replace(/\\/g, '/'), h.replace(/\//g, '\\')]))
      sub('path', new RegExp(`(?:\\b[A-Za-z]:)?${esc(form)}`, 'gi'), '~');
  sub('path', /\/(?:Users|home)\/[^/\s"'`:]+/g, '~');
  sub('path', /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`:]+/gi, '~');
  sub('path', /\/root(?=\/)/g, '~');
  // Names and addresses.
  sub('name', /\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi, '<tailnet name>');
  sub('email', /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '<email>');
  sub('address', /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>');
  sub('address', /\b(?:[0-9a-f]{1,4}:){5,7}[0-9a-f]{1,4}\b/gi, '<address>');
  const names = [known.user, known.host, ...(known.names ?? [])].filter(
    (x): x is string => !!x && x.length >= 3 && !/^(root|user|admin|local|localhost)$/i.test(x),
  );
  for (const n of [...new Set(names)].sort((a, b) => b.length - a.length))
    sub('name', new RegExp(`(?<![\\w-])${esc(n)}(?![\\w-])`, 'gi'), '<name>');
  // Long random-looking strings that slipped through: ids are fine, secrets are not worth the risk.
  // A secret mixes cases and digits; a commit, a hash or a model's name doesn't.
  sub('key', /\b(?=[\w-]*\d)(?=[\w-]*[a-z])(?=[\w-]*[A-Z])[\w-]{32,}\b/g, '<key>');
  return { text: out, removed };
}

const fence = (lang: string, s: string) => {
  const ticks = s.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${s}\n${ticks}`;
};

/** The body, under the issue form's own headings, so a filed report reads like one sent from the form. */
export function reportBody(input: ReportInput, diag: Diagnostics): string {
  const parts: string[] = [];
  const section = (head: string, s: string | undefined) => {
    if (s?.trim()) parts.push(`### ${head}\n\n${s.trim()}`);
  };
  const facts = Object.entries(diag.facts)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  if (input.kind === 'bug') {
    section('What happened', input.what);
    section('Steps to make it happen again', input.now);
    const doctor = [facts, ...(diag.checks?.length ? ['', ...diag.checks] : [])].join('\n');
    section('hildegard doctor', doctor.trim() ? fence('text', doctor) : undefined);
    section('Computer', diag.os ?? 'Other');
    section('How you run it', input.how);
    const log = diag.log?.length
      ? `<details><summary>The end of Hildegard’s log</summary>\n\n${fence('text', diag.log.join('\n'))}\n\n</details>`
      : '';
    section('Anything else', [input.more?.trim(), log].filter(Boolean).join('\n\n'));
  } else {
    section('What you want to make or do', input.what);
    section('How you do it today', input.now);
    section('Your GPU', diag.facts.GPU);
    section(
      'Anything else',
      [input.more?.trim(), facts ? fence('text', facts) : ''].filter(Boolean).join('\n\n'),
    );
  }
  parts.push(
    `---\n_Drafted by ${input.agent?.trim() ? input.agent.trim().slice(0, 60) : 'an AI app'} with Hildegard’s report tool. The person it works for read this before it was sent; keys, paths, names and addresses were taken out._`,
  );
  return parts.join('\n\n');
}

/** The issue form, filled in: GitHub fills each field from the query, by the field's id in the form. */
export function issueUrl(repo: string, input: ReportInput, diag: Diagnostics, title: string): string {
  const base = `https://github.com/${repo}/issues/new`;
  const make = (d: Diagnostics, cut: number) => {
    const clip = (s: string | undefined) => (s && s.length > cut ? `${s.slice(0, cut)}…` : s);
    const q = new URLSearchParams();
    q.set('title', title);
    if (input.kind === 'bug') {
      q.set('template', 'bug.yml');
      q.set('what', clip([input.what, input.now && `Steps:\n${input.now}`].filter(Boolean).join('\n\n'))!);
      const facts = Object.entries(d.facts).map(([k, v]) => `${k}: ${v}`);
      q.set('doctor', clip([...facts, ...(d.checks ?? [])].join('\n'))!);
      q.set('os', d.os ?? 'Other');
      if (input.how) q.set('how', input.how);
      const more = [input.more, d.log?.length ? `Log:\n${d.log.join('\n')}` : '']
        .filter(Boolean)
        .join('\n\n');
      if (more) q.set('more', clip(more)!);
    } else {
      q.set('template', 'idea.yml');
      q.set('want', clip(input.what)!);
      if (input.now) q.set('now', clip(input.now)!);
      if (d.facts.GPU) q.set('gpu', d.facts.GPU);
    }
    return `${base}?${q.toString()}`;
  };
  let url = make(diag, 4000);
  if (url.length > MAX_URL) url = make({ ...diag, log: undefined }, 4000);
  for (let cut = 2000; url.length > MAX_URL && cut >= 200; cut = Math.floor(cut / 2))
    url = make({ ...diag, log: undefined, checks: undefined }, cut);
  return url;
}

/** Everything a draft needs, private things taken out of every part of it. */
export function draftReport(
  input: ReportInput,
  diag: Diagnostics,
  known: Known,
  repo = ISSUES_REPO,
): Omit<Draft, 'id' | 'at' | 'similar'> {
  const removed: Record<string, number> = {};
  const clean = (s: string | undefined) => {
    if (s === undefined) return undefined;
    const r = redact(s, known);
    for (const [k, n] of Object.entries(r.removed)) removed[k] = (removed[k] ?? 0) + n;
    return r.text;
  };
  const safe: ReportInput = {
    ...input,
    title: clean(input.title.replace(/\s+/g, ' ').trim().slice(0, 120))!,
    what: clean(input.what)!,
    now: clean(input.now),
    more: clean(input.more),
  };
  const d: Diagnostics = {
    os: diag.os,
    facts: Object.fromEntries(Object.entries(diag.facts).map(([k, v]) => [k, clean(v)!])),
    checks: diag.checks?.map((c) => clean(c)!),
    log: diag.log?.map((l) => clean(l)!),
  };
  return {
    kind: input.kind,
    repo,
    title: safe.title,
    body: reportBody(safe, d),
    labels: [input.kind],
    url: issueUrl(repo, safe, d, safe.title),
    removed,
  };
}

const STOP = new Set(
  'a an and are as at be but by can cant do does doesnt dont for from has have how i if in into is it its me my no not of on or so that the this to was when with wont you your hildegard'.split(
    ' ',
  ),
);

/** The words worth searching for: what's left of the title without small words and punctuation. */
export function searchTerms(title: string): string {
  return title
    .toLowerCase()
    .replace(/<[^>]*>/g, ' ')
    .replace(/[’']/g, '')
    .split(/[^\p{L}\p{N}.-]+/u)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .slice(0, 6)
    .join(' ');
}

/**
 * Issues that sound the same, open ones first. Only the title's words go to GitHub, after private things are out;
 * null when GitHub can't be asked.
 */
export async function similarIssues(
  title: string,
  repo = ISSUES_REPO,
  fetchFn: typeof fetch = fetch,
): Promise<Similar[] | null> {
  const terms = searchTerms(title);
  if (!terms) return [];
  const q = `repo:${repo} is:issue ${terms}`;
  try {
    const res = await fetchFn(`https://api.github.com/search/issues?q=${encodeURIComponent(q)}&per_page=5`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'hildegard' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{
        number: number;
        title: string;
        html_url: string;
        state: string;
        comments: number;
        pull_request?: unknown;
      }>;
    };
    return (data.items ?? [])
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        url: i.html_url,
        state: i.state,
        comments: i.comments,
      }))
      .sort((a, b) => (a.state === b.state ? 0 : a.state === 'open' ? -1 : 1));
  } catch {
    return null;
  }
}

/** What was taken out, in words: "2 paths and a key". */
export function describeRemoved(removed: Record<string, number>): string {
  const words: Record<string, [string, string]> = {
    key: ['a key or token', 'keys or tokens'],
    path: ['a folder path', 'folder paths'],
    name: ['a name', 'names'],
    email: ['an email address', 'email addresses'],
    address: ['an IP address', 'IP addresses'],
  };
  const parts = Object.entries(removed)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => (n === 1 ? (words[k]?.[0] ?? k) : `${n} ${words[k]?.[1] ?? k}`));
  if (!parts.length) return 'Nothing private was found to take out.';
  return `Taken out: ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`}.`;
}

/** The draft, as an agent shows it to the person before asking. */
export function describeDraft(d: Draft, canFile: string | null): string {
  const similar =
    d.similar === null
      ? 'GitHub couldn’t be searched just now, so look at the open issues yourself before filing.'
      : d.similar.length
        ? `Issues that may be the same:\n${d.similar.map((s) => `- #${s.number} (${s.state}) ${s.title}: ${s.url}`).join('\n')}\nIf one of them is this, add to it instead: report_file with on set to its number.`
        : 'No issue like it is open yet.';
  return [
    `Draft ${d.id}, a ${d.kind === 'bug' ? 'bug report' : 'feature idea'} for ${d.repo}. Nothing has been sent.`,
    `Title: ${d.title}`,
    `--- the exact text ---\n${d.body}\n--- end ---`,
    describeRemoved(d.removed),
    similar,
    canFile
      ? `Show your user the title and text above, word for word, and ask whether to file it. Only if they say yes, call report_file with draft "${d.id}" and confirm true; it files as ${canFile} on GitHub. They can also send it themselves from the form, filled in: ${d.url}`
      : `Show your user the title and text above, and give them this link: it opens the form on GitHub filled in, for them to read and send from their own account. ${d.url}`,
  ].join('\n\n');
}
