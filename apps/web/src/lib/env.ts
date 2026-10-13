import { z } from 'zod';

/**
 * The single place where the web app reads environment variables.
 *
 * Values come from the root .env file (loaded by dotenv-cli in the package
 * scripts). Next.js inlines NEXT_PUBLIC_* variables at build time, and only
 * when they are written out in full as `process.env.NEXT_PUBLIC_...`.
 */
const apiUrlSchema = z.url({ protocol: /^https?$/ });

function readUrl(value: string | undefined): string | null {
  const parsed = apiUrlSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data.replace(/\/+$/, '') : null;
}

export const env = {
  /** Base URL of the API without a trailing slash, or null when it is missing or invalid. */
  apiUrl: readUrl(process.env.NEXT_PUBLIC_API_URL),
} as const;

export const MISSING_API_URL_MESSAGE =
  'NEXT_PUBLIC_API_URL is not set to an http(s) URL. Add it to the root .env file (see .env.example) and restart the dev server.';
