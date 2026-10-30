import { z } from 'zod';

/**
 * The languages a user can choose (`User.locale`, ADR-0009). English is complete; Turkish and
 * Arabic are accepted already so a user's choice can be stored, and every catalogue (web,
 * mobile, server-rendered notifications) falls back to English for a key it lacks.
 */
export const SUPPORTED_LOCALES = ['en', 'tr', 'ar'] as const;
export const localeSchema = z.enum(SUPPORTED_LOCALES);
export type Locale = z.infer<typeof localeSchema>;

export const DEFAULT_LOCALE: Locale = 'en';

/** Languages written right to left. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

function languageOf(value: string): string {
  return value.toLowerCase().split(/[-_]/)[0] ?? '';
}

/** A stored or reported locale as a supported one, or the default. `tr-TR` becomes `tr`. */
export function localeOf(value: unknown): Locale {
  if (typeof value !== 'string') {
    return DEFAULT_LOCALE;
  }
  const parsed = localeSchema.safeParse(languageOf(value));
  return parsed.success ? parsed.data : DEFAULT_LOCALE;
}

export function isRtlLocale(locale: string): boolean {
  return RTL_LANGUAGES.has(languageOf(locale));
}

/** The value of the HTML `dir` attribute for a locale. */
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  return isRtlLocale(locale) ? 'rtl' : 'ltr';
}
