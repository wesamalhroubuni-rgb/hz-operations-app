import {
  LANGUAGE_STORAGE_KEY,
  loadLanguagePreference,
  parseLanguagePreference,
  saveLanguagePreference,
} from './languagePreference';

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => Promise.resolve(data.get(key) ?? null),
    setItem: (key: string, value: string) => Promise.resolve(void data.set(key, value)),
    removeItem: (key: string) => Promise.resolve(void data.delete(key)),
  };
}

describe('language preference', () => {
  it('keeps only known choices; anything else follows the phone', () => {
    expect(parseLanguagePreference('tr')).toBe('tr');
    expect(parseLanguagePreference('ar')).toBe('ar');
    expect(parseLanguagePreference('de')).toBe('system');
    expect(parseLanguagePreference(undefined)).toBe('system');
  });

  it('remembers a language and forgets it for "system"', async () => {
    const store = memoryStore();
    await saveLanguagePreference(store, 'ar');
    expect(store.data.get(LANGUAGE_STORAGE_KEY)).toBe('ar');
    expect(await loadLanguagePreference(store)).toBe('ar');
    await saveLanguagePreference(store, 'system');
    expect(store.data.has(LANGUAGE_STORAGE_KEY)).toBe(false);
  });

  it('falls back to "system" when the storage fails', async () => {
    const broken = { ...memoryStore(), getItem: () => Promise.reject(new Error('no storage')) };
    expect(await loadLanguagePreference(broken)).toBe('system');
  });
});
