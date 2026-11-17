import { describe, expect, it } from 'vitest';

import { ApiCallError } from './errors';
import { LIVE_REFETCH_MAX_MS, LIVE_REFETCH_MS, liveRefetchInterval } from './live';
import { queryKeys } from './query';

function query(
  queryKey: readonly unknown[],
  state: Partial<{ status: string; error: unknown; fetchFailureCount: number }> = {},
) {
  return {
    queryKey,
    state: { status: 'success', error: null, fetchFailureCount: 0, ...state },
  };
}

function httpError(status: number): ApiCallError {
  return new ApiCallError({
    kind: 'http',
    status,
    message: 'Refused',
    error: {
      statusCode: status,
      code: status === 429 ? 'rate_limited' : 'not_found',
      message: 'Refused',
      correlationId: null,
      timestamp: '2026-11-16T10:00:00.000Z',
    },
  } as never);
}

describe('liveRefetchInterval (live updates on the dashboard)', () => {
  it('polls what other people change every 15 seconds', () => {
    for (const key of [
      queryKeys.dashboard.overview(null),
      queryKeys.workLogs.list({ page: 1 }),
      queryKeys.workLogs.detail('log-1'),
      queryKeys.workLogs.history('log-1'),
      queryKeys.workLogs.map({}),
      queryKeys.tasks.list({}),
      queryKeys.tasks.detail('task-1'),
      queryKeys.users.list({}),
      queryKeys.memberships.list({}),
    ]) {
      expect(liveRefetchInterval(query(key))).toBe(LIVE_REFETCH_MS);
    }
    expect(LIVE_REFETCH_MS).toBe(15_000);
  });

  it('does not poll slow-moving data, reports, or the signed photo URLs', () => {
    for (const key of [
      queryKeys.organization,
      queryKeys.directory,
      queryKeys.sites.list({}),
      queryKeys.logTypes.list({}),
      queryKeys.audit.list({}),
      queryKeys.reports.workLogs({}),
      queryKeys.workLogs.attachments('log-1'),
    ]) {
      expect(liveRefetchInterval(query(key))).toBe(false);
    }
  });

  it('backs off while a query keeps failing, up to five minutes', () => {
    const key = queryKeys.workLogs.list({});
    expect(liveRefetchInterval(query(key, { fetchFailureCount: 1 }))).toBe(30_000);
    expect(liveRefetchInterval(query(key, { fetchFailureCount: 2 }))).toBe(60_000);
    expect(liveRefetchInterval(query(key, { fetchFailureCount: 30 }))).toBe(LIVE_REFETCH_MAX_MS);
  });

  it('stops polling after a refusal that will not pass by itself, but not after a rate limit', () => {
    const key = queryKeys.tasks.detail('task-1');
    const failed = (status: number) =>
      liveRefetchInterval(
        query(key, { status: 'error', error: httpError(status), fetchFailureCount: 1 }),
      );
    expect(failed(404)).toBe(false);
    expect(failed(403)).toBe(false);
    expect(failed(429)).toBe(30_000);
    expect(failed(500)).toBe(30_000);
  });
});
