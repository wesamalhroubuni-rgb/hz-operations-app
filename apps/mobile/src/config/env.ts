/**
 * Single place where the app reads its environment variables.
 *
 * Expo replaces `process.env.EXPO_PUBLIC_*` with the literal value while bundling,
 * so each variable must be read with static dot notation (no destructuring, no
 * `process.env[name]`). Values come from the root `.env`, loaded by dotenv-cli in
 * the package scripts.
 */
function readUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, '');
}

export const env = {
  /** Base URL of the API without a trailing slash, or null when it is not configured. */
  apiUrl: readUrl(process.env.EXPO_PUBLIC_API_URL),
} as const;

export const MISSING_API_URL_MESSAGE =
  'EXPO_PUBLIC_API_URL is not set. Add it to the root .env file and restart the dev server.';
