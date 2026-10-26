// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bug reports and ideas, from the agents that use Hildegard to the people who make it. A draft is written to disk
 * first, with private things taken out, and shown to the person; only that draft, unchanged, can be filed, and only
 * when they said yes. The owner's own GitHub CLI files it, as them; anyone else gets the issue form filled in, to
 * send from their own account.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, homedir, hostname, platform, release, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  type Diagnostics,
  type Draft,
  draftReport,
  ISSUES_REPO,
  type Known,
  type OS,
  type ReportInput,
  similarIssues,
} from '@hildegard/mcp';

/** Runs `gh` with these arguments and this input, and says what it printed. */
export type GhRunner = (args: string[], input?: string) => Promise<{ ok: boolean; out: string }>;

export const runGh: GhRunner = (args, input) =>
  new Promise((resolve) => {
    const child = execFile(
      'gh',
      args,
      {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
      (err, stdout, stderr) =>
        resolve({ ok: !err, out: `${stdout}${err ? stderr || err.message : ''}`.trim() }),
    );
    child.stdin?.end(input ?? '');
  });

export class ReportError extends Error {
  readonly status: number;
  readonly url?: string;
  constructor(status: number, message: string, url?: string) {
    super(message);
    this.status = status;
    this.url = url;
  }
}

/** Reports filed from one computer in a day: enough for real trouble, too few for an agent stuck in a loop. */
export const FILE_LIMIT = 5;
const DAY = 24 * 3600_000;
const ID = /^r[0-9a-f]{12}$/;

export interface ReportsOptions {
  dir: string;
  repo?: string;
  fetchFn?: typeof fetch;
  gh?: GhRunner;
  now?: () => number;
}

export class Reports {
  readonly dir: string;
  readonly repo: string;
  private readonly fetchFn: typeof fetch;
  private readonly gh: GhRunner;
  private readonly now: () => number;
  private signedIn: { at: number; login: string | null } | null = null;

  constructor(o: ReportsOptions) {
    this.dir = o.dir;
    this.repo = o.repo ?? process.env.HILDEGARD_ISSUES_REPO ?? ISSUES_REPO;
    this.fetchFn = o.fetchFn ?? fetch;
    this.gh = o.gh ?? runGh;
    this.now = o.now ?? Date.now;
  }

  /** Writes the draft and looks for issues like it. Nothing leaves this computer but the title's words, to search. */
  async draft(input: ReportInput, diag: Diagnostics, known: Known = knownHere()): Promise<Draft> {
    const d = draftReport(input, diag, known, this.repo);
    const draft: Draft = {
      ...d,
      id: `r${randomBytes(6).toString('hex')}`,
      at: new Date(this.now()).toISOString(),
      similar: await similarIssues(d.title, this.repo, this.fetchFn),
    };
    this.save(draft);
    return draft;
  }

  /** A draft by id, or the newest. */
  get(id?: string): Draft | null {
    if (id !== undefined) {
      if (!ID.test(id)) return null;
      const p = join(this.dir, `${id}.json`);
      return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Draft) : null;
    }
    const newest = this.all().sort((a, b) => b.at.localeCompare(a.at))[0];
    return newest ?? null;
  }

  private all(): Draft[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => ID.test(f.replace(/\.json$/, '')) && f.endsWith('.json'))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as Draft];
        } catch {
          return [];
        }
      });
  }

  private save(d: Draft) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, `${d.id}.json`), `${JSON.stringify(d, null, 2)}\n`, { mode: 0o600 });
  }

  /** The GitHub account the GitHub CLI here is signed in to, or null if there's no CLI or no sign-in. */
  async filer(): Promise<string | null> {
    if (this.signedIn && this.now() - this.signedIn.at < 5 * 60_000) return this.signedIn.login;
    const r = await this.gh(['api', 'user', '--jq', '.login']);
    const login = r.ok && /^[\w-]{1,39}$/.test(r.out) ? r.out : null;
    this.signedIn = { at: this.now(), login };
    return login;
  }

  /**
   * Files a draft, exactly as it was shown, through the GitHub CLI: a new issue, or with `on`, a comment on one
   * already open. A draft files once; a computer files at most FILE_LIMIT a day.
   */
  async file(id: string, on?: number): Promise<Draft> {
    const d = this.get(id);
    if (!d) throw new ReportError(404, `No draft "${id}". Make one with report_draft first.`);
    if (d.filed) throw new ReportError(409, `Draft ${id} was filed already: ${d.filed.url}`, d.filed.url);
    const today = this.all().filter((x) => x.filed && this.now() - Date.parse(x.filed.at) < DAY);
    if (today.length >= FILE_LIMIT)
      throw new ReportError(
        429,
        `${FILE_LIMIT} reports have gone from this computer today, which is the most Hildegard sends in a day. The person can still send this one themselves from the form.`,
        d.url,
      );
    const twin = this.all().find(
      (x) => x.id !== d.id && x.filed && !x.filed.on && x.kind === d.kind && same(x.title, d.title),
    );
    if (twin && !on)
      throw new ReportError(
        409,
        `This computer filed the same ${d.kind === 'bug' ? 'bug' : 'idea'} already: ${twin.filed!.url}. Add to that one instead, with on set to its number.`,
        twin.filed!.url,
      );
    if (!(await this.filer()))
      throw new ReportError(
        424,
        'The GitHub CLI (gh) isn’t signed in here, so Hildegard can’t file it as the owner. Give the person the form, filled in, to send themselves.',
        d.url,
      );
    let url: string;
    if (on) {
      const body = `${d.kind === 'bug' ? 'The same bug, seen again' : 'Another person wants this'}: **${d.title}**\n\n${d.body}`;
      const r = await this.gh(
        ['issue', 'comment', String(on), '--repo', this.repo, '--body-file', '-'],
        body,
      );
      if (!r.ok) throw new ReportError(502, `GitHub didn’t take the comment: ${r.out.slice(0, 300)}`, d.url);
      url =
        r.out.split(/\s+/).find((w) => w.startsWith('https://')) ??
        `https://github.com/${this.repo}/issues/${on}`;
    } else {
      const args = ['issue', 'create', '--repo', this.repo, '--title', d.title, '--body-file', '-'];
      let r = await this.gh([...args, ...d.labels.flatMap((l) => ['--label', l])], d.body);
      // A label the repository doesn't have fails the whole issue; the maintainers can label it themselves.
      if (!r.ok && /label/i.test(r.out)) r = await this.gh(args, d.body);
      if (!r.ok) throw new ReportError(502, `GitHub didn’t take the issue: ${r.out.slice(0, 300)}`, d.url);
      url =
        r.out.split(/\s+/).find((w) => w.startsWith('https://')) ?? `https://github.com/${this.repo}/issues`;
    }
    d.filed = { url, at: new Date(this.now()).toISOString(), ...(on ? { on } : {}) };
    this.save(d);
    return d;
  }
}

