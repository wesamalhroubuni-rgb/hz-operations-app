import {
  createAuthSessionManager,
  type ApiClient,
  type AuthSessionManager,
  type TokenStorage,
} from '@ops/shared';
import { Platform } from 'react-native';

import { createSecureTokenStorage } from '../auth/token-storage';
import { env } from '../config/env';

/** How long the status card waits for GET /health before calling it a timeout. */
export const HEALTH_TIMEOUT_MS = 5000;

/**
 * The label of this device in the user's list of sessions. A constant per platform: the real
 * model name would need another native module (expo-device) for very little gain.
 */
export const DEVICE_NAME = Platform.select({
  ios: 'iPhone or iPad',
  android: 'Android device',
  default: 'Mobile app',
});

/**
 * Builds the sign-in state of the app together with the typed API client bound to it.
 *
 * `mode: 'mobile'` means the API answers sign-in with bearer tokens. They are held in memory and
 * in `storage` (SecureStore), sent as `Authorization: Bearer`, and renewed on a 401. No cookies
 * are used. `fetch` is looked up on every call, so a test can replace the global.
 */
export function createMobileAuthSession(
  baseUrl: string,
  storage: TokenStorage,
): AuthSessionManager {
  return createAuthSessionManager({
    baseUrl,
    mode: 'mobile',
    storage,
    ...(env.organizationSlug ? { organizationSlug: env.organizationSlug } : {}),
    deviceName: DEVICE_NAME,
    fetch: (input, init) => fetch(input, init),
  });
}

/** The app's one session, or null when EXPO_PUBLIC_API_URL is not set. */
export const authSession: AuthSessionManager | null =
  env.apiUrl === null ? null : createMobileAuthSession(env.apiUrl, createSecureTokenStorage());

/**
 * The mobile app's one API client, or null when EXPO_PUBLIC_API_URL is not set. Every call to
 * the API goes through it, so every call carries the session and renews it on a 401.
 */
export const apiClient: ApiClient | null = authSession?.client ?? null;
