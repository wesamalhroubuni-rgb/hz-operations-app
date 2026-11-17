import { darkTheme, lightTheme } from '@ops/shared';

import { createMemoryStore, type KeyValueStore } from '../storage/keyValueStore';
import {
  loadThemePreference,
  parseThemePreference,
  resolveScheme,
  resolveTheme,
  saveThemePreference,
  THEME_MENU_ORDER,
  THEME_STORAGE_KEY,
} from './themePreference';

function brokenStore(): KeyValueStore {
  const fail = () => Promise.reject(new Error('storage unavailable'));
  return { getItem: fail, setItem: fail, removeItem: fail };
}

describe('theme preference', () => {
  it('offers System, Dark, Light in the order of the web dashboard', () => {
    expect(THEME_MENU_ORDER).toEqual(['system', 'dark', 'light']);
  });

  it('parses a stored value, anything unknown is system', () => {
    expect(parseThemePreference('light')).toBe('light');
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('system')).toBe('system');
    expect(parseThemePreference(null)).toBe('system');
    expect(parseThemePreference('Light')).toBe('system');
    expect(parseThemePreference(42)).toBe('system');
  });

  it('System follows the phone, unknown counts as dark', () => {
    expect(resolveScheme('system', 'light')).toBe('light');
    expect(resolveScheme('system', 'dark')).toBe('dark');
    expect(resolveScheme('system', 'unspecified')).toBe('dark');
    expect(resolveScheme('system', null)).toBe('dark');
    expect(resolveScheme('system', undefined)).toBe('dark');
  });

  it('a manual choice wins over the phone', () => {
    expect(resolveScheme('light', 'dark')).toBe('light');
    expect(resolveScheme('dark', 'light')).toBe('dark');
    expect(resolveTheme('light', 'dark')).toBe(lightTheme);
    expect(resolveTheme('system', 'dark')).toBe(darkTheme);
    expect(resolveTheme('system', 'light').colors).toBe(lightTheme.colors);
  });

  it('remembers Dark and Light on the phone and forgets the key for System', async () => {
    const store = createMemoryStore();
    expect(await loadThemePreference(store)).toBe('system');

    expect(await saveThemePreference(store, 'light')).toBe(true);
    expect(store.dump()).toEqual({ [THEME_STORAGE_KEY]: 'light' });
    expect(await loadThemePreference(store)).toBe('light');

    await saveThemePreference(store, 'dark');
    expect(await loadThemePreference(store)).toBe('dark');

    await saveThemePreference(store, 'system');
    expect(store.dump()).toEqual({});
    expect(await loadThemePreference(store)).toBe('system');
  });

  it('a garbled stored value reads as system', async () => {
    const store = createMemoryStore({ [THEME_STORAGE_KEY]: 'sepia' });
    expect(await loadThemePreference(store)).toBe('system');
  });

  it('a storage failure never throws: System on read, false on write', async () => {
    const store = brokenStore();
    await expect(loadThemePreference(store)).resolves.toBe('system');
    await expect(saveThemePreference(store, 'light')).resolves.toBe(false);
    await expect(saveThemePreference(store, 'system')).resolves.toBe(false);
  });
});
