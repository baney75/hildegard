// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  type Draft,
  describeRemoved,
  findSkills,
  HOW,
  type ReportKind,
  readSkills,
  SkillScanError,
} from '@hildegard/mcp';
import { layout } from '@hildegard/runtime';
import {
  baseFacts,
  knownHere,
  logTail,
  osLabel,
  ReportError,
  Reports,
  SOURCE,
  VERSION,
} from '@hildegard/server';
import { type Ctx, readStdin } from './commands.ts';
import { doctor } from './doctor.ts';
import { bold, dim, type Result, result } from './output.ts';

const MARK = { done: '✓', skipped: '·', 'needs-owner': '!', failed: '✗' } as const;

/** Posting in public is not a default: only "y" files. */
async function askNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

const reportsOf = (ctx: Ctx) => new Reports({ dir: join(ctx.config.dataDir, 'reports') });

function show(d: Draft) {
  console.log(
    `${bold(d.title)}\n${dim(`${d.kind === 'bug' ? 'Bug report' : 'Idea'} for ${d.repo} · draft ${d.id}`)}\n`,
  );
  console.log(d.body);
  console.log(`\n${dim(describeRemoved(d.removed))}`);
  if (d.similar === null)
    console.log(dim('GitHub couldn’t be searched just now; look at the open issues before filing.'));
  else if (d.similar.length) {
    console.log(`\n${bold('Issues that may be the same')}`);
    for (const s of d.similar) console.log(`  #${s.number} (${s.state}) ${s.title}\n  ${dim(s.url)}`);
  }
}

/**
 * `hildegard report bug|idea "<title>" --what "<…>"`: draft a report for Hildegard's makers, with `hildegard doctor`
 * and the end of the log, private things taken out. `report file` sends the draft as it was shown, through the
 * GitHub CLI; without it, the form filled in is the way.
 */
