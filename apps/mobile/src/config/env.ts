/**
 * Single place where the app reads its environment variables.
 *
 * Expo replaces `process.env.EXPO_PUBLIC_*` with the literal value while bundling,
 * so each variable must be read with static dot notation (no destructuring, no
 * `process.env[name]`). Values come from the root `.env`, loaded by dotenv-cli in
 * the package scripts.
 *
 * `app.config.ts` reads EXPO_PUBLIC_BRAND_NAME on its own (it runs in Node, before
 * the bundle exists) and must use the same fallback.
 */

/**
 * Shown when EXPO_PUBLIC_BRAND_NAME is not set. Deliberately not a client's name. `app.config.ts`
 * repeats this value (it cannot import this file); change both together.
 */
export const DEFAULT_BRAND_NAME = 'Operations';

function readUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

function readText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export const env = {
  /** Base URL of the API without a trailing slash, or null when it is not configured. */
  apiUrl: readUrl(process.env.EXPO_PUBLIC_API_URL),
  /** Name of the client's product this build is branded as. */
  brandName: readText(process.env.EXPO_PUBLIC_BRAND_NAME, DEFAULT_BRAND_NAME),
  /**
   * Slug of the organization this build serves, sent with every sign-in. Required by the API as
   * soon as more than one organization exists; null when not configured.
   */
  organizationSlug: process.env.EXPO_PUBLIC_ORGANIZATION_SLUG?.trim() || null,
  /**
   * EAS project id, needed for an Expo push token (`eas init` prints it). Null when not set: the
   * app then runs without push, and the in-app notification list still works.
   */
  easProjectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID?.trim() || null,
} as const;

export const MISSING_API_URL_MESSAGE =
  'EXPO_PUBLIC_API_URL is not set. Add it to the root .env file (see .env.example) and restart the dev server.';
