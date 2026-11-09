// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { page } from '../src/lib/pages.ts';

describe('a page whose code fails to load', () => {
  it('throws the same error on every render, never a new wait', async () => {
    let calls = 0;
    const gone = new TypeError('Failed to fetch dynamically imported module: /assets/Queue-abc.js');
    // A function component, called the way React calls it.
    const Page = page<object>(() => {
      calls++;
      return Promise.reject(gone);
    }) as (props: object) => unknown;
    let waited: unknown;
    try {
      Page({});
    } catch (e) {
      waited = e;
    }
    expect(waited).toBeInstanceOf(Promise);
    await waited;
    // React renders an errored component again before it reaches the boundary: both renders must throw the error.
    expect(() => Page({})).toThrow(gone);
    expect(() => Page({})).toThrow(gone);
    expect(calls).toBe(1);
  });
});
