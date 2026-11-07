// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { isChunkError } from '../src/components/PageGate.tsx';

describe('isChunkError', () => {
  it('knows each browser’s words for a page chunk that is gone', () => {
    expect(
      isChunkError(new TypeError('Failed to fetch dynamically imported module: /assets/Queue-abc.js')),
    ).toBe(true);
    expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkError(new Error('Unable to preload CSS for /assets/Queue-abc.css'))).toBe(true);
  });

  it('leaves a page’s own bugs alone', () => {
    expect(isChunkError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkError('nope')).toBe(false);
  });
});
