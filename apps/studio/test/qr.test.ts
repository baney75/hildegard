// SPDX-License-Identifier: AGPL-3.0-only
import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { qrPath } from '../src/components/Qr.tsx';

// Paints the path's rectangles back onto a grid: what a phone's camera would see.
function paint(d: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = x; i < x + w; i++) grid[y]![i] = true;
  }
  return grid;
}

describe('qrPath', () => {
  it('draws exactly the dark modules of the code, quiet zone included', () => {
    for (const url of [
      'https://parish1.tail2b1ef8.ts.net/',
      `https://studio.example.ts.net/#/invite/${'A'.repeat(43)}`,
    ]) {
      const { d, size } = qrPath(url);
      const want = encode(url, { ecc: 'M', border: 3 });
      expect(size).toBe(want.size);
      expect(paint(d, size)).toEqual(want.data);
      // The quiet zone is light all the way round, so a camera can find the code.
      expect(want.data[0]!.some(Boolean)).toBe(false);
      expect(want.data.at(-1)!.some(Boolean)).toBe(false);
    }
  });
});
