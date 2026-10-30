import {
  createTranslator,
  DEFAULT_LOCALE,
  localeDirection,
  type CatalogueShape,
  type CatalogueTree,
  type Locale,
  type MessageKey,
  type TranslateParams,
} from '@ops/shared';

import { en, type EnglishCatalogue } from './en';

// The dashboard's one translation layer (ADR-0009), built on the translator in `@ops/shared`
// (the same core as the mobile app). Every sentence a page shows comes from a catalogue in this
// folder: components call `t('nav.overview')` and never contain user-facing English. Works in
// server and client components (no React here).
//
// Adding a language (Turkish, Arabic, ...):
//   1. copy `en.ts` to `tr.ts`, translate the values, and type it
//      `export const tr: CatalogueShape<EnglishCatalogue> = { ... }`;
//   2. add it to `CATALOGUES` below;
//   3. pick the locale per user: the signed-in user's `locale` (`GET /auth/me`, `User.locale`)
//      through a provider, with `<html lang dir>` set from it. Until a second catalogue exists
//      the dashboard is English and `LOCALE` is fixed.
//
// Right to left: stylesheets use logical properties only (`margin-inline-start`,
// `padding-inline`, `inset-inline-end`, `text-align: start`, `border-inline-start`), never
// `left` / `right`, so an Arabic layout mirrors by itself once `dir="rtl"` is set.

export type { EnglishCatalogue };
export type TranslationKey = MessageKey<EnglishCatalogue>;

const CATALOGUES = {
  en,
} satisfies Partial<Record<Locale, CatalogueShape<EnglishCatalogue>>>;

/** The dashboard's language. Fixed to English until a second catalogue exists (see above). */
export const LOCALE: Locale = DEFAULT_LOCALE;
/** BCP 47 tag used for dates and numbers. */
export const LOCALE_TAG = 'en-GB';
/** The `dir` attribute of `<html>`. */
export const DIRECTION = localeDirection(LOCALE);

const translator = createTranslator<TranslationKey>(
  LOCALE_TAG,
  (CATALOGUES as Partial<Record<Locale, unknown>>)[LOCALE] as CatalogueTree,
  en as unknown as CatalogueTree,
);

/** Translates a key of the catalogue, with `{{name}}` parameters and `count` for plurals. */
export function t(key: TranslationKey, params?: TranslateParams): string {
  return translator.t(key, params);
}

/** A number with the locale's separators. */
export function formatNumber(value: number, maximumFractionDigits = 2): string {
  try {
    return new Intl.NumberFormat(LOCALE_TAG, { maximumFractionDigits }).format(value);
  } catch {
    return String(value);
  }
}
