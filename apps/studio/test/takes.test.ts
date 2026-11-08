// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
vi.mock('../src/lib/api.ts', () => ({
  api: {
    createShot: async (body: unknown) => {
      sent.push(body);
      return { shot: { id: 's1' }, takes: [{ id: 't2' }] };
    },
  },
}));
vi.mock('../src/lib/store.ts', () => ({ upsert: () => {} }));

const { takeAgain } = await import('../src/lib/takes.ts');

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
