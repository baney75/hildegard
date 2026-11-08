// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
const keeps: Record<string, boolean> = {};
vi.mock('../src/lib/api.ts', () => ({
  api: {
    keep: async (id: string, kept: boolean) => {
      keeps[id] = kept;
      return { id, kept };
    },
    createShot: async (body: unknown) => {
      sent.push(body);
      return { shot: { id: 's1' }, takes: [{ id: 't2' }] };
    },
  },
}));
vi.mock('../src/lib/store.ts', () => ({ upsert: () => {} }));

const { keepOnly, takeAgain } = await import('../src/lib/takes.ts');

/** The shot's last take after a Finalize: a final one. */
const finalTake = {
  id: 't1',
  shotId: 's1',
  seed: 7,
  request: { prompt: 'a barn at dawn', takes: 1, format: { quality: 'final', seconds: 5 } },
} as unknown as Parameters<typeof takeAgain>[0];

const quality = () => (sent.at(-1) as { request: { format: { quality: string } } }).request.format.quality;

describe('another take', () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it('is a draft after a Finalize, so + Take and One more like this don’t render at final quality', async () => {
    await takeAgain(finalTake);
    expect(quality()).toBe('draft');
  });

  it('is final only when asked for', async () => {
    await takeAgain(finalTake, { seed: 7, quality: 'final' });
    expect(quality()).toBe('final');
  });
});

describe('keeping a take in Compare', () => {
  beforeEach(() => {
    for (const k of Object.keys(keeps)) delete keeps[k];
  });
  const take = (id: string, kept: boolean) =>
    ({ id, shotId: 's1', kept }) as unknown as Parameters<typeof takeAgain>[0];

  it('lets the shot’s other kept take go, so the film uses the one chosen, not the newer kept one', async () => {
    const [d1, d2] = [take('d1', false), take('d2', true)];
    await keepOnly(d1, [d1, d2]);
    expect(keeps).toEqual({ d1: true, d2: false });
  });

  it('leaves takes that were not kept alone', async () => {
    const [d1, d2, d3] = [take('d1', false), take('d2', false), take('d3', true)];
    await keepOnly(d2, [d1, d2, d3]);
    expect(keeps).toEqual({ d2: true, d3: false });
  });
});
