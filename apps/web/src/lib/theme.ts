import { darkTheme, lightTheme, themeCss } from '@ops/shared';

/**
 * Light and dark mode of the dashboard. `system` (the default) follows the computer or browser
 * setting and switches live when it changes; `light` and `dark` override it. The choice is a
 * per-browser convenience kept in localStorage (never sent to the API) and applied as
 * `data-theme` on <html>, before the first paint by {@link THEME_INIT_SCRIPT}.
 */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** The order of the choices in the account menu. */
export const THEME_MENU_ORDER: readonly ThemePreference[] = ['system', 'dark', 'light'];

export const THEME_STORAGE_KEY = 'hz.theme';

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/**
 * The stylesheet of both themes: dark by default; light when the device prefers light and the
 * user did not choose dark; light when the user chose light.
 */
export function themeStylesheet(): string {
  return (
    themeCss(darkTheme, ':root') +
    `@media (prefers-color-scheme: light) {\n${themeCss(lightTheme, ':root:not([data-theme="dark"])')}}\n` +
    themeCss(lightTheme, ':root[data-theme="light"]')
  );
}

/** Runs before the first paint, so a chosen theme never flashes the other one. */
export const THEME_INIT_SCRIPT =
  `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');` +
  `if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}`;

/** The choice in force in this page (set when blocked storage cannot remember it). */
let current: ThemePreference | null = null;

export function readThemePreference(): ThemePreference {
  if (current !== null) return current;
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

const listeners = new Set<() => void>();

/** For `useSyncExternalStore`: told when the choice changes in this page. */
export function subscribeThemePreference(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Applies the choice at once and remembers it in this browser. */
export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === 'system') {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }
  try {
    if (preference === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Private mode or blocked storage: the choice still applies to this page.
  }
  current = preference;
  listeners.forEach((listener) => listener());
}
