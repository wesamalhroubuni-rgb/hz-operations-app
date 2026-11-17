'use client';

import { SUPPORTED_LOCALES } from '@ops/shared';
import { useSyncExternalStore } from 'react';

import { currentLocale, t } from '@/i18n';
import {
  applyLanguagePreference,
  LANGUAGE_NAMES,
  readLanguage,
  subscribeLanguage,
} from '@/lib/language';

import styles from './language-switch.module.css';

/** The languages as small pills, each in its own language (the sign-in and activation pages). */
export function LanguageSwitch() {
  const active = useSyncExternalStore(subscribeLanguage, readLanguage, currentLocale);
  return (
    <div className={styles.switch} role="group" aria-label={t('language.label')}>
      {SUPPORTED_LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          className={styles.option}
          aria-pressed={active === locale}
          onClick={() => applyLanguagePreference(locale)}
        >
          {LANGUAGE_NAMES[locale]}
        </button>
      ))}
    </div>
  );
}
