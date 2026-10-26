// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `hildegard loop`: generate → render → critique → refine from a terminal, and a coding agent that runs a whole loop
 * for its owner (`loop run`). The loop itself lives in the server (apps/server/src/loop.ts); agents in AI apps drive
 * it with the loop_* MCP tools.
 */
import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Step } from '@hildegard/runtime';
import { runAgentTask, skillsDir } from './agents.ts';
import { api, baseUrl, type Ctx, ensureRunning, readStdin } from './commands.ts';
import { type Result, result } from './output.ts';

interface LoopSummary {
  id: string;
  kind: string;
  title: string;
  status: string;
  rounds: number;
  maxRounds: number;
  chosen: number | null;
  createdAt?: string;
  updatedAt: string;
}

const failed = (detail: string, command?: string): Result =>
  result([{ id: 'loop', title: 'Loop', status: 'failed', detail, command }], 'Nothing changed.');

/** "40x40x120" → [40, 40, 120]. */
export function parseSize(s: string | undefined): [number, number, number] | undefined {
  if (!s) return undefined;
  const p = s.split(/[x×,]/).map(Number);
  return p.length === 3 && p.every((n) => n > 0 && Number.isFinite(n))
    ? (p as [number, number, number])
    : undefined;
}

/** What a coding agent is asked to do in a loop run: the idea in the owner's words, and how to loop it. */
export function loopTask(o: {
  idea: string;
  kind: string;
  print: boolean;
  size?: [number, number, number];
  rounds?: number;
  skills?: string;
}): string {
  const targets = [
    `kind "${o.kind}"`,
    ...(o.print ? ['print true'] : []),
    ...(o.size ? [`size_mm [${o.size.join(', ')}]`] : []),
    ...(o.rounds ? [`max_rounds ${o.rounds}`] : []),
  ].join(', ');
  return [
    `Make this for me with Hildegard's loop: ${o.idea}`,
    '',
    `1. Read the skills first: hildegard-loop, ${o.kind === 'model' ? `hildegard-3d, ${o.print ? 'hildegard-print, hildegard-openscad, ' : ''}` : o.kind === 'web' ? 'hildegard-web, ' : ''}and hildegard for the craft (read_skill, or the skills folder in this workspace).`,
    `2. Write the brief, then loop_start with ${targets}.${o.print ? ' Read printer_profile first, and size every part that fits another from its clearances.' : ''}`,
    o.kind === 'model'
      ? `3. Build it in this workspace with what is installed here (Python with numpy, Blender, OpenSCAD). Keep the build in one script with named parameters.${o.skills ? ` mesh_kit.py is in ${join(o.skills, 'hildegard-3d', 'scripts')}.${o.print ? ` print_kit.py, to measure photos and keep the evidence, is in ${join(o.skills, 'hildegard-print', 'scripts')}.` : ''}` : ''} For a part with exact dimensions, write it in OpenSCAD (hildegard-openscad) and send the .scad (or its folder) itself; otherwise export GLB or STL. Send it with loop_submit and its absolute file_path.`
      : o.kind === 'web'
        ? '3. Build it in this workspace as plain HTML and CSS in a folder of its own, with every font, image and script inside that folder. Send the folder with loop_submit and its absolute file_path.'
        : '3. Make it with Hildegard’s tools (direct_shot, make_character_stills, speak) and send each result with loop_submit (take_id, still_id or file_path).',
    '4. Look at the sheet that comes back, view by view. Answer every question with loop_critique, honestly, pointing at the view or check. Change one thing, and send the next round.',
    '5. When a round passes, or the rounds run out, loop_finish with the best round and an honest note.',
    '6. Your last message: the loop id, the round you delivered, and what still fails. Don’t ask me questions; decide, and say what you decided.',
  ].join('\n');
}

/** Tools a headless Claude Code needs to model in its workspace, beyond reading and writing files there. */
const MODELING_TOOLS = ['Bash(python3:*)', 'Bash(python:*)', 'Bash(blender:*)', 'Bash(openscad:*)'];

