// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  blocker,
  cause,
  clock,
  nowLine,
  PLAN,
  progress,
  report,
  type Step,
  shortLine,
  splitLog,
} from '../ui/model.ts';

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
    expect([later.done, later.total]).toEqual([3, PLAN.length]);
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

  it('says what the install is doing now, in words', () => {
    expect(
      nowLine('download https://github.com/comfyanonymous/ComfyUI/archive/refs/tags/v0.42.1.tar.gz'),
    ).toBe('Downloading ComfyUI');
    expect(
      nowLine('download https://github.com/astral-sh/uv/releases/download/0.13.2/uv-x86_64.tar.gz'),
    ).toBe('Downloading uv');
    expect(nowLine('download https://example.com/files/thing.zip')).toBe('Downloading thing.zip');
    expect(nowLine('Downloading torch (846.3MiB)')).toBe('Downloading torch, 846.3 MiB');
    expect(nowLine('Resolved 61 packages in 1.82s')).toBe('Resolved 61 packages in 1.82s');
    // The install's record of a step is already in the list.
    expect(nowLine('[done] Get uv: Installed uv 0.13.2.')).toBeNull();
    expect(nowLine('   ')).toBeNull();
  });

  it('recognises a lost connection, a full disk and permissions', () => {
    expect(cause('fetch failed: getaddrinfo ENOTFOUND github.com')).toBe('offline');
    expect(cause('error sending request for url (https://pypi.org/simple/torch/)')).toBe('offline');
    expect(cause('No space left on device (os error 28)')).toBe('disk');
    expect(cause("EACCES: permission denied, mkdir '/opt/x'")).toBe('permission');
    expect(cause('PyTorch can’t use the GPU.')).toBeNull();
  });

  it('takes the log’s path out of a step’s detail', () => {
    expect(splitLog('It broke. The full log is in /home/ann/logs/install.log.')).toEqual({
      text: 'It broke.',
      log: '/home/ann/logs/install.log',
    });
    expect(splitLog('It didn’t start. The log is C:\\Users\\ann\\server.log.')).toEqual({
      text: 'It didn’t start.',
      log: 'C:\\Users\\ann\\server.log',
    });
    expect(splitLog('Nothing about logs.')).toEqual({ text: 'Nothing about logs.', log: null });
  });

  it('shows time passed as a clock', () => {
    expect(clock(7_400)).toBe('0:07');
    expect(clock(252_000)).toBe('4:12');
    expect(clock(3_729_000)).toBe('1:02:09');
    expect(clock(-5)).toBe('0:00');
  });
});
