import { authTokensSchema, type AuthTokens, type TokenStorage } from '@ops/shared';
import * as SecureStore from 'expo-secure-store';

/** The one SecureStore entry of the app: the access and refresh token together, as JSON. */
export const TOKEN_STORAGE_KEY = 'ops.auth.tokens';

/** The part of expo-secure-store this module uses. Injected so the logic can be unit-tested. */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

/**
 * iOS: readable only while the device is unlocked, and never copied to another device through a
 * backup or iCloud Keychain, so a session cannot follow the user's backup onto someone else's
 * phone. Android ignores the option: values are encrypted with a key in the device's Keystore,
 * which never leaves the device.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Keeps the session's tokens in the platform's secure storage (Keychain / Keystore) between
 * launches. Only the shared session manager calls it. The tokens are never logged.
 */
export function createSecureTokenStorage(store: SecureStoreLike = SecureStore): TokenStorage {
  return {
    async load(): Promise<AuthTokens | null> {
      const raw = await store.getItemAsync(TOKEN_STORAGE_KEY, OPTIONS);
      if (raw === null) {
        return null;
      }
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = null;
      }
      const parsed = authTokensSchema.safeParse(value);
      if (!parsed.success) {
        // Written by another version of the app, or damaged. Unusable either way.
        await store.deleteItemAsync(TOKEN_STORAGE_KEY, OPTIONS).catch(() => undefined);
        return null;
      }
      return parsed.data;
    },
    async save(tokens: AuthTokens): Promise<void> {
      await store.setItemAsync(TOKEN_STORAGE_KEY, JSON.stringify(tokens), OPTIONS);
    },
    async clear(): Promise<void> {
      await store.deleteItemAsync(TOKEN_STORAGE_KEY, OPTIONS);
    },
  };
}
