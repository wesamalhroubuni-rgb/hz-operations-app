import { describe, expect, it, vi } from 'vitest';

import { createApiClient } from '../api-client/create-api-client.js';
import { API_ERROR_STATUS } from '../common/errors.js';
import { isRtlLocale, localeDirection, localeOf, localeSchema } from '../common/locale.js';
import { dashboardOverviewQuerySchema, listFilterSchema } from './dashboard.js';
import { exportTasksQuerySchema, exportWorkLogsQuerySchema } from './exports.js';
import { organizationSettingsSchema, updateOrganizationSchema } from './organization.js';
import { REPORT_MAX_DAYS, workLogReportQuerySchema } from './reports.js';
import { listTasksQuerySchema } from './tasks.js';
import { createUserSchema, updateUserSchema } from './users.js';
import {
  BULK_REVIEW_MAX_ITEMS,
  bulkWorkLogStatusResultSchema,
  bulkWorkLogStatusSchema,
  listWorkLogsQuerySchema,
  WORK_LOG_MAP_MAX_LIMIT,
  workLogMapQuerySchema,
} from './work-logs.js';

const ID_A = '0190f3a2-7c1e-7000-8000-000000000001';
const ID_B = '0190f3a2-7c1e-7000-8000-000000000002';

describe('work-log filters (Phase 6)', () => {
  it('accepts search and hasPhotos as query strings, and the new sort fields', () => {
    const query = listWorkLogsQuerySchema.parse({
      search: ' pump ',
      hasPhotos: 'false',
      sort: 'status:asc',
    });
    expect(query.search).toBe('pump');
    expect(query.hasPhotos).toBe(false);
    expect(query.sort).toEqual({ field: 'status', direction: 'asc' });
    expect(listWorkLogsQuerySchema.safeParse({ sort: 'text:asc' }).success).toBe(false);
  });

  it('shares the same filters with the export and the map', () => {
    expect(exportWorkLogsQuerySchema.parse({ hasPhotos: 'true', siteId: ID_A })).toMatchObject({
      hasPhotos: true,
      siteId: ID_A,
      includeArchived: false,
    });
    expect(workLogMapQuerySchema.parse({}).limit).toBe(500);
    expect(workLogMapQuerySchema.safeParse({ limit: WORK_LOG_MAP_MAX_LIMIT + 1 }).success).toBe(
      false,
    );
  });
});

describe('task filters (Phase 6)', () => {
  it('accepts open and overdue', () => {
    expect(listTasksQuerySchema.parse({ open: 'true', overdue: 'true' })).toMatchObject({
      open: true,
      overdue: true,
    });
    expect(exportTasksQuerySchema.parse({ status: 'blocked' }).status).toBe('blocked');
  });
});

describe('bulk review body', () => {
  it('needs a note to reject and refuses duplicates and other statuses', () => {
    expect(
      bulkWorkLogStatusSchema.safeParse({ status: 'approved', items: [{ id: ID_A }] }).success,
    ).toBe(true);
    expect(
      bulkWorkLogStatusSchema.safeParse({ status: 'rejected', items: [{ id: ID_A }] }).success,
    ).toBe(false);
    expect(
      bulkWorkLogStatusSchema.safeParse({
        status: 'rejected',
        note: 'Photo missing',
        items: [{ id: ID_A, expectedVersion: 2 }],
      }).success,
    ).toBe(true);
    expect(
      bulkWorkLogStatusSchema.safeParse({ status: 'approved', items: [{ id: ID_A }, { id: ID_A }] })
        .success,
    ).toBe(false);
    expect(
      bulkWorkLogStatusSchema.safeParse({ status: 'submitted', items: [{ id: ID_A }] }).success,
    ).toBe(false);
    expect(bulkWorkLogStatusSchema.safeParse({ status: 'approved', items: [] }).success).toBe(
      false,
    );
    const tooMany = Array.from({ length: BULK_REVIEW_MAX_ITEMS + 1 }, (_, index) => ({
      id: `0190f3a2-7c1e-7000-8000-${String(index).padStart(12, '0')}`,
    }));
    expect(bulkWorkLogStatusSchema.safeParse({ status: 'approved', items: tooMany }).success).toBe(
      false,
    );
    expect(
      bulkWorkLogStatusSchema.safeParse({ status: 'approved', items: [{ id: ID_A }], extra: 1 })
        .success,
    ).toBe(false);
  });

  it('parses per-item results with typed error codes', () => {
    const parsed = bulkWorkLogStatusResultSchema.safeParse({
      results: [
        {
          ok: false,
          id: ID_B,
          error: { statusCode: 403, code: 'forbidden', message: 'You cannot review your own log' },
        },
      ],
      succeeded: 0,
      failed: 1,
    });
    expect(parsed.success).toBe(true);
  });
});

