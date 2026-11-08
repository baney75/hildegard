// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ttlMemo } from '../src/memo.ts';

afterEach(() => vi.useRealTimers());

describe('ttlMemo', () => {
  it('with no time, shares only an answer still being worked out', async () => {
    let release!: (n: number) => void;
    const ask = vi
      .fn<() => Promise<number>>()
      .mockImplementationOnce(() => new Promise<number>((r) => (release = r)))
      .mockResolvedValue(2);
    const get = ttlMemo(0, ask);
    const [a, b] = [get(), get()];
    release(1);
    expect(await a).toBe(await b);
    await get();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('runs the question once for callers that arrive within the time, even at the same moment', async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => ({ n: ask.mock.calls.length }));
    const get = ttlMemo(3000, ask);
    const [a, b] = await Promise.all([get(), get()]);
    expect(a).toBe(b);
    vi.advanceTimersByTime(2999);
    await get();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks again once the time is up', async () => {
    vi.useFakeTimers();
    const ask = vi.fn(async () => 1);
    const get = ttlMemo(3000, ask);
    await get();
    vi.advanceTimersByTime(3000);
    await get();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('forgets on bust, so a change shows at once', async () => {
    const ask = vi.fn(async () => 1);
    const get = ttlMemo(60_000, ask);
    await get();
    get.bust();
    await get();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('never keeps a failure', async () => {
    const ask = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('nope')).mockResolvedValue(2);
    const get = ttlMemo(60_000, ask);
    await expect(get()).rejects.toThrow('nope');
    await expect(get()).resolves.toBe(2);
    expect(ask).toHaveBeenCalledTimes(2);
  });
});
