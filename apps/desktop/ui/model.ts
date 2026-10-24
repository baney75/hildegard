// SPDX-License-Identifier: AGPL-3.0-only
// What the start-up page knows, apart from drawing it: the app's answers (src-tauri/src/lib.rs) and the install's
// progress, step by step.

export type StepStatus = 'done' | 'skipped' | 'needs-owner' | 'failed';

/** One step, as `hildegard install` reports it. */
export interface Step {
  id: string;
  title: string;
  status: StepStatus;
  detail: string;
  command?: string;
}

/** What the app says after looking for Hildegard. */
export type Launch =
  | { kind: 'studio' }
  | { kind: 'install'; data: string; partly: boolean }
  | { kind: 'failed'; message: string; log: string };

export type InstallEvent = { kind: 'step'; step: Step } | { kind: 'log'; line: string };

export interface Outcome {
  ok: boolean;
  needsOwner: boolean;
  steps: Step[];
  message: string;
}

/** The steps of a first install, in order, as the page shows them before they run. */
export const PLAN: { id: string; title: string }[] = [
  { id: 'app', title: 'Put Hildegard in its folder' },
  { id: 'gpu', title: 'Find the GPU' },
  { id: 'uv', title: 'Get uv' },
  { id: 'comfyui', title: 'Get ComfyUI' },
  { id: 'python', title: 'Set up Python' },
  { id: 'packages', title: 'Install PyTorch and ComfyUI’s packages' },
  { id: 'film-look', title: 'Add the film look and the safety check' },
  { id: 'check', title: 'Check the GPU works' },
  { id: 'start', title: 'Start Hildegard' },
];

export interface Progress {
  /** Every step, planned or reported, in order. `status` is null for a step that hasn't happened yet. */
  rows: { id: string; title: string; status: StepStatus | null; detail: string; command?: string }[];
  /** The step running now: the first that hasn't happened, while nothing has failed. */
  current: string | null;
  /** 0 to 1. */
  fraction: number;
  /** Steps done (or already here), of all the rows. */
  done: number;
  total: number;
}

/** The install so far, from the steps reported until now. */
export function progress(reported: Step[]): Progress {
  const byId = new Map(reported.map((s) => [s.id, s]));
  const rows: Progress['rows'] = PLAN.map((p) => {
    const s = byId.get(p.id);
    return s ? { ...s } : { ...p, status: null, detail: '' };
  });
  // Steps the plan doesn't know (the hildegard command, an error) go after the last one reported before them.
  for (const s of reported)
    if (!PLAN.some((p) => p.id === s.id)) {
      const before = reported.indexOf(s) - 1;
      const at = before >= 0 ? rows.findIndex((r) => r.id === reported[before]!.id) + 1 : 0;
      rows.splice(at || rows.length, 0, { ...s });
    }
  const stopped = reported.some((s) => s.status === 'failed' || s.status === 'needs-owner');
  const done = rows.filter((r) => r.status === 'done' || r.status === 'skipped').length;
  return {
    rows,
    current: stopped ? null : (rows.find((r) => r.status === null)?.id ?? null),
    fraction: rows.length ? done / rows.length : 0,
    done,
    total: rows.length,
  };
}

/** Adds a reported step, or replaces the one with its id. */
export function report(steps: Step[], step: Step): Step[] {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i < 0) return [...steps, step];
  const next = steps.slice();
  next[i] = step;
  return next;
}

/** The step a person must look at when the install didn't finish: what failed, or what only they can do. */
export function blocker(o: Outcome): Step | null {
  return (
    o.steps.find((s) => s.status === 'failed') ?? o.steps.find((s) => s.status === 'needs-owner') ?? null
  );
}

/** A log line short enough for one line under the steps. */
export function shortLine(line: string, max = 140): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * What the install is doing now, in words, from one line of its output: a download by name and size, or uv's own
 * line. Null for a line that says nothing new (the install's record of a step, which the list already shows).
 */
export function nowLine(line: string): string | null {
  const flat = line.replace(/\s+/g, ' ').trim();
  if (!flat || /^\[(done|skipped|failed|needs-owner)\] /.test(flat)) return null;
  const url = flat.match(/^download (\S+)$/);
  if (url) {
    const u = url[1]!;
    const what = /comfyui/i.test(u)
      ? 'ComfyUI'
      : /astral-sh\/uv|\/uv-/i.test(u)
        ? 'uv'
        : (u.split('/').pop() ?? u);
    return `Downloading ${what}`;
  }
  const dl = flat.match(/^Downloading (\S+) \(([\d.]+)\s*([KMG]i?B)\)$/);
  if (dl) return `Downloading ${dl[1]}, ${dl[2]} ${dl[3]}`;
  return shortLine(flat);
}

/** Why a step stopped, when it's something a person can recognise and fix: no connection, a full disk, permissions. */
export type Cause = 'offline' | 'disk' | 'permission' | null;

export function cause(text: string): Cause {
  if (
    /fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|getaddrinfo|dns error|Failed to fetch|network is unreachable|error sending request|Could not connect|tcp connect error/i.test(
      text,
    )
  )
    return 'offline';
  if (/ENOSPC|No space left|os error 28|disk (is )?full|not enough space/i.test(text)) return 'disk';
  if (/EACCES|EPERM|Permission denied|Access is denied|os error 13/i.test(text)) return 'permission';
  return null;
}

/** A step's detail without its last sentence about the log, and that log's path, so each can be shown on its own. */
export function splitLog(detail: string): { text: string; log: string | null } {
  const m = detail.match(/^(.*?)\s*The (?:full )?log is(?: in)? (.+?)\.?$/s);
  return m ? { text: m[1]!.trim(), log: m[2]!.trim() } : { text: detail.trim(), log: null };
}

/** Time passed, as a clock: 0:07, 4:12, 1:02:09. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