describe('report range', () => {
  it('needs from before to and at most the maximum span', () => {
    const from = '2026-10-01T00:00:00.000Z';
    expect(
      workLogReportQuerySchema.safeParse({ occurredFrom: from, occurredTo: '2026-10-08T00:00:00Z' })
        .success,
    ).toBe(true);
    expect(
      workLogReportQuerySchema.safeParse({ occurredFrom: from, occurredTo: from }).success,
    ).toBe(false);
    const tooLate = new Date(Date.parse(from) + (REPORT_MAX_DAYS + 1) * 86_400_000).toISOString();
    expect(
      workLogReportQuerySchema.safeParse({ occurredFrom: from, occurredTo: tooLate }).success,
    ).toBe(false);
  });
});

describe('overview query and links', () => {
  it('takes an optional day and string filters', () => {
    expect(dashboardOverviewQuerySchema.parse({})).toEqual({});
    expect(dashboardOverviewQuerySchema.safeParse({ day: '2026-13-01' }).success).toBe(false);
    expect(listFilterSchema.safeParse({ status: 'submitted' }).success).toBe(true);
    expect(listFilterSchema.safeParse({ status: 1 }).success).toBe(false);
  });
});

describe('organization time zone and user locale', () => {
  it('validates the time zone setting', () => {
    expect(organizationSettingsSchema.safeParse({ timeZone: 'Europe/Istanbul' }).success).toBe(
      true,
    );
    expect(organizationSettingsSchema.safeParse({ timeZone: 'Nowhere/City' }).success).toBe(false);
    expect(
      updateOrganizationSchema.safeParse({
        settings: { timeZone: 'UTC', workLogEditWindowHours: 8 },
      }).success,
    ).toBe(true);
  });

  it('accepts only supported locales', () => {
    expect(updateUserSchema.safeParse({ locale: 'tr' }).success).toBe(true);
    expect(updateUserSchema.safeParse({ locale: 'de' }).success).toBe(false);
    expect(
      createUserSchema.safeParse({ displayName: 'A', username: 'abc', locale: 'ar' }).success,
    ).toBe(true);
    expect(localeSchema.options).toEqual(['en', 'tr', 'ar']);
    expect(localeOf('tr-TR')).toBe('tr');
    expect(localeOf('de')).toBe('en');
    expect(localeOf(undefined)).toBe('en');
    expect(isRtlLocale('ar')).toBe(true);
    expect(localeDirection('ar-SA')).toBe('rtl');
    expect(localeDirection('tr')).toBe('ltr');
  });
});

describe('export_too_large', () => {
  it('is a 422', () => {
    expect(API_ERROR_STATUS.export_too_large).toBe(422);
  });
});

describe('Phase 6 endpoints', () => {
  function clientWith(response: () => Response) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    return { fetch, client: createApiClient({ baseUrl: 'http://api.test', fetch }) };
  }

  it('downloads CSV as text, with the filters in the query', async () => {
    const { fetch, client } = clientWith(
      () =>
        new Response('﻿ID,Status\r\n', {
          status: 200,
          headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        }),
    );
    const result = await client.exports.workLogsCsv({ status: 'submitted', hasPhotos: true });
    expect(result.ok).toBe(true);
    // Response.text() strips the byte order mark.
    expect(result.ok && result.data).toBe('ID,Status\r\n');
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      'http://api.test/exports/work-logs.csv?status=submitted&hasPhotos=true',
    );
    expect((init?.headers as Record<string, string>).Accept).toContain('text/csv');
  });

  it('still reads a JSON error body from a CSV endpoint', async () => {
    const { client } = clientWith(() =>
      Response.json(
        {
          statusCode: 422,
          code: 'export_too_large',
          message: 'Too many rows',
          correlationId: null,
          timestamp: '2026-10-28T10:00:00.000Z',
        },
        { status: 422 },
      ),
    );
    const result = await client.exports.tasksCsv({});
    expect(result.ok).toBe(false);
    expect(!result.ok && result.failure.kind === 'http' && result.failure.error.code).toBe(
      'export_too_large',
    );
  });

  it('posts the bulk review and reads the history', async () => {
    const { fetch, client } = clientWith(() =>
      Response.json({ items: [], truncated: false }, { status: 200 }),
    );
    const history = await client.workLogs.history(ID_A);
    expect(history.ok).toBe(true);
    expect(String(fetch.mock.calls[0]![0])).toBe(`http://api.test/work-logs/${ID_A}/history`);
    await client.tasks.history(ID_B);
    expect(String(fetch.mock.calls[1]![0])).toBe(`http://api.test/tasks/${ID_B}/history`);
  });
});
