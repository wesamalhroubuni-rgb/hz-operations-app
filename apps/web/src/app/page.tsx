import Image from 'next/image';

import { ApiStatus } from '@/components/api-status';
import { SessionCard } from '@/components/session-card';
import { brand } from '@/lib/brand';

import styles from './page.module.css';

/**
 * The protected placeholder home page. The route guard in `AuthProvider` shows it only to a
 * signed-in user; it has no data of its own beyond who that user is.
 */
export default function HomePage() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <header className={styles.header}>
          <Image
            className={styles.logo}
            src={brand.logo.src}
            width={brand.logo.width}
            height={brand.logo.height}
            alt={brand.logo.alt}
            sizes="160px"
            priority
          />
          <h1 className={styles.title}>{brand.name}</h1>
          <p className={styles.label}>{brand.appLabel}</p>
          <span className={styles.rule} aria-hidden="true" />
          <p className={styles.note}>
            Placeholder page. Sign-in works; dashboard features come in later phases.
          </p>
        </header>

        <SessionCard />
        <ApiStatus />
      </main>

      <footer className={styles.footer}>
        <small>{brand.poweredBy}</small>
      </footer>
    </div>
  );
}
