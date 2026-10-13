import { createApiClient, type ApiClient } from '@ops/shared';

import { env } from '../config/env';

/** How long the status card waits for GET /health before calling it a timeout. */
export const HEALTH_TIMEOUT_MS = 5000;

/**
 * Builds the shared typed API client for the app. `fetch` is looked up on every call, so a test
 * can replace the global.
 */
export function createMobileApiClient(baseUrl: string): ApiClient {
  return createApiClient({
    baseUrl,
    fetch: (input, init) => fetch(input, init),
  });
}

/**
 * The mobile app's one API client, or null when EXPO_PUBLIC_API_URL is not set. Every call to
 * the API goes through it.
 */
export const apiClient: ApiClient | null =
  env.apiUrl === null ? null : createMobileApiClient(env.apiUrl);