export async function report(ctx: Ctx, args: string[]): Promise<Result> {
  const [sub, ...rest] = args;
  const reports = reportsOf(ctx);
  if (sub === 'show' || sub === 'file') {
    const d = reports.get(rest[0]);
    if (!d)
      return result(
        [
          {
            id: 'report',
            title: 'Report',
            status: 'failed',
            detail: rest[0] ? `No draft "${rest[0]}".` : 'No drafts yet.',
            command: 'hildegard report bug "<what broke>" --what "<what happened>"',
          },
        ],
        'Nothing to show.',
      );
    if (sub === 'show') {
      if (!ctx.json) show(d);
      return result(
        [],
        d.filed
          ? `Filed: ${d.filed.url}`
          : `Not filed. Send it with \`hildegard report file ${d.id}\`, or from the form: ${d.url}`,
        { draft: d },
      );
    }
    const on = ctx.opts.has('on') ? Number(ctx.opts.get('on')) : undefined;
    if (on !== undefined && !(Number.isInteger(on) && on > 0))
      return result(
        [{ id: 'report', title: 'Report', status: 'failed', detail: '--on is an issue number.' }],
        'Not filed.',
      );
    try {
      const filed = await reports.file(d.id, on);
      return result(
        [{ id: 'report', title: on ? `Added to #${on}` : 'Filed', status: 'done', detail: filed.filed!.url }],
        `Thank you. The maintainers answer at ${filed.filed!.url}`,
        { draft: filed },
      );
    } catch (e) {
      if (!(e instanceof ReportError)) throw e;
      return result(
        [{ id: 'report', title: 'Report', status: 'failed', detail: e.message }],
        e.url ? `Send it from the form instead, filled in: ${e.url}` : 'Not filed.',
        { url: e.url ?? null },
      );
    }
  }
  if (sub !== 'bug' && sub !== 'idea' && sub !== 'skill')
    return result(
      [
        {
          id: 'report',
          title: 'Report',
          status: 'failed',
          detail:
            'Say what kind: hildegard report bug "<what broke>" --what "<what happened>", or hildegard report idea "<what you want>" --what "<the work>", or hildegard report skill "<what to change>" --skill <name> --model <model> --what "<what happened>" --change-file <file>. Then hildegard report file sends it.',
        },
      ],
      'Nothing drafted.',
    );
  const kind: ReportKind = sub;
  const title = rest.join(' ').trim();
  const what = ctx.flags.has('stdin') ? await readStdin() : (ctx.opts.get('what') ?? '').trim();
  if (title.length < 4 || !what)
    return result(
      [
        {
          id: 'report',
          title: 'Report',
          status: 'failed',
          detail:
            'A report needs a title (one line, in quotes) and --what (or the text on stdin with --stdin).',
          command: `hildegard report ${kind} "<one line>" --what "<${kind === 'bug' ? 'what you did, expected, and got' : 'what you want to make or do'}>"`,
        },
      ],
      'Nothing drafted.',
    );
  const how = ctx.opts.get('how');
  if (how && !(HOW as readonly string[]).includes(how))
    return result(
      [{ id: 'report', title: 'Report', status: 'failed', detail: `--how is one of: ${HOW.join('; ')}.` }],
      'Nothing drafted.',
    );

  let change = ctx.opts.get('change');
  if (ctx.opts.has('change-file')) change = readFileSync(ctx.opts.get('change-file')!, 'utf8');
  const skill = ctx.opts.get('skill');
  if (kind === 'skill') {
    const names = readSkills(findSkills()).map((x) => x.name);
    if (!skill || !names.includes(skill))
      return result(
        [
          {
            id: 'report',
            title: 'Report',
            status: 'failed',
            detail: `--skill is one of: ${names.join(', ')}.`,
          },
        ],
        'Nothing drafted.',
      );
  }

  // The doctor's checks are the diagnostics a maintainer asks for first; a skill suggestion needs only the version.
  const d = kind === 'skill' ? { steps: [], gpu: undefined } : await doctor({ ...ctx, json: true });
  const gpu = d.gpu as { name?: string; vramGb?: number | null } | undefined;
  const facts: Record<string, string> = baseFacts(VERSION, SOURCE.commit);
  if (gpu?.name) facts.GPU = `${gpu.name}${gpu.vramGb ? `, ${gpu.vramGb} GB` : ''}`;
  const withLog = kind === 'bug' && !ctx.flags.has('no-log');
  let draft: Draft;
  try {
    draft = await reports.draft(
      {
        kind,
        skill,
        model: ctx.opts.get('model'),
        change,
        title,
        what,
        now: ctx.opts.get('now'),
        more: ctx.opts.get('more'),
        how: how as (typeof HOW)[number] | undefined,
        agent:
          ctx.opts.get('agent') ??
          (process.stdin.isTTY ? 'the hildegard command' : 'an agent using the hildegard command'),
      },
      kind === 'skill'
        ? { facts: { Hildegard: facts.Hildegard! } }
        : {
            os: osLabel(),
            facts,
            checks:
              kind === 'bug' ? d.steps.map((s) => `${MARK[s.status]} ${s.title}: ${s.detail}`) : undefined,
            log: withLog ? logTail(layout(ctx.config.dataDir).logs) : undefined,
          },
      knownHere(),
    );
  } catch (e) {
    if (!(e instanceof SkillScanError)) throw e;
    return result(
      [{ id: 'report', title: 'Skill suggestion', status: 'failed', detail: e.message }],
      'Nothing drafted.',
      {
        findings: e.findings,
      },
    );
  }
  const filer = await reports.filer();
  if (!ctx.json) show(draft);
  // A person at a terminal answers here; an agent shows its person the draft and runs `report file` on their yes.
  if (!ctx.json && process.stdin.isTTY && filer) {
    if (await askNo(`\nFile this on GitHub as ${filer}?`)) return report(ctx, ['file', draft.id]);
    return result([], `Not filed. To send it yourself, open the form, filled in: ${draft.url}`, { draft });
  }
  return result(
    [],
    filer
      ? `Drafted ${draft.id}; nothing is sent. Show the person this text, and on their yes run \`hildegard report file ${draft.id}\` (files as ${filer}; --on <number> adds it to an issue already open). Or they send it from the form: ${draft.url}`
      : `Drafted ${draft.id}; nothing is sent. The GitHub CLI isn’t signed in here, so the person sends it from the form, filled in: ${draft.url}`,
    { draft, filer },
  );
}
