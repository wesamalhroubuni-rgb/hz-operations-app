import { AUTH_TEXT } from '@ops/shared';

import styles from './session-loading.module.css';

/** Shown while the session is being checked, or while a redirect is under way. */
export function SessionLoading() {
  return (
    <div className={styles.loading} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <p className={styles.text}>{AUTH_TEXT.checkingSession}</p>
    </div>
  );
}
