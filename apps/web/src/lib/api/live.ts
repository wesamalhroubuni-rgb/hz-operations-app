import { statusOf } from './errors';

/**
 * Live updates (2026-11-16): while a dashboard tab is visible, the lists and details that other
 * people change (work logs, tasks, the overview, people and memberships) are fetched again every
 * {@link LIVE_REFETCH_MS}, so an approval, a new log or an assignment shows within seconds without
 * a reload. TanStack Query pauses the interval in a hidden tab (`refetchIntervalInBackground` is
 * off) and refetches on focus; nothing is mounted, so nothing polls, while signed out.
 */
export const LIVE_REFETCH_MS = 15_000;
/** The longest wait while a live query keeps failing with no answer, a timeout, 429 or 5xx. */
export const LIVE_REFETCH_MAX_MS = 5 * 60_000;

/** Query roots that are live. Others (organization, structure, audit, reports) refresh on focus. */
const LIVE_ROOTS: ReadonlySet<unknown> = new Set([
  'dashboard',
  'workLogs',
  'tasks',
  'users',
  'memberships',
]);

/** What `liveRefetchInterval` reads of a TanStack query (structurally a `Query`). */
export interface LiveQueryLike {
  queryKey: readonly unknown[];
  state: { status: string; error: unknown; fetchFailureCount: number };
}

/**
 * The default `refetchInterval` of the dashboard's queries: {@link LIVE_REFETCH_MS} for live
 * roots, `false` for the rest. A photo's signed URLs are never polled (a new signature would
 * reload every image). While a query fails it backs off (doubling, capped); a refusal that will
 * not pass by itself (a 4xx other than 429: missing, outside the scope, forbidden) stops it.
 * A query can still set its own `refetchInterval`.
 */
export function liveRefetchInterval(query: LiveQueryLike): number | false {
  const [root, kind] = query.queryKey;
  if (!LIVE_ROOTS.has(root) || (root === 'workLogs' && kind === 'attachments')) {
    return false;
  }
  if (query.state.status === 'error') {
    const status = statusOf(query.state.error);
    if (status !== null && status >= 400 && status < 500 && status !== 429) {
      return false;
    }
  }
  const failures = Math.min(query.state.fetchFailureCount, 16);
  return Math.min(LIVE_REFETCH_MAX_MS, LIVE_REFETCH_MS * 2 ** failures);
}

/**
 * How often a visible dashboard tab re-checks who the signed-in user is (`refreshUser`), so a
 * role or scope changed by an admin shows in the navigation without a reload. Also the throttle
 * of the re-check when the tab regains focus.
 */
export const USER_RECHECK_MS = 30_000;
