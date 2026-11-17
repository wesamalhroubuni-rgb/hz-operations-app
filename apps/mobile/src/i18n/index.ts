import { getLocales } from 'expo-localization';
import { I18nManager } from 'react-native';

import { ar } from './ar';
import { en, type EnglishCatalogue } from './en';
import { tr } from './tr';
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
// Languages: English (`en.ts`), Turkish (`tr.ts`) and Arabic (`ar.ts`), each typed
// `CatalogueShape<EnglishCatalogue>`, so TypeScript reports a missing or misspelt key. English is
// the fallback for any key a catalogue lacks.
//
// Which language: the phone's language at start-up, unless the worker chose one in Profile
// (`languagePreference.ts`, kept on this phone). `LanguageProvider` loads the choice, calls
// `setLanguage` and re-renders the app.
//
// Right to left: styles use `start`/`end` (never `left`/`right`) and `row` directions flip on
// their own when React Native runs in RTL. For Arabic this module asks React Native to switch the
// layout direction; the switch takes effect on the next start of the app (Profile says so).
// `app.config.ts` declares RTL support (`extra.supportsRTL`).

export type { EnglishCatalogue };
export type TranslationKey = MessageKey<EnglishCatalogue>;

const CATALOGUES = {
  en,
  tr,
  ar,
} satisfies Record<string, CatalogueShape<EnglishCatalogue>>;
export type LanguageCode = keyof typeof CATALOGUES;
export const LANGUAGES = Object.keys(CATALOGUES) as LanguageCode[];

/** Each language's own name, written in that language (never translated). */
export const LANGUAGE_NAMES: Record<LanguageCode, string> = {
  en: 'English',
  tr: 'Türkçe',
  ar: 'العربية',
};

function preferredLanguages(): string[] {
  try {
    return getLocales().map((locale) => locale.languageCode ?? locale.languageTag);
  } catch {
    return [];
  }
}

/** BCP 47 tag for dates and numbers, with the phone's region when it matches the language. */
function regionTagFor(code: LanguageCode): string {
  if (code === 'ar') {
    // Latin digits, as in the records themselves (times, quantities, references).
    return 'ar-u-nu-latn';
  }
  try {
    const match = getLocales().find((locale) => locale.languageCode === code);
    return match?.languageTag ?? code;
  } catch {
    return code;
  }
}

/** The phone's own language among the catalogues (English if none matches). */
export function deviceLanguage(): LanguageCode {
  return pickLanguage(preferredLanguages(), LANGUAGES, 'en');
}

let current: LanguageCode = deviceLanguage();
let currentTag = regionTagFor(current);
let translator = translatorFor(current, currentTag);

function translatorFor(code: LanguageCode, tag: string) {
  return createTranslator<TranslationKey>(
    tag,
    CATALOGUES[code] as unknown as CatalogueTree,
    en as unknown as CatalogueTree,
  );
}

/** The language in force. */
export function currentLanguage(): LanguageCode {
  return current;
}

/** BCP 47 tag of the language in force, for dates and numbers. */
export function localeTag(): string {
  return currentTag;
}

/** True when the language in force is written right to left. */
export function isRtl(): boolean {
  return isRtlLanguage(current);
}

/** Switches the language. Callers re-render (see `LanguageProvider`). */
export function setLanguage(code: LanguageCode): void {
  if (code === current) return;
  current = code;
  currentTag = regionTagFor(code);
  translator = translatorFor(code, currentTag);
}

/** Translates a key of the catalogue, with `{{name}}` parameters and `count` for plurals. */
export function t(key: TranslationKey, params?: TranslateParams): string {
  return translator.t(key, params);
}

/**
 * Lets React Native lay out right to left for an RTL language. React Native applies a change on
 * the next start of the app. Returns true when a restart is needed for the layout to match.
 */
export function applyLayoutDirection(): boolean {
  I18nManager.allowRTL(true);
  const rtl = isRtl();
  if (I18nManager.isRTL !== rtl) {
    I18nManager.forceRTL(rtl);
    return true;
  }
  return false;
}

function format(date: Date, options: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(currentTag, options).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** "16 Oct 2026, 14:05" in the app's language and the phone's region. */
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

/** A number with the language's separators. */
export function formatNumber(value: number, maximumFractionDigits = 2): string {
  try {
    return new Intl.NumberFormat(currentTag, { maximumFractionDigits }).format(value);
  } catch {
    return String(value);
  }
}
