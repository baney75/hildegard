// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** The nearest ancestor that scrolls, or the page. */
function scroller(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const o = getComputedStyle(p).overflowY;
    if (o === 'auto' || o === 'scroll') return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** Past this many rows, only the ones on screen (and a few either side) are in the page. */
export const WINDOW_AT = 60;
/** Rows drawn beyond the screen each way, and how close to the edge of those the screen may come before more are drawn. */
const OVERSCAN = 12;
const EDGE = 4;
const FIRST = 30;

export type Range = [start: number, end: number];

/**
 * The rows to draw. `from` is how far the top of the screen is below the top of the list, `view` the screen's height,
 * `pitch` one row and its gap. The drawn rows stay as they are until the screen comes within EDGE rows of their end,
 * so scrolling inside them touches nothing; then a new range is made, with OVERSCAN rows either side of the screen.
 */
export function nextRange(old: Range, from: number, view: number, pitch: number, n: number): Range {
  if (n <= 0) return old[0] === 0 && old[1] === 0 ? old : [0, 0];
  // The screen may be above the list or past its end (another group is on screen): hold on to the nearest rows, so
  // there is always at least one row to measure and the range comes back when the screen does.
  const seenFrom = Math.min(n - 1, Math.max(0, Math.floor(from / pitch)));
  const seenTo = Math.max(seenFrom + 1, Math.min(n, Math.ceil((from + view) / pitch)));
  const valid = old[0] < old[1] && old[1] <= n;
  const lowOk = old[0] === 0 || seenFrom >= old[0] + EDGE;
  const highOk = old[1] === n || seenTo <= old[1] - EDGE;
  if (valid && lowOk && highOk) return old;
  return [Math.max(0, seenFrom - OVERSCAN), Math.min(n, seenTo + OVERSCAN)];
}

/**
 * A long list of rows of one height, with only the rows near the screen in the page. The rest are one block of space
 * above and below, so the scrollbar and scroll position are what the whole list would give. A short list is drawn
 * whole, exactly as before. `className` is the list's own (a column with a gap): rows keep their place in it.
 */
export function WindowedRows({ rows, className }: { rows: ReactNode[]; className?: string }) {
  const list = useRef<HTMLDivElement>(null);
  const n = rows.length;
  const windowed = n > WINDOW_AT;
  const [range, setRange] = useState<Range>([0, Math.min(n, FIRST)]);
  // Space for the rows that are not drawn: set from what the drawn ones measure.
  const [pitch, setPitch] = useState(0);
  const lastPitch = useRef(0);

  useLayoutEffect(() => {
    const el = list.current;
    if (!windowed || !el) return;
    const sp = scroller(el);
    let frame = 0;
    const measure = () => {
      frame = 0;
      const drawn = el.children.length;
      const cs = getComputedStyle(el);
      const gap = Number.parseFloat(cs.rowGap) || 0;
      const space = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
      // One row and its gap, from the rows drawn now, or the last measure when none are drawn (the list shrank).
      const p = drawn ? (el.getBoundingClientRect().height - space + gap) / drawn : lastPitch.current;
      if (!(p > 0)) {
        setRange((old) => (old[0] < old[1] && old[1] <= n ? old : [0, Math.min(n, FIRST)]));
        return;
      }
      lastPitch.current = p;
      const top = el.getBoundingClientRect().top - sp.getBoundingClientRect().top + sp.scrollTop;
      const from = sp.scrollTop - top;
      setPitch((old) => (Math.abs(old - p) > 0.5 ? p : old));
      setRange((old) => nextRange(old, from, sp.clientHeight, p, n));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    const scrollTarget = sp === document.scrollingElement ? window : sp;
    scrollTarget.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(sp);
    return () => {
      scrollTarget.removeEventListener('scroll', schedule);
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [windowed, n]);

  if (!windowed) return <div className={className}>{rows}</div>;
  const start = Math.min(range[0], n);
  const end = Math.min(Math.max(range[1], start), n);
  return (
    <div
      ref={list}
      className={className}
      style={{ paddingTop: start * pitch, paddingBottom: (n - end) * pitch }}
    >
      {rows.slice(start, end)}
    </div>
  );
}

/**
 * How many of a long grid to draw: the first screens at once, and more as the person scrolls toward the end. Give the
 * sentinel to an element after the grid. The grid itself is a plain CSS grid, so its columns and gaps are untouched.
 */
export function useReveal(
  total: number,
  step = 48,
): { count: number; sentinel: (el: HTMLElement | null) => void } {
  const [count, setCount] = useState(step);
  const [node, setNode] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!node || count >= total) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setCount((c) => c + step);
      },
      // Start drawing a couple of screens before the end is reached.
      { rootMargin: '1200px 0px' },
    );
    io.observe(node);
    return () => io.disconnect();
  }, [node, count, total, step]);
  return { count: Math.min(count, total), sentinel: setNode };
}
