import type { Directory } from '@ops/shared';
import { describe, expect, it } from 'vitest';

import { t } from '@/i18n';

import { ApiCallError, describeError, isNotFound, shouldRetry, unwrap } from './api/errors';
import { createDirectoryIndex } from './directory';
import { safeFileName } from './download';
import {
  activeFilterCount,
  applyListChange,
  hrefWithFilter,
  readListState,
  toApiQuery,
} from './list-params';
import { boundsOf } from './map';
import { homeFor, navItemFor, routeAccess, visibleNavItems } from './navigation';
import { canReviewWorkLog, capabilitiesFor } from './permissions';
import { createOrgTime, daysOfRange, presetDays } from './time';

const ME = '0190f3a2-7c1e-7000-8000-000000000001';
const OTHER = '0190f3a2-7c1e-7000-8000-000000000002';

describe('capabilities (UX mirror of the policy registry)', () => {
  it('gives workers nothing in the dashboard', () => {
    const worker = capabilitiesFor(['worker']);
    expect(worker.role).toBe('worker');
    expect(worker.usesDashboard).toBe(false);
    expect(worker.reviewWorkLogs).toBe(false);
  });

  it('lets supervisors review and manage tasks, not people, structure, audit or settings', () => {
    const supervisor = capabilitiesFor(['worker', 'supervisor']);
    expect(supervisor.role).toBe('supervisor');
    expect(supervisor).toMatchObject({
      usesDashboard: true,
      reviewWorkLogs: true,
      manageTasks: true,
      exportData: true,
      viewPeople: false,
      manageStructure: false,
      readAudit: false,
      editSettings: false,
    });
  });

  it('lets managers view people and manage structure, and admins everything', () => {
    expect(capabilitiesFor(['manager'])).toMatchObject({
      viewPeople: true,
      manageUsers: false,
      manageStructure: true,
      readAudit: false,
    });
    expect(capabilitiesFor(['admin'])).toMatchObject({
      manageUsers: true,
      readAudit: true,
      editSettings: true,
    });
  });

  it('ignores unknown role names and handles no role', () => {
    expect(capabilitiesFor(['owner']).role).toBeNull();
    expect(capabilitiesFor([]).usesDashboard).toBe(false);
  });

  it('never offers self-review', () => {
    const supervisor = capabilitiesFor(['supervisor']);
    const log = { authorId: OTHER, status: 'submitted', archivedAt: null };
    expect(canReviewWorkLog(supervisor, ME, log)).toBe(true);
    expect(canReviewWorkLog(supervisor, ME, { ...log, authorId: ME })).toBe(false);
    expect(canReviewWorkLog(supervisor, ME, { ...log, status: 'draft' })).toBe(false);
    expect(canReviewWorkLog(supervisor, ME, { ...log, archivedAt: '2026-10-28T00:00:00Z' })).toBe(
      false,
    );
    expect(canReviewWorkLog(capabilitiesFor(['worker']), ME, log)).toBe(false);
  });
});

describe('navigation', () => {
  it('shows the entries of the role', () => {
    const keys = (roles: string[]) => visibleNavItems(capabilitiesFor(roles)).map((i) => i.key);
    expect(keys(['supervisor'])).toEqual(['overview', 'workLogs', 'tasks', 'map']);
    expect(keys(['manager'])).toEqual([
      'overview',
      'workLogs',
      'tasks',
      'map',
      'people',
      'structure',
    ]);
    expect(keys(['admin'])).toHaveLength(8);
    expect(keys(['worker'])).toEqual([]);
  });

  it('maps nested paths to their entry and checks access', () => {
    expect(navItemFor('/work-logs/abc')?.key).toBe('workLogs');
    expect(navItemFor('/work-logs/report')?.key).toBe('workLogs');
    expect(navItemFor('/')?.key).toBe('overview');
    expect(navItemFor('/unknown')).toBeNull();
    const supervisor = capabilitiesFor(['supervisor']);
    expect(routeAccess('/audit', supervisor)).toBe('not-for-role');
    expect(routeAccess('/settings/', supervisor)).toBe('not-for-role');
    expect(routeAccess('/tasks/1', supervisor)).toBe('allowed');
    expect(routeAccess('/tasks', capabilitiesFor(['worker']))).toBe('worker');
    expect(routeAccess('/tasks', capabilitiesFor([]))).toBe('no-role');
    expect(homeFor(supervisor)).toBe('/');
  });
});

describe('list state in the URL', () => {
  const keys = ['status', 'siteId', 'search'];

  it('reads filters, page, size and sort, ignoring unknown and empty parameters', () => {
    const state = readListState(
      new URLSearchParams(
        'status=submitted&siteId=&evil=1&page=3&pageSize=500&sort=occurredAt:asc',
      ),
      keys,
    );
    expect(state).toEqual({
      page: 3,
      pageSize: 100,
      sort: { field: 'occurredAt', direction: 'asc' },
      filters: { status: 'submitted' },
    });
    expect(readListState(new URLSearchParams('page=-2&sort=bad:up'), keys)).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: null,
    });
  });

  it('goes back to page 1 when filters or sort change, and keeps other parameters', () => {
    const current = new URLSearchParams('status=submitted&page=4&tab=board');
    expect(applyListChange(current, { filters: { siteId: 'x' } })).toBe(
      'status=submitted&tab=board&siteId=x',
    );
    expect(applyListChange(current, { filters: { status: null } })).toBe('tab=board');
    expect(applyListChange(current, { page: 5 })).toBe('status=submitted&page=5&tab=board');
    expect(applyListChange(current, { sort: { field: 'status', direction: 'desc' } })).toBe(
      'status=submitted&tab=board&sort=status%3Adesc',
    );
    expect(applyListChange(current, { page: 1 })).toBe('status=submitted&tab=board');
  });

  it('builds the API query and filter links', () => {
    const state = readListState(new URLSearchParams('status=approved&sort=createdAt:desc'), keys);
    expect(toApiQuery(state)).toEqual({
      status: 'approved',
      page: 1,
      pageSize: 25,
      sort: 'createdAt:desc',
    });
    expect(activeFilterCount(state)).toBe(1);
    expect(hrefWithFilter('/work-logs', { status: 'submitted' })).toBe(
      '/work-logs?status=submitted',
    );
    expect(hrefWithFilter('/tasks', {})).toBe('/tasks');
  });
});

