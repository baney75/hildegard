// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { nextRange, offsetInto, WINDOW_AT } from '../src/components/Windowed.tsx';

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

  it('keeps rows to measure when the screen is past the end or above the list', () => {
    // Another group below is on screen: the last rows stay drawn.
    const below = nextRange([100, 140], 900 * PITCH, VIEW, PITCH, 500);
    expect(below[1]).toBe(500);
    expect(below[0]).toBeLessThan(below[1]);
    // A group above is on screen: the first rows stay drawn.
    const above = nextRange([100, 140], -50 * PITCH, VIEW, PITCH, 500);
    expect(above[0]).toBe(0);
    expect(above[1]).toBeGreaterThan(0);
  });

  it('remakes a range the list shrank under', () => {
    // Scrolled near the end of 500 rows, then a filter leaves 200: the screen is past them.
    const r = nextRange([470, 500], 480 * PITCH, VIEW, PITCH, 200);
    expect(r[1]).toBe(200);
    expect(r[0]).toBeLessThan(r[1]);
    // Still on screen, but the old range ran past the new end.
    const s = nextRange([150, 220], 160 * PITCH, VIEW, PITCH, 200);
    expect(s[1]).toBeLessThanOrEqual(200);
    expect(s[0]).toBeLessThan(s[1]);
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

describe('offsetInto', () => {
  it('counts a page scroll once', () => {
    // The page scrolled 3,000 px and the list starts 200 px down it: its top is at -2,800 on screen, and so is the
    // page's own box, but the visible area still starts at 0.
    expect(offsetInto(-2800, -3000, true)).toBe(2800);
  });

  it('measures from the top of a scrolling panel', () => {
    // A panel 64 px down the window; the list's top has scrolled to 500 px above the panel's top.
    expect(offsetInto(64 - 500, 64, false)).toBe(500);
  });
});
