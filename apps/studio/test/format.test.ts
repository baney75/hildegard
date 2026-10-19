// SPDX-License-Identifier: AGPL-3.0-only
import type { Take } from '@hildegard/presets';
import { describe, expect, it } from 'vitest';
import { fromRequest, toRequest } from '../src/lib/draft.ts';
import { about, bytes, clock, duration, estimateMs, leftMs, ordinal, roman } from '../src/lib/format.ts';

describe('format', () => {
  it('numbers shots like folios', () => {
    expect([1, 4, 9, 14, 40, 1994].map(roman)).toEqual(['I', 'IV', 'IX', 'XIV', 'XL', 'MCMXCIV']);
  });
  it('writes ordinals, teens included', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101, 111].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '101st',
      '111th',
    ]);
  });
  it('formats times and sizes', () => {
    expect(clock(5)).toBe('0:05');
    expect(clock(61.4)).toBe('1:01');
    expect(duration(38_000)).toBe('38 s');
    expect(duration(161_000)).toBe('2 min 41 s');
    expect(duration(3_840_000)).toBe('1 h 4 min');
    expect(about(2_000)).toBe('~5 s');
    expect(about(180_000)).toBe('~3 min');
    expect(bytes(28_528)).toBe('28 KB');
    expect(bytes(37.2e9)).toBe('35 GB');
  });
});

const take = (p: Partial<Take>): Take =>
  ({
    status: 'done',
    model: 'm',
    quality: 'draft',
    width: 960,
    height: 544,
    seconds: 5,
    fps: 24,
    renderMs: 10_000,
    ...p,
  }) as Take;

describe('estimates', () => {
  it('says nothing until there is history to go on', () => {
    expect(
      estimateMs([], { model: 'm', quality: 'draft', width: 960, height: 544, seconds: 5, fps: 24 }),
    ).toBeNull();
  });
  it('scales past renders by frames and pixels, per model and quality', () => {
    const done = [
      take({}),
      take({ model: 'other', renderMs: 99_999 }),
      take({ quality: 'final', renderMs: 99_999 }),
    ];
    expect(
      estimateMs(done, { model: 'm', quality: 'draft', width: 960, height: 544, seconds: 10, fps: 24 }),
    ).toBe(20_000);
  });
  it('switches to the take’s own pace once it is under way', () => {
    const now = Date.parse('2026-10-19T12:00:10Z');
    const running = take({
      status: 'running',
      startedAt: '2026-10-19T12:00:00Z',
      progress: { value: 0.5, step: 4, steps: 8 },
    });
    expect(leftMs(running, 60_000, now)).toBe(10_000);
    expect(leftMs({ ...running, progress: { value: 0.05, step: 0, steps: 8 } }, 60_000, now)).toBe(50_000);
    expect(leftMs({ ...running, progress: null }, null, now)).toBeNull();
  });
});

describe('draft', () => {
  it('round-trips through a request, so Reuse brings back exactly what was made', () => {
    const d = {
      prompt: '  Mara walks the rows  ',
      rig: { body: 'vintage-16mm', lens: 'anamorphic', focal: 50, aperture: 2.8 },
      motion: [{ id: 'crane-up', strength: 0.6 }],
      look: { light: 'golden-hour' },
      format: { aspect: '2.39:1', seconds: 5, quality: 'draft' as const },
      model: 'm',
      seed: 7,
      takes: 2,
      startFrame: null,
    };
    const r = toRequest(d as never, 'm');
    expect(r.prompt).toBe('Mara walks the rows');
    expect(fromRequest(r)).toMatchObject({ ...d, prompt: 'Mara walks the rows' });
    expect(fromRequest(r, 9).seed).toBe(9);
  });
});
