import { useEffect, useState, useSyncExternalStore } from 'react';

import { apiClient, HEALTH_TIMEOUT_MS } from '../api/client';
import { createHealthMonitor, type HealthMonitor, type HealthMonitorState } from '@ops/shared';

function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * Checks the API's health when the screen mounts, retries on its own while the API does not
 * answer, and stops when the screen unmounts. `state` is null when no API URL is configured.
 * All the logic is in the health monitor; this hook only connects it to React.
 */
export function useApiHealth(): { state: HealthMonitorState | null; check: () => void } {
  const [monitor] = useState<HealthMonitor | null>(() => {
    const client = apiClient;
    return client === null
      ? null
      : createHealthMonitor({ check: () => client.health.get({ timeoutMs: HEALTH_TIMEOUT_MS }) });
  });

  const state = useSyncExternalStore(
    monitor?.subscribe ?? subscribeToNothing,
    () => monitor?.getState() ?? null,
  );

  useEffect(() => {
    if (monitor === null) {
      return;
    }
    monitor.check();
    return () => monitor.stop();
  }, [monitor]);

  return { state, check: () => monitor?.check() };
}
