'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';

import { t } from '@/i18n';
import { brand } from '@/lib/brand';

import styles from './auth-shell.module.css';
import { LanguageSwitch } from './language-switch';

/**
 * The frame of the sign-in and activation pages: a black brand panel (the logo sits on its own
 * black, so it shows no tile) beside one card. On narrow screens the panel becomes a band above
 * the card.
 */
export function AuthShell({
  page,
  children,
}: Readonly<{ page: 'signIn' | 'activate'; children: ReactNode }>) {
  // Translated here, in the browser, where the language is known (the pages render on the server).
  const title = page === 'signIn' ? t('auth.signInTitle') : t('auth.activateTitle');
  const intro = page === 'activate' ? t('auth.activateIntro') : undefined;
  return (
    <div className={styles.page}>
      <aside className={styles.brandPanel}>
        <Image
          className={styles.logo}
          src={brand.logo.src}
          width={brand.logo.width}
          height={brand.logo.height}
          alt={brand.logo.alt}
          sizes="(max-width: 860px) 96px, 200px"
          priority
        />
        <p className={styles.label}>{t('common.appLabel')}</p>
      </aside>

      <main className={styles.main}>
        <section className={styles.card} aria-labelledby="auth-title">
          <h1 id="auth-title" className={styles.title}>
            {title}
          </h1>
          {intro ? <p className={styles.intro}>{intro}</p> : null}
          {children}
        </section>
        <LanguageSwitch />
      </main>
    </div>
  );
}
