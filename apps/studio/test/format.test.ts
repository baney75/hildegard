// SPDX-License-Identifier: AGPL-3.0-only
import type { EngineState, GuestTake, Take } from '@hildegard/presets';
import { describe, expect, it } from 'vitest';
import { draftNote } from '../src/components/ExportDialog.tsx';
import { fromRequest, toRequest } from '../src/lib/draft.ts';
import {
  about,
  bytes,
  clock,
  comfyDown,
  deviceLabel,
  duration,
  estimateMs,
  guestFrom,
  guestLine,
  leftMs,
  ordinal,
  roman,
} from '../src/lib/format.ts';

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
    // Past the last step only decoding is left, which reports nothing to estimate from.
    expect(leftMs({ ...running, progress: { value: 1, step: 8, steps: 8 } }, 60_000, now)).toBeNull();
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

describe('draftNote', () => {
  const take = (quality: 'draft' | 'final') => ({ quality });
  it('says which shots are drafts when a film mixes them with final takes', () => {
    expect(
      draftNote([
        { no: 1, take: take('final') },
        { no: 2, take: take('draft') },
      ]),
    ).toBe('Shot II is a draft, so it’ll look softer than the rest. Render it at Final to match. ');
    expect(
      draftNote([
        { no: 1, take: take('draft') },
        { no: 2, take: take('final') },
        { no: 3, take: take('draft') },
      ]),
    ).toMatch(/^Shots I, III are drafts, so they’ll look softer/);
  });
  it('says nothing when every take is the same quality', () => {
    expect(
      draftNote([
        { no: 1, take: take('draft') },
        { no: 2, take: take('draft') },
      ]),
    ).toBe('');
    expect(draftNote([{ no: 1, take: take('final') }])).toBe('');
  });
});

describe('render device', () => {
  const engine = (over: Partial<EngineState>): EngineState => ({
    online: true,
    url: 'http://127.0.0.1:8189',
    fake: false,
    paused: false,
    device: 'This computer',
    comfy: 'managed',
    problem: null,
    ...over,
  });
  it('names the device takes render on, another one included', () => {
    expect(deviceLabel(engine({}))).toBe('This computer');
    expect(deviceLabel(engine({ fake: true }))).toBe('Stand-in GPU');
    const remote = engine({ comfy: 'remote', device: 'parish1 · RTX 4080 Laptop', fake: true });
    expect(deviceLabel(remote)).toBe('parish1 · RTX 4080 Laptop');
    const down = comfyDown({ ...remote, online: false, problem: 'parish1 isn’t answering.' });
    expect(down.short).toBe('parish1 isn’t answering');
    expect(down.long).toMatch(/^parish1 isn’t answering\. Takes wait/);
  });
});

describe('renders from paired devices', () => {
  const g: GuestTake = {
    id: 'g1',
    from: 'rectory1',
    status: 'running',
    queuePosition: 0,
    progress: 0.416,
    quality: 'draft',
    createdAt: '2026-10-23T12:00:00.000Z',
  };
  it('say who sent them and how far along they are', () => {
    expect(guestLine(g)).toBe('From rectory1 · rendering · 42%');
    expect(guestLine({ ...g, progress: null })).toBe('From rectory1 · rendering');
    expect(guestLine({ ...g, progress: 1 })).toBe('From rectory1 · rendering · finishing');
    expect(guestLine({ ...g, status: 'queued', queuePosition: 1, progress: null })).toBe(
      'From rectory1 · waiting · up next',
    );
    expect(guestLine({ ...g, status: 'queued', queuePosition: 3, progress: null })).toBe(
      'From rectory1 · waiting · 3rd in line',
    );
    expect(guestFrom({ ...g, from: null })).toBe('From another device');
  });
});
