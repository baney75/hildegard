// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { nextRange, WINDOW_AT } from '../src/components/Windowed.tsx';

const PITCH = 70;
const VIEW = 900;

describe('nextRange', () => {
  it('draws the rows on screen with a margin, from the top', () => {
    const [start, end] = nextRange([0, 0], 0, VIEW, PITCH, 500);
    expect(start).toBe(0);
    // 900 / 70 is about 13 rows on screen, and a dozen more below.
    expect(end).toBeGreaterThanOrEqual(13 + 12);
    expect(end).toBeLessThan(40);
  });

  it('never draws every row of a long list', () => {
    const [start, end] = nextRange([0, 30], 250 * PITCH, VIEW, PITCH, 500);
    expect(end - start).toBeLessThan(60);
    expect(start).toBeGreaterThan(200);
    expect(end).toBeLessThan(300);
  });

  it('keeps the range while the screen moves inside it', () => {
    const range: [number, number] = [100, 140];
    expect(nextRange(range, 110 * PITCH, VIEW, PITCH, 500)).toBe(range);
    expect(nextRange(range, 112 * PITCH, VIEW, PITCH, 500)).toBe(range);
  });

  it('moves the range when the screen nears either edge', () => {
    const range: [number, number] = [100, 140];
    expect(nextRange(range, 126 * PITCH, VIEW, PITCH, 500)).not.toBe(range);
    expect(nextRange(range, 101 * PITCH, VIEW, PITCH, 500)).not.toBe(range);
  });

  it('stops at the ends of the list', () => {
    const [, end] = nextRange([0, 30], 10_000 * PITCH, VIEW, PITCH, 500);
    expect(end).toBe(500);
    expect(nextRange([480, 500], 495 * PITCH, VIEW, PITCH, 500)[1]).toBe(500);
  });

  it('draws a short list whole, by leaving it to the component', () => {
    expect(WINDOW_AT).toBeGreaterThanOrEqual(40);
  });
});
