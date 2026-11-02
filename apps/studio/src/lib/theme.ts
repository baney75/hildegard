// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useSyncExternalStore } from 'react';
import {
  applyTheme,
  listeners,
  readAccent,
  readPreset,
  readThemeMode,
  type Theme,
  type ThemeMode,
} from './theme-core.ts';

export * from './theme-core.ts';

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The chosen mode, preset and accent, and the theme on screen now; follows the device while the mode is system. */
export function useTheme(): { mode: ThemeMode; theme: Theme; preset: string; accent: string | null } {
  const mode = useSyncExternalStore(subscribe, readThemeMode);
  const preset = useSyncExternalStore(subscribe, readPreset);
  const accent = useSyncExternalStore(subscribe, readAccent);
  const theme = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.dataset.theme as Theme) ?? 'dark',
  );
  useEffect(() => {
    if (mode !== 'system') return;
    const m = window.matchMedia?.('(prefers-color-scheme: light)');
    if (!m) return;
    const on = () => {
      applyTheme();
      for (const l of listeners) l();
    };
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [mode]);
  return { mode, theme, preset, accent };
}