const same = (a: string, b: string) =>
  a
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim() ===
  b
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** What on this computer is private: its home folder, the account, its name. */
export function knownHere(names: string[] = []): Known {
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {}
  return { home: homedir(), user, host: hostname().replace(/\.local$/, ''), names };
}

/** The bug form's "Computer". Omarchy is Arch with its own folder in the home. */
export function osLabel(): (typeof OS)[number] {
  const p = platform();
  if (p === 'win32') return 'Windows';
  if (p === 'darwin') return 'macOS';
  if (p === 'linux')
    return existsSync(join(homedir(), '.local', 'share', 'omarchy')) || process.env.OMARCHY_PATH
      ? 'Omarchy'
      : 'Linux';
  return 'Other';
}

export function baseFacts(
  version: string,
  commit: string | null,
): { Hildegard: string } & Record<string, string> {
  return {
    Hildegard: `${version}${commit ? ` (${commit.slice(0, 7)})` : ''}`,
    System: `${osLabel()} · ${platform()} ${release()} · ${arch()}`,
    Node: process.versions.node,
  };
}

/** The last lines of the server's log, newest last; only lines worth reading, and at most `n` of them. */
export function logTail(logsDir: string, n = 40): string[] {
  const p = join(logsDir, 'server.log');
  if (!existsSync(p)) return [];
  const size = statSync(p).size;
  const want = 64 * 1024;
  const buf = readFileSync(p);
  const text = buf.subarray(Math.max(0, size - want)).toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (size > want) lines.shift();
  return lines.slice(-n).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l));
}
