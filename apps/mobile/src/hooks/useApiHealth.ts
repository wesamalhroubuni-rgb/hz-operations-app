import { useCallback, useEffect, useState } from 'react';

import { fetchHealth, type HealthCheckResult } from '../api/health';

export type ApiHealthState =
  { phase: 'not-configured' } | { phase: 'loading' } | { phase: 'done'; result: HealthCheckResult };

interface Answer {
  attempt: number;
  result: HealthCheckResult;
}

/** Checks the API health on mount and again each time `retry` is called. */
export function useApiHealth(apiUrl: string | null): { state: ApiHealthState; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<Answer | null>(null);

  useEffect(() => {
    if (!apiUrl) {
      return;
    }
    let cancelled = false;
    void fetchHealth(apiUrl).then((result) => {
      // Ignore the answer when a newer attempt started or the screen was closed.
      if (!cancelled) {
        setAnswer({ attempt, result });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [apiUrl, attempt]);

  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  if (!apiUrl) {
    return { state: { phase: 'not-configured' }, retry };
  }
  if (!answer || answer.attempt !== attempt) {
    return { state: { phase: 'loading' }, retry };
  }
  return { state: { phase: 'done', result: answer.result }, retry };
}
