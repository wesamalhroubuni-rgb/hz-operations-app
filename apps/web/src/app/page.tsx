import Image from 'next/image';

import { ApiStatus } from '@/components/api-status';
import { brand } from '@/lib/brand';

import styles from './page.module.css';

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
            Placeholder page. The project is set up and running; dashboard features come in later
            phases.
          </p>
        </header>

        <ApiStatus />
      </main>

      <footer className={styles.footer}>
        <small>{brand.poweredBy}</small>
      </footer>
    </div>
  );
}
