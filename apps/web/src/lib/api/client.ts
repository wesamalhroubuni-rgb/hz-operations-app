import { createAuthSessionManager, type ApiClient, type AuthSessionManager } from '@ops/shared';

import { env } from '../env';

/** How long the status card waits for GET /health before calling it a timeout. */
export const HEALTH_TIMEOUT_MS = 5000;

/**
 * Builds the sign-in state of the browser together with the typed API client bound to it.
 *
 * `mode: 'web'` means the session lives in httpOnly cookies that the API sets and this code
 * cannot read: every request is sent with `credentials: 'include'`, and the only thing kept (in
 * memory) is the CSRF token the API hands out, sent back on state-changing requests. Nothing is
 * written to localStorage or sessionStorage, and no token ever reaches JavaScript.
 *
 * `fetch` is looked up on every call (so a test can stub the global) and never served from the
 * HTTP cache.
 */
export function createWebAuthSession(baseUrl: string): AuthSessionManager {
  return createAuthSessionManager({
    baseUrl,
    mode: 'web',
    ...(env.organizationSlug ? { organizationSlug: env.organizationSlug } : {}),
    fetch: (input, init) => fetch(input, { ...init, cache: 'no-store' }),
  });
}

/** The API client alone, for callers that do not need the sign-in state. */
export function createWebApiClient(baseUrl: string): ApiClient {
  return createWebAuthSession(baseUrl).client;
}

/** The web app's one session, or null when NEXT_PUBLIC_API_URL is missing or invalid. */
export const authSession: AuthSessionManager | null =
  env.apiUrl === null ? null : createWebAuthSession(env.apiUrl);

/**
 * The web app's one API client, or null when NEXT_PUBLIC_API_URL is missing or invalid. Every
 * call to the API goes through it, so every call carries the session and renews it on a 401.
 */
export const apiClient: ApiClient | null = authSession?.client ?? null;