describe('organization time', () => {
  const time = createOrgTime('Europe/Istanbul', 'en-GB');

  it('formats in the organization zone and counts days there', () => {
    expect(time.time('2026-10-28T11:05:00Z')).toBe('14:05');
    expect(time.today(new Date('2026-10-28T22:30:00Z'))).toBe('2026-10-29');
    expect(time.range('2026-10-28', '2026-10-28')).toEqual({
      from: '2026-10-27T21:00:00.000Z',
      to: '2026-10-28T21:00:00.000Z',
    });
    expect(time.sortable('2026-10-28T11:05:00Z')).toBe('2026-10-28 14:05');
  });

  it('turns presets and URL ranges into days', () => {
    expect(presetDays('last7Days', '2026-10-28')).toEqual({ from: '2026-10-22', to: '2026-10-28' });
    expect(presetDays('thisMonth', '2026-10-28')).toEqual({ from: '2026-10-01', to: '2026-10-28' });
    expect(
      daysOfRange(
        { from: '2026-10-27T21:00:00.000Z', to: '2026-10-28T21:00:00.000Z' },
        'Europe/Istanbul',
      ),
    ).toEqual({ from: '2026-10-28', to: '2026-10-28' });
    expect(daysOfRange({ from: 'junk' }, 'UTC')).toEqual({ from: null, to: null });
  });
});

describe('directory index', () => {
  const directory: Directory = {
    users: [
      { id: ME, displayName: 'Selin', roles: ['supervisor'], archived: false },
      { id: OTHER, displayName: 'Deniz', roles: ['worker'], archived: false },
    ],
    sites: [{ id: ME, name: 'Depot', parentId: null, archived: true }],
    teams: [],
    logTypes: [],
    truncated: false,
  };

  it('names visible records and says Unknown for the rest', () => {
    const index = createDirectoryIndex(directory, 'Unknown');
    expect(index.user(OTHER)).toBe('Deniz');
    expect(index.user('0190f3a2-7c1e-7000-8000-00000000ffff')).toBe('Unknown');
    expect(index.user(null)).toBe('');
    expect(index.options.workers.map((o) => o.label)).toEqual(['Deniz']);
    expect(index.options.sites[0]).toEqual({ value: ME, label: 'Depot', archived: true });
    expect(createDirectoryIndex(undefined, '?').users).toEqual([]);
  });
});

describe('API errors', () => {
  const http = (status: number, code = 'forbidden') =>
    new ApiCallError({
      kind: 'http',
      status,
      message: 'Server message',
      error: {
        statusCode: status,
        code: code as never,
        message: 'Server message',
        correlationId: null,
        timestamp: '2026-10-28T10:00:00.000Z',
      },
    });

  it('unwraps successes and throws failures', () => {
    expect(unwrap({ ok: true, status: 200, data: 1 })).toBe(1);
    expect(() => unwrap({ ok: false, failure: { kind: 'network', message: 'x' } })).toThrow(
      ApiCallError,
    );
  });

  it('retries only what may pass by itself', () => {
    expect(shouldRetry(0, http(404))).toBe(false);
    expect(shouldRetry(0, http(503))).toBe(true);
    expect(shouldRetry(2, http(503))).toBe(false);
    expect(shouldRetry(0, new ApiCallError({ kind: 'timeout', message: 'x' }))).toBe(true);
    expect(shouldRetry(0, new Error('bug'))).toBe(false);
  });

  it('describes failures without leaking details', () => {
    expect(isNotFound(http(404, 'not_found'))).toBe(true);
    expect(describeError(http(404, 'not_found'))).toBe(t('states.notFoundBody'));
    expect(describeError(http(422, 'unprocessable'))).toBe('Server message');
    expect(describeError(new ApiCallError({ kind: 'network', message: 'fetch failed' }))).toBe(
      t('states.offline'),
    );
    expect(describeError(new Error('stack'))).toBe(t('states.errorTitle'));
  });
});

describe('small helpers', () => {
  it('cleans download names', () => {
    expect(safeFileName('work-logs-2026-10-28.csv')).toBe('work-logs-2026-10-28.csv');
    expect(safeFileName('../a\\b:c.csv')).toBe('..-a-b-c.csv');
    expect(safeFileName('  ')).toBe('export.csv');
  });

  it('computes map bounds from valid points only', () => {
    expect(boundsOf([])).toBeNull();
    expect(
      boundsOf([
        { latitude: 41, longitude: 29 },
        { latitude: 40, longitude: 28 },
        { latitude: 999, longitude: 0 },
      ]),
    ).toEqual([
      [40, 28],
      [41, 29],
    ]);
  });

  it('pluralises catalogue messages', () => {
    expect(t('table.rows', { count: 1 })).toBe('1 row');
    expect(t('table.rows', { count: 3 })).toBe('3 rows');
  });
});
