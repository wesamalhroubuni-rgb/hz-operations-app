import Image from 'next/image';
import type { ReactNode } from 'react';

import { brand } from '@/lib/brand';

import styles from './auth-shell.module.css';

/** The frame of the sign-in and activation pages: the brand above one card. */
export function AuthShell({
  title,
  intro,
  children,
}: Readonly<{ title: string; intro?: string; children: ReactNode }>) {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.brand}>
          <Image
            className={styles.logo}
            src={brand.logo.src}
            width={brand.logo.width}
            height={brand.logo.height}
            alt={brand.logo.alt}
            sizes="96px"
            priority
          />
          <p className={styles.name}>{brand.name}</p>
          <p className={styles.label}>{brand.appLabel}</p>
        </header>

        <section className={styles.card} aria-labelledby="auth-title">
          <h1 id="auth-title" className={styles.title}>
            {title}
          </h1>
          {intro ? <p className={styles.intro}>{intro}</p> : null}
          {children}
        </section>
      </main>

      <footer className={styles.footer}>
        <small>{brand.poweredBy}</small>
      </footer>
    </div>
  );
}
