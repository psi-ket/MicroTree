import { useEffect, useSyncExternalStore } from 'react';
import type { ThemePreference } from '@research-studio/shared-types';
import { useConnection } from './connection';
import { useSettings } from './queries';
import { KEYS, local } from './storage';

const media = () => window.matchMedia('(prefers-color-scheme: dark)');

function useSystemDark(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = media();
      m.addEventListener('change', cb);
      return () => m.removeEventListener('change', cb);
    },
    () => media().matches,
  );
}

function cachedPreference(): ThemePreference {
  const v = local.get(KEYS.theme);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

/** Theme preference: runtime settings when connected, otherwise the cached choice. */
export function useThemePreference(): ThemePreference {
  const connected = useConnection((s) => s.status === 'connected');
  const settings = useSettings();
  return connected ? settings.theme : cachedPreference();
}

export function useResolvedTheme(): 'light' | 'dark' {
  const preference = useThemePreference();
  const systemDark = useSystemDark();
  return preference === 'dark' || (preference === 'system' && systemDark) ? 'dark' : 'light';
}

/** Applies the resolved theme to <html> and caches the preference for the next page load. */
export function useApplyTheme(): void {
  const preference = useThemePreference();
  const resolved = useResolvedTheme();
  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark');
    local.set(KEYS.theme, preference);
  }, [resolved, preference]);
}
