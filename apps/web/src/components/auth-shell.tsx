import Image from 'next/image';
import type { ReactNode } from 'react';

import { brand } from '@/lib/brand';

import styles from './auth-shell.module.css';

/**
 * The frame of the sign-in and activation pages: a black brand panel (the logo sits on its own
 * black, so it shows no tile) beside one card. On narrow screens the panel becomes a band above
 * the card.
 */
export function AuthShell({
  title,
  intro,
  children,
}: Readonly<{ title: string; intro?: string; children: ReactNode }>) {
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
        <p className={styles.label}>{brand.appLabel}</p>
      </aside>

      <main className={styles.main}>
        <section className={styles.card} aria-labelledby="auth-title">
          <h1 id="auth-title" className={styles.title}>
            {title}
          </h1>
          {intro ? <p className={styles.intro}>{intro}</p> : null}
          {children}
        </section>
      </main>
    </div>
  );
}
