import type { SyncPullEvent } from '../offline/types';

// Live updates (2026-11-16): while the app is open the sync engine pulls every 15 s
// (`src/offline/engine.ts`), and each successful pull may re-check who the signed-in user is,
// so a role, scope or name changed on the dashboard shows without a restart.

/** How long a confirmed user is trusted before an ordinary pull asks `/auth/me` again. */
export const USER_RECHECK_MS = 60 * 1000;

/**
 * What a successful pull asks of `refreshUser`: at once when the server signalled a changed
 * scope (a full answer to a cursor), else at most once a minute.
 */
export function userRefreshAfterPull(pull: SyncPullEvent): { maxAgeMs?: number } {
  return pull.scopeChanged ? {} : { maxAgeMs: USER_RECHECK_MS };
}
