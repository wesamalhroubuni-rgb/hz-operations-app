'use client';

import { Fragment, useEffect, useSyncExternalStore, type ReactNode } from 'react';

import { currentLocale, setLocale } from '@/i18n';
import { applyDocumentLanguage, readLanguage, subscribeLanguage } from '@/lib/language';

/**
 * Sets the dashboard's language (the browser's choice, `lib/language.ts`) before anything
 * renders, and re-renders everything when it changes. The server renders nothing here: the
 * language is known only in the browser, so no English page is sent and then swapped (no
 * hydration mismatch). The pages are behind sign-in, so nothing is lost for search engines.
 */
export function LanguageGate({ children }: Readonly<{ children: ReactNode }>) {
  const locale = useSyncExternalStore(subscribeLanguage, readLanguage, () => null);

  if (locale !== null && currentLocale() !== locale) {
    // `t` is a plain module function: switch it before the children render with it.
    setLocale(locale);
  }

  useEffect(() => {
    if (locale !== null) {
      applyDocumentLanguage(locale);
    }
  }, [locale]);

  if (locale === null) {
    return null;
  }
  // A new key remounts the tree, so every component reads the new language.
  return <Fragment key={locale}>{children}</Fragment>;
}
