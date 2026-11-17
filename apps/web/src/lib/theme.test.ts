import { darkTheme, lightTheme } from '@ops/shared';
import { describe, expect, it } from 'vitest';

import { parseThemePreference, THEME_INIT_SCRIPT, themeStylesheet } from '@/lib/theme';

describe('dashboard theme', () => {
  it('accepts light and dark, and treats anything else as automatic', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    for (const value of ['system', null, undefined, 'blue', 1]) {
      expect(parseThemePreference(value)).toBe('system');
    }
  });

  it('is dark by default, follows a light device unless dark is chosen, and obeys light', () => {
    const css = themeStylesheet();
    expect(css).toContain(`:root {\n  color-scheme: dark;`);
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain(':root:not([data-theme="dark"]) {\n  color-scheme: light;');
    expect(css).toContain(':root[data-theme="light"] {\n  color-scheme: light;');
    expect(css).toContain(`--color-background: ${darkTheme.colors.background};`);
    expect(css).toContain(`--color-background: ${lightTheme.colors.background};`);
  });

  it('applies only a stored light or dark choice before the first paint', () => {
    const root = { dataset: {} as Record<string, string> };
    const run = (stored: string | null) => {
      root.dataset = {};
      new Function('localStorage', 'document', THEME_INIT_SCRIPT)(
        { getItem: () => stored },
        { documentElement: root },
      );
      return root.dataset.theme;
    };
    expect(run('dark')).toBe('dark');
    expect(run('light')).toBe('light');
    expect(run('evil<script>')).toBeUndefined();
    expect(run(null)).toBeUndefined();
  });
});
