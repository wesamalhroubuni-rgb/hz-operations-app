import { createApiClient, type ApiClient } from '@ops/shared';

import { env } from '../env';

/** How long the status card waits for GET /health before calling it a timeout. */
export const HEALTH_TIMEOUT_MS = 5000;

/**
 * Builds the shared typed API client for the browser. `fetch` is looked up on every call (so a
 * test can stub the global) and never served from the HTTP cache.
 */
export function createWebApiClient(baseUrl: string): ApiClient {
  return createApiClient({
    baseUrl,
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
  });
}

/**
 * The web app's one API client, or null when NEXT_PUBLIC_API_URL is missing or invalid. Every
 * call to the API goes through it.
 */
export const apiClient: ApiClient | null =
  env.apiUrl === null ? null : createWebApiClient(env.apiUrl);
