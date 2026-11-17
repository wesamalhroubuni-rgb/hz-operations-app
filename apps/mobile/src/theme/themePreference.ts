import { themeForScheme, type Theme } from '@ops/shared';

import type { KeyValueStore } from '../storage/keyValueStore';

/**
 * Light and dark mode of the app. `system` (the default) follows the phone's setting and switches
 * live when it changes; `light` and `dark` override it. The choice is a device preference kept in
 * AsyncStorage (not per user, never sent to the API), like the web dashboard's per-browser choice.
 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The order of the choices in Profile: the same as the web dashboard's account menu. */
export const THEME_MENU_ORDER: readonly ThemePreference[] = ['system', 'dark', 'light'];

export const THEME_STORAGE_KEY = 'ops.theme';

/** What the phone reports (`useColorScheme()`); anything but light or dark counts as unknown. */
export type DeviceScheme = 'light' | 'dark' | 'unspecified' | null | undefined;

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** The scheme in force: the choice, or the phone's setting for `system` (unknown = dark). */
export function resolveScheme(preference: ThemePreference, device: DeviceScheme): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return device === 'light' ? 'light' : 'dark';
}

export function resolveTheme(preference: ThemePreference, device: DeviceScheme): Theme {
  return themeForScheme(resolveScheme(preference, device));
}

/** The remembered choice; `system` when none is stored or the storage cannot be read. */
export async function loadThemePreference(store: KeyValueStore): Promise<ThemePreference> {
  try {
    return parseThemePreference(await store.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/**
 * Remembers the choice on this phone (`system` removes the key). A storage failure is swallowed:
 * the choice still applies until the app is closed.
 */
export async function saveThemePreference(
  store: KeyValueStore,
  preference: ThemePreference,
): Promise<boolean> {
  try {
    if (preference === 'system') {
      await store.removeItem(THEME_STORAGE_KEY);
    } else {
      await store.setItem(THEME_STORAGE_KEY, preference);
    }
    return true;
  } catch {
    return false;
  }
}
