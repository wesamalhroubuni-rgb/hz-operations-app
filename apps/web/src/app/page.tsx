import { ApiStatus } from '@/components/api-status';

import styles from './page.module.css';

export default function HomePage() {
  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Kaneri.ai</p>
        <h1 className={styles.title}>Operations App — Manager Dashboard</h1>
        <p className={styles.note}>
          Phase 1 placeholder. The project is set up and running; dashboard features come in later
          phases.
        </p>
      </header>

      <ApiStatus />
    </main>
  );
}
