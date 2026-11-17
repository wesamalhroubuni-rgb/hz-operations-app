import { useCallback, useState } from 'react';

import { useSync } from '../components/SyncProvider';

/**
 * Pull to refresh that really asks the server: a sync run (send the queue, then pull), after
 * which the screens' local queries re-read the store by themselves. `also` runs alongside (a
 * refetch, a re-check of the user). `refreshing` is this gesture's own state, so the spinner
 * does not flash on the automatic pulls every 15 s.
 */
export function useServerRefresh(also?: () => unknown): {
  refreshing: boolean;
  refresh: () => void;
} {
  const { syncNow } = useSync();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    setRefreshing(true);
    void Promise.allSettled([syncNow(), Promise.resolve().then(() => also?.())]).finally(() =>
      setRefreshing(false),
    );
  }, [syncNow, also]);
  return { refreshing, refresh };
}