export async function loop(ctx: Ctx, args: string[]): Promise<Result> {
  const action = args[0] ?? 'list';
  const up = await ensureRunning(ctx);
  if (up) return result([up], 'Start Hildegard first.');
  try {
    if (action === 'list') {
      const { loops } = await api<{ loops: LoopSummary[] }>(ctx.config, '/api/loops');
      return result(
        loops.slice(0, 30).map((l) => ({
          id: l.id,
          title: `${l.title} (${l.kind})`,
          status: 'done' as const,
          detail: `${l.status}, ${l.rounds} of ${l.maxRounds} rounds${l.chosen ? `, delivered round ${l.chosen}` : ''}`,
        })),
        loops.length ? '`hildegard loop show <id>` for one loop’s rounds.' : 'No loops yet.',
        { loops },
      );
    }
    if (action === 'show') {
      const id = args[1];
      if (!id) return failed('Name the loop: `hildegard loop show <id>`.');
      const l = await api<{
        id: string;
        title: string;
        status: string;
        chosen: number | null;
        note: string | null;
        rounds: Array<{
          n: number;
          note: string;
          file: string;
          sheet: string | null;
          review: { passed: boolean; summary: string };
          critique: { verdict: string; change?: string } | null;
        }>;
      }>(ctx.config, `/api/loops/${encodeURIComponent(id)}`);
      const steps: Step[] = l.rounds.map((r) => ({
        id: `round-${r.n}`,
        title: `Round ${r.n}: ${r.note}`,
        status: r.review.passed ? 'done' : 'failed',
        detail: `${r.review.summary}\n${r.critique ? `Critique: ${r.critique.verdict}${r.critique.change ? `, next “${r.critique.change}”` : ''}` : 'Not critiqued yet.'}\nFile: ${baseUrl(ctx.config)}${r.file}${r.sheet ? `\nSheet: ${baseUrl(ctx.config)}${r.sheet}` : ''}`,
      }));
      return {
        ...result(
          steps,
          `${l.title}: ${l.status}${l.chosen ? `, delivered round ${l.chosen}` : ''}.${l.note ? ` ${l.note}` : ''}`,
          { loop: l },
        ),
        ok: true,
      };
    }
    if (action === 'submit') {
      const [id, file] = [args[1], args[2]];
      if (!id || !file) return failed('`hildegard loop submit <id> <file> --note "what changed"`.');
      const path = resolve(file);
      if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return failed(`There’s no file at ${path}.`);
      const note = ctx.opts.get('note') ?? 'Sent from the command line';
      const res = await fetch(
        `${baseUrl(ctx.config)}/api/loops/${encodeURIComponent(id)}/rounds?note=${encodeURIComponent(note)}`,
        { method: 'POST', headers: { 'x-hildegard': '1' }, body: readFileSync(path) },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        round?: { n: number; sheet: string | null; review: { passed: boolean; summary: string } };
        questions?: string;
      };
      if (!res.ok || !data.round) return failed(data.error ?? `Hildegard answered ${res.status}.`);
      const r = data.round;
      return {
        ...result(
          [
            {
              id: `round-${r.n}`,
              title: `Round ${r.n}`,
              status: r.review.passed ? 'done' : 'failed',
              detail: `${r.review.summary}${r.sheet ? `\nSheet: ${baseUrl(ctx.config)}${r.sheet}` : ''}`,
            },
          ],
          'Look at the sheet, then critique it: `hildegard loop critique <id> <round> --stdin` with the answers as JSON.',
          { round: r, questions: data.questions },
        ),
        ok: true,
      };
    }
    if (action === 'critique') {
      const [id, n] = [args[1], Number(args[2])];
      if (!id || !n)
        return failed('`hildegard loop critique <id> <round> --stdin`, with {answers, change} on stdin.');
      const body = JSON.parse(await readStdin()) as unknown;
      const r = await api<{ verdict: string; next: string }>(
        ctx.config,
        `/api/loops/${encodeURIComponent(id)}/rounds/${n}/critique`,
        {
          method: 'POST',
          body,
        },
      );
      return result(
        [{ id: 'critique', title: `Round ${n}: ${r.verdict}`, status: 'done', detail: r.next }],
        r.next.split('\n')[0]!,
        r,
      );
    }
    if (action === 'finish') {
      const [id, n] = [args[1], Number(args[2])];
      const note = ctx.opts.get('note');
      if (!id || !n || !note)
        return failed('`hildegard loop finish <id> <round> --note "what it is and what still fails"`.');
      await api(ctx.config, `/api/loops/${encodeURIComponent(id)}/finish`, {
        method: 'POST',
        body: { round: n, note },
      });
      return result(
        [{ id: 'finish', title: `Delivered round ${n}`, status: 'done', detail: note }],
        'Finished.',
      );
    }
    if (action === 'run') return await run(ctx, args.slice(1));
  } catch (e) {
    return failed((e as Error).message);
  }
  return failed(`Unknown action “${action}”. Use list, show, submit, critique, finish or run.`);
}

/** `hildegard loop run <agent> "<idea>"`: a coding agent runs the whole loop, then says which round it delivered. */
async function run(ctx: Ctx, args: string[]): Promise<Result> {
  const agent = args[0];
  const idea = ctx.flags.has('task-stdin') ? await readStdin() : args.slice(1).join(' ').trim();
  if (!agent || !idea)
    return failed(
      '`hildegard loop run <codex|claude-code|omp> "<what to make>" [--kind model|web|image|video|audio] [--print] [--size 40x40x120]`.',
    );
  const kind = ctx.opts.get('kind') ?? 'model';
  if (!['model', 'web', 'image', 'video', 'audio'].includes(kind))
    return failed('--kind is model, web, image, video or audio.');
  const size = parseSize(ctx.opts.get('size'));
  if (ctx.opts.get('size') && !size)
    return failed('--size is three numbers in millimetres, such as 40x40x120.');
  const rounds = ctx.opts.get('rounds') ? Number(ctx.opts.get('rounds')) : undefined;
  const since = new Date().toISOString();
  const task = loopTask({
    idea,
    kind,
    print: ctx.flags.has('print'),
    size,
    rounds,
    skills: skillsDir() ?? undefined,
  });
  const r = await runAgentTask(ctx, agent, task, kind === 'model' ? MODELING_TOOLS : []);
  // The loop the agent started: the newest one made since the run began.
  const { loops } = await api<{ loops: LoopSummary[] }>(ctx.config, '/api/loops').catch(() => ({
    loops: [] as LoopSummary[],
  }));
  const made = loops.filter((l) => (l.createdAt ?? l.updatedAt) >= since);
  const latest = made[0];
  return {
    ...r,
    loop: latest ?? null,
    message: latest
      ? `${r.message} Loop ${latest.id}: ${latest.status}${latest.chosen ? `, delivered round ${latest.chosen}` : ''}. \`hildegard loop show ${latest.id}\` shows every round.`
      : `${r.message} It didn’t start a loop.`,
  };
}
