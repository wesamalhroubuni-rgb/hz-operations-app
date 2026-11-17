import type { KeyValueStore } from '../storage/keyValueStore';

/**
 * The app's language choice: `system` (the default) follows the phone's language; `en`, `tr`
 * and `ar` override it. A device preference kept in AsyncStorage, like the theme (not per user,
 * never sent to the API).
 */
export const LANGUAGE_PREFERENCES = ['system', 'en', 'tr', 'ar'] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

export const LANGUAGE_STORAGE_KEY = 'ops.language';

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return value === 'en' || value === 'tr' || value === 'ar' ? value : 'system';
}

/** The remembered choice; `system` when none is stored or the storage cannot be read. */
export async function loadLanguagePreference(store: KeyValueStore): Promise<LanguagePreference> {
  try {
    return parseLanguagePreference(await store.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

/** Remembers the choice on this phone (`system` removes the key). Failures are swallowed. */
export async function saveLanguagePreference(
  store: KeyValueStore,
  preference: LanguagePreference,
): Promise<boolean> {
  try {
    if (preference === 'system') {
      await store.removeItem(LANGUAGE_STORAGE_KEY);
    } else {
      await store.setItem(LANGUAGE_STORAGE_KEY, preference);
    }
    return true;
  } catch {
    return false;
  }
}
