import { getLocales } from 'expo-localization';
import { I18nManager } from 'react-native';

import { en, type EnglishCatalogue } from './en';
import {
  createTranslator,
  isRtlLanguage,
  pickLanguage,
  type CatalogueShape,
  type CatalogueTree,
  type MessageKey,
  type TranslateParams,
} from './translate';

// The app's one translation layer. Every sentence a screen shows comes from a catalogue in this
// folder; screens call `t('tasks.filters.open')` and never contain user-facing English.
//
// Adding a language (Turkish, Arabic, ...) is adding a file and one line:
//   1. copy `en.ts` to `tr.ts`, translate the values, and type it
//      `export const tr: CatalogueShape<EnglishCatalogue> = { ... }` (TypeScript then reports
//      every missing or misspelt key);
//   2. add `tr` to `CATALOGUES` below.
// The phone's language picks the catalogue at start-up (`expo-localization`); English is the
// fallback for a language without a catalogue and for any key a catalogue lacks.
//
// Right to left: styles use `start`/`end` (never `left`/`right`) and `row` directions flip on
// their own when React Native runs in RTL. For an RTL language (Arabic) this module asks React
// Native to switch the layout direction; the switch takes effect on the next start of the app
// (a restart, or `Updates.reloadAsync()` once expo-updates is added). `app.config.ts` declares
// RTL support (`extra.supportsRTL`) for development and release builds.

export type { EnglishCatalogue };
export type TranslationKey = MessageKey<EnglishCatalogue>;

const CATALOGUES = {
  en,
} satisfies Record<string, CatalogueShape<EnglishCatalogue>>;
type LanguageCode = keyof typeof CATALOGUES;

function preferredLanguages(): string[] {
  try {
    return getLocales().map((locale) => locale.languageCode ?? locale.languageTag);
  } catch {
    return [];
  }
}

function preferredRegionTag(language: string): string {
  try {
    const match = getLocales().find((locale) => locale.languageCode === language);
    return match?.languageTag ?? language;
  } catch {
    return language;
  }
}

export const language: LanguageCode = pickLanguage(
  preferredLanguages(),
  Object.keys(CATALOGUES) as LanguageCode[],
  'en',
);

/** BCP 47 tag for dates and numbers, with the phone's region when it matches the language. */
export const localeTag: string = preferredRegionTag(language);

export const isRtl = isRtlLanguage(language);

const translator = createTranslator<TranslationKey>(
  localeTag,
  CATALOGUES[language] as unknown as CatalogueTree,
  en as unknown as CatalogueTree,
);

/** Translates a key of the catalogue, with `{{name}}` parameters and `count` for plurals. */
export function t(key: TranslationKey, params?: TranslateParams): string {
  return translator.t(key, params);
}

/** Lets React Native lay out right to left for an RTL language. Call once at start-up. */
export function applyLayoutDirection(): void {
  I18nManager.allowRTL(true);
  if (I18nManager.isRTL !== isRtl) {
    I18nManager.forceRTL(isRtl);
  }
}

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(localeTag, options).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "16 Oct 2026, 14:05" in the phone's language and region. */
export function formatDateTime(date: Date): string {
  return format(date, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "16 Oct 2026". */
export function formatDate(date: Date): string {
  return format(date, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** "14:05". */
export function formatTime(date: Date): string {
  return format(date, { hour: '2-digit', minute: '2-digit' });
}

/** A number with the phone's separators. */
export function formatNumber(value: number, maximumFractionDigits = 2): string {
  try {
    return new Intl.NumberFormat(localeTag, { maximumFractionDigits }).format(value);
  } catch {
    return String(value);
  }
}
