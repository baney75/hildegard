// SPDX-License-Identifier: AGPL-3.0-only
import { type RefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react';

export type WindowClass = 'compact' | 'medium' | 'expanded' | 'wide';
export type LayoutMode = 'auto' | 'desktop' | 'tablet' | 'phone';
const BP = { medium: 600, expanded: 840, wide: 1280 };
export const windowClass = (w: number): WindowClass =>
  w >= BP.wide ? 'wide' : w >= BP.expanded ? 'expanded' : w >= BP.medium ? 'medium' : 'compact';

/** The design system's window classes, measured on the space the app may fill. */
export function useWindowClass(
  ref: RefObject<HTMLElement | null>,
  mode: LayoutMode,
): { wc: WindowClass; forced: boolean } {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  useLayoutEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  const natural = windowClass(width);
  const wc =
    mode === 'auto'
      ? natural
      : mode === 'desktop'
        ? natural === 'wide'
          ? 'wide'
          : 'expanded'
        : mode === 'tablet'
          ? 'medium'
          : 'compact';
  return { wc, forced: mode !== 'auto' && wc !== natural };
}

const readHash = () => window.location.hash.replace(/^#/, '') || '/';

export function useHashRoute(): [string, (to: string) => void] {
  const read = readHash;
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((to: string) => {
    if (read() !== to) window.location.hash = to;
  }, []);
  return [route, go];
}

/** localStorage, but never throws: private windows and blocked storage just forget on reload. */
export function useLocal<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (v: T | ((p: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {}
        return next;
      });
    },
    [key],
  );
  return [value, update];
}

/** A clock that ticks while something is running, for countdowns. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function usePrefersReducedMotion(): boolean {
  const [r, setR] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return;
    const on = () => setR(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return r;
}
