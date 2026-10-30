import { z } from 'zod';

/**
 * The single place where the web app reads environment variables.
 *
 * Values come from the root .env file (loaded by dotenv-cli in the package
 * scripts). Next.js inlines NEXT_PUBLIC_* variables at build time, and only
 * when they are written out in full as `process.env.NEXT_PUBLIC_...`.
 */
const apiUrlSchema = z.url({ protocol: /^https?$/ });

/** Shown when NEXT_PUBLIC_BRAND_NAME is not set. Deliberately not a client's name. */
const DEFAULT_BRAND_NAME = 'Operations';

function readUrl(value: string | undefined): string | null {
  const parsed = apiUrlSchema.safeParse(value?.trim());
  return parsed.success ? parsed.data.replace(/\/+$/, '') : null;
}

function readText(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export const env = {
  /** Base URL of the API without a trailing slash, or null when it is missing or invalid. */
  apiUrl: readUrl(process.env.NEXT_PUBLIC_API_URL),
  /** Name of the client's product this deployment is branded as. */
  brandName: readText(process.env.NEXT_PUBLIC_BRAND_NAME, DEFAULT_BRAND_NAME),
  /**
   * Slug of the organization this deployment serves, sent with every sign-in. Required by the
   * API as soon as more than one organization exists; null when not configured.
   */
  organizationSlug: process.env.NEXT_PUBLIC_ORGANIZATION_SLUG?.trim() || null,
  /**
   * Map tile URL template (`https://.../{z}/{x}/{y}.png`), or null for the public OpenStreetMap
   * tiles (`src/lib/map.ts`). Only https (or http for a local tile server) templates are used.
   */
  mapTileUrl: readTileUrl(process.env.NEXT_PUBLIC_MAP_TILE_URL),
} as const;

function readTileUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !/^https?:\/\//.test(trimmed) || !trimmed.includes('{z}')) {
    return null;
  }
  return trimmed;
}

export const MISSING_API_URL_MESSAGE =
  'NEXT_PUBLIC_API_URL is not set to an http(s) URL. Add it to the root .env file (see .env.example) and restart the dev server.';
