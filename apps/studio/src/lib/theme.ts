// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useSyncExternalStore } from 'react';

/** Dark is the default; light is warm vellum; system follows this device. */
export type ThemeMode = 'dark' | 'light' | 'system';
export type Theme = 'dark' | 'light';

const KEY = 'hildegard.theme';
const listeners = new Set<() => void>();

export function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'system' ? v : 'dark';
  } catch {
    return 'dark';
  }
}

const systemLight = () => window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;

export const resolveTheme = (mode: ThemeMode, light = systemLight()): Theme =>
  mode === 'system' ? (light ? 'light' : 'dark') : mode;

/** Put the theme on <html>, with the browser's own colour scheme and bar colour to match. */
export function applyTheme(mode: ThemeMode = readThemeMode()): Theme {
  const theme = resolveTheme(mode);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f4eedd' : '#0a0e13');
  return theme;
}

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
  applyTheme(mode);
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The chosen mode and the theme on screen now; follows the device while the mode is system. */
export function useTheme(): { mode: ThemeMode; theme: Theme } {
  const mode = useSyncExternalStore(subscribe, readThemeMode);
  const theme = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme as Theme) ?? 'dark',
  );
  useEffect(() => {
    if (mode !== 'system') return;
    const m = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!m) return;
    const on = () => {
      applyTheme('system');
      for (const l of listeners) l();
    };
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [mode]);
  return { mode, theme };
}
