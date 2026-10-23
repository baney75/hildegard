// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { blocker, PLAN, progress, report, type Step, shortLine } from '../ui/model.ts';

const step = (id: string, status: Step['status'], extra: Partial<Step> = {}): Step => ({
  id,
  title: PLAN.find((p) => p.id === id)?.title ?? id,
  status,
  detail: '',
  ...extra,
});

describe('install progress', () => {
  it('shows every step before it runs, and the one running now', () => {
    const p = progress([]);
    expect(p.rows.map((r) => r.id)).toEqual(PLAN.map((s) => s.id));
    expect(p.rows.every((r) => r.status === null)).toBe(true);
    expect(p.current).toBe('app');
    expect(p.fraction).toBe(0);

    const later = progress([step('app', 'done'), step('gpu', 'done'), step('uv', 'skipped')]);
    expect(later.current).toBe('comfyui');
    expect(later.fraction).toBeCloseTo(3 / PLAN.length);
  });

  it('puts steps it didn’t plan for after the one reported before them', () => {
    const p = progress([
      step('app', 'done'),
      step('command', 'done', { title: 'Add the hildegard command' }),
    ]);
    expect(p.rows.slice(0, 3).map((r) => r.id)).toEqual(['app', 'command', 'gpu']);
    expect(p.current).toBe('gpu');
  });

  it('stops pointing at a step once one fails or needs the owner', () => {
    const p = progress([step('app', 'done'), step('gpu', 'needs-owner', { command: 'nvidia-smi' })]);
    expect(p.current).toBeNull();
    expect(p.rows.find((r) => r.id === 'gpu')).toMatchObject({
      status: 'needs-owner',
      command: 'nvidia-smi',
    });
  });

  it('replaces a step reported again', () => {
    const steps = report(report([], step('start', 'failed')), step('start', 'done'));
    expect(steps).toEqual([step('start', 'done')]);
  });

  it('names what failed before what only the owner can do', () => {
    const o = {
      ok: false,
      needsOwner: true,
      message: '',
      steps: [step('check', 'needs-owner'), step('packages', 'failed')],
    };
    expect(blocker(o)?.id).toBe('packages');
    expect(blocker({ ...o, steps: [step('check', 'needs-owner')] })?.id).toBe('check');
    expect(blocker({ ...o, steps: [step('check', 'done')] })).toBeNull();
  });

  it('keeps log lines to one short line', () => {
    expect(shortLine('  Downloading\n torch  ')).toBe('Downloading torch');
    expect(shortLine('x'.repeat(300), 20)).toHaveLength(20);
  });
});
