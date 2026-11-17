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

import { ar } from './ar';
import { en, type EnglishCatalogue } from './en';
import { tr } from './tr';

// The dashboard's one translation layer (ADR-0009), built on the translator in `@ops/shared`
// (the same core as the mobile app). Every sentence a page shows comes from a catalogue in this
// folder: components call `t('nav.overview')` and never contain user-facing English. Works in
// server and client components (no React here).
//
// Languages: English (`en/`), Turkish (`tr/`) and Arabic (`ar/`), one file per namespace each,
// typed `CatalogueShape<...>` so TypeScript reports a missing or misspelt key. The language in
// force is chosen per browser (`lib/language.ts`) and set by `LanguageGate` before anything
// renders; `setLocale` switches it, and the gate re-renders the app.
//
// Right to left: stylesheets use logical properties only (`margin-inline-start`,
// `padding-inline`, `inset-inline-end`, `text-align: start`, `border-inline-start`), never
// `left` / `right`, so the Arabic layout mirrors by itself under `dir="rtl"`.

export type { EnglishCatalogue };
export type TranslationKey = MessageKey<EnglishCatalogue>;

const CATALOGUES: Record<Locale, CatalogueShape<EnglishCatalogue>> = { en, tr, ar };

/** BCP 47 tags for dates and numbers. Arabic keeps Latin digits, as in the records themselves. */
const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-GB',
  tr: 'tr-TR',
  ar: 'ar-u-nu-latn',
};

/** The language the server renders with (`<html lang dir>` before the browser's choice). */
export const LOCALE: Locale = DEFAULT_LOCALE;
/** The `dir` attribute the server renders with. */
export const DIRECTION = localeDirection(LOCALE);

function translatorFor(locale: Locale) {
  return createTranslator<TranslationKey>(
    LOCALE_TAGS[locale],
    CATALOGUES[locale] as unknown as CatalogueTree,
    en as unknown as CatalogueTree,
  );
}

let locale: Locale = DEFAULT_LOCALE;
let translator = translatorFor(locale);

/** The language in force. */
export function currentLocale(): Locale {
  return locale;
}

/** The BCP 47 tag of the language in force, for dates and numbers. */
export function localeTag(): string {
  return LOCALE_TAGS[locale];
}

/** `rtl` for Arabic, `ltr` otherwise. */
export function direction(): 'ltr' | 'rtl' {
  return localeDirection(locale);
}

/** Switches the language. Callers re-render (see `LanguageGate`). */
export function setLocale(next: Locale): void {
  if (next === locale) return;
  locale = next;
  translator = translatorFor(next);
}

/** Translates a key of the catalogue, with `{{name}}` parameters and `count` for plurals. */
export function t(key: TranslationKey, params?: TranslateParams): string {
  return translator.t(key, params);
}

/** A number with the locale's separators. */
export function formatNumber(value: number, maximumFractionDigits = 2): string {
  try {
    return new Intl.NumberFormat(localeTag(), { maximumFractionDigits }).format(value);
  } catch {
    return String(value);
  }
}
