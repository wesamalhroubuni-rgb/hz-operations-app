import { useEffect } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { useOfflineSession } from '../data/DataProvider';
import { userRefreshAfterPull } from '../logic/liveUpdates';

/**
 * Keeps the signed-in user (role, scope, name) current while the app is open: after each
 * successful pull of the sync engine (every 15 s in the foreground, and on return to the
 * foreground) it asks the session manager to re-check the user, at once when the server signalled
 * a changed scope, else at most once a minute. Mounted once, inside the signed-in tree.
 */
export function useLiveUser(): void {
  const { refreshUser } = useAuth();
  const { engine } = useOfflineSession();
  useEffect(
    () => engine.subscribePulls?.((pull) => void refreshUser(userRefreshAfterPull(pull))),
    [engine, refreshUser],
  );
}
