'use client';

import { useApiHealth } from '@/hooks/use-api-health';
import { CHECK_AGAIN_LABEL, describeHealth } from '@ops/shared';
import { env, MISSING_API_URL_MESSAGE } from '@/lib/env';

import styles from './api-status.module.css';

export function ApiStatus() {
  const { state, check } = useApiHealth();
  const view = describeHealth(state, MISSING_API_URL_MESSAGE);
  // A manual check is pointless without a URL or while the first answer is still on its way.
  const cannotCheck = state === null || state.result === null;

  return (
    <section className={styles.card} aria-labelledby="api-status-heading">
      <h2 id="api-status-heading" className={styles.heading}>
        API status
      </h2>

      <div className={styles.status} role="status" aria-live="polite">
        <span
          className={`${styles.dot} ${styles[view.tone]} ${view.busy ? styles.busy : ''}`}
          aria-hidden="true"
        />
        <div>
          <p className={styles.title}>{view.title}</p>
          <p className={styles.detail}>{view.detail}</p>
        </div>
      </div>

      <div className={styles.footer}>
        <code className={styles.url}>
          {env.apiUrl === null ? 'No API URL' : `${env.apiUrl}/health`}
        </code>
        <button type="button" className={styles.button} disabled={cannotCheck} onClick={check}>
          {CHECK_AGAIN_LABEL}
        </button>
      </div>
    </section>
  );
}
