import { localeDirection, pickLanguage, SUPPORTED_LOCALES, type Locale } from '@ops/shared';

/**
 * The dashboard's language. `system` (the default) follows the browser's preferred languages;
 * `en`, `tr` and `ar` override it. Like the theme, the choice is a per-browser convenience kept in
 * localStorage, applied as `lang` and `dir` on <html> before the first paint by
 * {@link LANGUAGE_INIT_SCRIPT}, and read by `LanguageGate` before anything is rendered.
 */
export const LANGUAGE_PREFERENCES = ['system', ...SUPPORTED_LOCALES] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];

export const LANGUAGE_STORAGE_KEY = 'hz.language';

/** Each language's own name, written in that language (never translated). */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  ar: 'العربية',
};

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return (SUPPORTED_LOCALES as readonly unknown[]).includes(value) ? (value as Locale) : 'system';
}

/** The language a preference stands for, given the browser's preferred languages. */
export function resolveLanguage(
  preference: LanguagePreference,
  browserLanguages: readonly string[],
): Locale {
  return preference === 'system'
    ? pickLanguage(browserLanguages, SUPPORTED_LOCALES, 'en')
    : preference;
}

/** Runs before the first paint, so an Arabic page never flashes left to right. */
export const LANGUAGE_INIT_SCRIPT =
  `try{var p=localStorage.getItem('${LANGUAGE_STORAGE_KEY}');` +
  `var l=p==='en'||p==='tr'||p==='ar'?p:null;` +
  `if(!l){var b=navigator.languages||[navigator.language];` +
  `for(var i=0;i<b.length&&!l;i++){var c=String(b[i]).toLowerCase().split(/[-_]/)[0];` +
  `if(c==='en'||c==='tr'||c==='ar'){l=c;}}}l=l||'en';` +
  `var r=document.documentElement;r.lang=l;r.dir=l==='ar'?'rtl':'ltr';}catch(e){}`;

let current: LanguagePreference | null = null;

export function readLanguagePreference(): LanguagePreference {
  if (current !== null) return current;
  try {
    return parseLanguagePreference(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

function browserLanguages(): string[] {
  try {
    return [...(navigator.languages ?? [navigator.language])];
  } catch {
    return [];
  }
}

/** The language in force in this browser. */
export function readLanguage(): Locale {
  return resolveLanguage(readLanguagePreference(), browserLanguages());
}

const listeners = new Set<() => void>();

/** For `useSyncExternalStore`: told when the choice changes in this page. */
export function subscribeLanguage(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('languagechange', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('languagechange', listener);
  };
}

/** Sets `lang` and `dir` on <html> for a language. */
export function applyDocumentLanguage(locale: Locale): void {
  const root = document.documentElement;
  root.lang = locale;
  root.dir = localeDirection(locale);
}

/** Applies the choice at once and remembers it in this browser. */
export function applyLanguagePreference(preference: LanguagePreference): void {
  try {
    if (preference === 'system') {
      window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
    }
  } catch {
    // Private mode or blocked storage: the choice still applies to this page.
  }
  current = preference;
  applyDocumentLanguage(readLanguage());
  listeners.forEach((listener) => listener());
}
