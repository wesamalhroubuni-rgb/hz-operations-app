'use client';

import { useCallback, useEffect, useState } from 'react';

import { fetchApiHealth, type ApiHealthResult } from '@/lib/api/health';
import { env, MISSING_API_URL_MESSAGE } from '@/lib/env';

import styles from './api-status.module.css';

type Tone = 'pending' | 'good' | 'warning' | 'bad';

interface StatusView {
  tone: Tone;
  title: string;
  detail: string;
}

function describe(result: ApiHealthResult | null): StatusView {
  if (result === null) {
    return { tone: 'pending', title: 'Checking the API…', detail: 'Waiting for a response.' };
  }
  if (!result.reachable) {
    return {
      tone: 'bad',
      title: 'API unreachable',
      detail:
        result.reason === 'network'
          ? 'No response from the API. Is it running?'
          : 'Something answered, but not with a valid health response.',
    };
  }
  if (result.health.database === 'up') {
    return { tone: 'good', title: 'API reachable', detail: 'Database is up.' };
  }
  return { tone: 'warning', title: 'API reachable', detail: 'Database is down.' };
}

const NOT_CONFIGURED: StatusView = {
  tone: 'bad',
  title: 'API not configured',
  detail: MISSING_API_URL_MESSAGE,
};

export function ApiStatus() {
  const apiUrl = env.apiUrl;
  const [result, setResult] = useState<ApiHealthResult | null>(null);

  const check = useCallback(async () => {
    if (apiUrl !== null) {
      setResult(await fetchApiHealth(apiUrl));
    }
  }, [apiUrl]);

  useEffect(() => {
    if (apiUrl === null) {
      return;
    }
    let cancelled = false;
    void fetchApiHealth(apiUrl).then((next) => {
      if (!cancelled) {
        setResult(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiUrl]);

  const view = apiUrl === null ? NOT_CONFIGURED : describe(result);

  return (
    <section className={styles.card} aria-labelledby="api-status-heading">
      <h2 id="api-status-heading" className={styles.heading}>
        API status
      </h2>

      <div className={styles.status} role="status" aria-live="polite">
        <span className={`${styles.dot} ${styles[view.tone]}`} aria-hidden="true" />
        <div>
          <p className={styles.title}>{view.title}</p>
          <p className={styles.detail}>{view.detail}</p>
        </div>
      </div>

      <div className={styles.footer}>
        <code className={styles.url}>{apiUrl === null ? 'No API URL' : `${apiUrl}/health`}</code>
        <button
          type="button"
          className={styles.button}
          disabled={apiUrl === null || result === null}
          onClick={() => {
            setResult(null);
            void check();
          }}
        >
          Check again
        </button>
      </div>
    </section>
  );
}
