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
  { id: 'film-look', title: 'Add the film look' },
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
