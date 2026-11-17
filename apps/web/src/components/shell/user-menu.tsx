'use client';

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { t, type TranslationKey } from '@/i18n';
import { useCaller } from '@/hooks/use-caller';
import { useSignOut } from '@/hooks/use-sign-out';
import {
  applyLanguagePreference,
  LANGUAGE_NAMES,
  LANGUAGE_PREFERENCES,
  readLanguagePreference,
  subscribeLanguage,
} from '@/lib/language';
import {
  applyThemePreference,
  readThemePreference,
  subscribeThemePreference,
  THEME_MENU_ORDER,
} from '@/lib/theme';

import styles from './shell.module.css';

function initialOf(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?';
}

/**
 * The account button of the top bar: name and role, the theme (System, Dark, Light), the
 * language (System, English, Türkçe, العربية), "Sign out"
 * and "Sign out everywhere".
 * A disclosure (button + panel), closed by Escape, a click outside, or moving focus away.
 */
export function UserMenu() {
  const { user, capabilities } = useCaller();
  const { busy, failure, run } = useSignOut();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const themeTitleId = useId();
  const languageTitleId = useId();
  const language = useSyncExternalStore(
    subscribeLanguage,
    readLanguagePreference,
    () => 'system' as const,
  );
  // The server renders the default; the browser reads the stored choice.
  const theme = useSyncExternalStore(
    subscribeThemePreference,
    readThemePreference,
    () => 'system' as const,
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const roleKey = (
    capabilities.role ? `roles.${capabilities.role}` : 'roles.none'
  ) as TranslationKey;

  return (
    <div
      className={styles.userMenu}
      ref={rootRef}
      onBlur={(event) => {
        if (!rootRef.current?.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.userButton}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t('shell.userMenu', { name: user.displayName })}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.avatar} aria-hidden="true">
          {initialOf(user.displayName)}
        </span>
        <span>{user.displayName}</span>
      </button>
      {open ? (
        <div id={panelId} className={styles.menuPanel}>
          <div className={styles.menuHeader}>
            <p className={styles.menuName}>{t('shell.signedInAs', { name: user.displayName })}</p>
            <p className={styles.menuRole}>{t(roleKey)}</p>
          </div>
          <div className={styles.menuSection} role="group" aria-labelledby={themeTitleId}>
            <p id={themeTitleId} className={styles.menuSectionTitle}>
              {t('theme.label')}
            </p>
            {THEME_MENU_ORDER.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.menuItem}
                aria-pressed={theme === value}
                onClick={() => applyThemePreference(value)}
              >
                <span className={styles.menuCheck} aria-hidden="true">
                  {theme === value ? '•' : ''}
                </span>
                {t(`theme.${value}`)}
              </button>
            ))}
          </div>
          <div className={styles.menuSection} role="group" aria-labelledby={languageTitleId}>
            <p id={languageTitleId} className={styles.menuSectionTitle}>
              {t('language.label')}
            </p>
            {LANGUAGE_PREFERENCES.map((value) => (
              <button
                key={value}
                type="button"
                className={styles.menuItem}
                aria-pressed={language === value}
                lang={value === 'system' ? undefined : value}
                onClick={() => applyLanguagePreference(value)}
              >
                <span className={styles.menuCheck} aria-hidden="true">
                  {language === value ? '•' : ''}
                </span>
                {value === 'system' ? t('language.system') : LANGUAGE_NAMES[value]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={styles.menuItem}
            disabled={busy !== null}
            onClick={() => void run('device')}
          >
            {busy === 'device' ? t('shell.signingOut') : t('shell.signOut')}
          </button>
          <button
            type="button"
            className={styles.menuItem}
            disabled={busy !== null}
            onClick={() => void run('everywhere')}
          >
            {busy === 'everywhere' ? t('shell.signingOut') : t('shell.signOutEverywhere')}
          </button>
          {failure ? (
            <p className={styles.menuError} role="alert">
              {failure}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
