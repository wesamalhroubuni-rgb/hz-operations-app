import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  apiErrorSchema,
  isRetryableApiErrorCode,
} from '../common/errors.js';
import { auditEventSchema } from '../platform/audit.js';
import {
  CLIENT_SYNC_HEADER,
  CLOCK_SKEW_FLAG_SECONDS,
  clockSkewSecondsOf,
  DEVICE_TIME_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  isClockSkewFlagged,
  offlineSyncHeaders,
} from '../platform/offline-sync.js';
import { startAttachmentUploadSchema, startedAttachmentUploadSchema } from './attachments.js';
import {
  DEFAULT_OFFLINE_MAX_BACKDATE_DAYS,
  offlineMaxBackdateDaysOf,
  organizationSettingsSchema,
} from './organization.js';
import { syncPullQuerySchema, syncPullResponseSchema, SYNC_RESOURCES } from './sync.js';
import { changeTaskStatusSchema } from './tasks.js';
import {
  changeWorkLogStatusSchema,
  createWorkLogSchema,
  MAX_DECLARED_ATTACHMENTS,
  occurredAtRangeProblem,
  updateWorkLogSchema,
  WORK_LOG_MAX_FUTURE_MS,
} from './work-logs.js';

// The Phase 5 (offline mode and sync) contracts of ADR-0008.

const ID = '0190f3a2-7c1e-7000-8000-000000000001';
const ID2 = '0190f3a2-7c1e-7000-8000-000000000002';
const NOW = new Date('2026-10-27T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

describe('error codes', () => {
  it('gives every code exactly one HTTP status', () => {
    expect(Object.keys(API_ERROR_STATUS).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it.each([
    ['version_conflict', 409],
    ['edit_window_closed', 403],
    ['already_reviewed', 409],
    ['record_archived', 409],
    ['task_not_assigned', 403],
    ['task_cancelled', 409],
    ['occurred_at_out_of_range', 422],
    ['attachment_not_declared', 403],
    ['idempotency_key_reused', 422],
    ['request_in_progress', 409],
  ] as const)('%s is %i', (code, status) => {
    expect(API_ERROR_STATUS[code]).toBe(status);
    expect(
      apiErrorSchema.safeParse({
        statusCode: status,
        code,
        message: 'x',
        correlationId: null,
        timestamp: NOW.toISOString(),
      }).success,
    ).toBe(true);
  });

  it('retries only the codes that can pass unchanged later', () => {
    expect(isRetryableApiErrorCode('request_in_progress')).toBe(true);
    expect(isRetryableApiErrorCode('service_unavailable')).toBe(true);
    expect(isRetryableApiErrorCode('version_conflict')).toBe(false);
    expect(isRetryableApiErrorCode('unauthenticated')).toBe(false);
    expect(isRetryableApiErrorCode('occurred_at_out_of_range')).toBe(false);
  });
});

describe('offline sync headers', () => {
  it('builds the queue headers, with the idempotency key when given', () => {
    expect(offlineSyncHeaders({ deviceTime: NOW, idempotencyKey: ID })).toEqual({
      [CLIENT_SYNC_HEADER]: 'offline',
      [DEVICE_TIME_HEADER]: NOW.toISOString(),
      [IDEMPOTENCY_KEY_HEADER]: ID,
    });
    expect(offlineSyncHeaders({ deviceTime: NOW })).not.toHaveProperty(IDEMPOTENCY_KEY_HEADER);
  });

  it('header names are lower-case', () => {
    for (const name of [CLIENT_SYNC_HEADER, DEVICE_TIME_HEADER, IDEMPOTENCY_KEY_HEADER]) {
      expect(name).toBe(name.toLowerCase());
    }
  });

  it('measures the clock skew as phone minus server, in seconds', () => {
    expect(clockSkewSecondsOf('2026-10-27T12:10:00.000Z', NOW)).toBe(600);
    expect(clockSkewSecondsOf('2026-10-27T11:59:30.400Z', NOW)).toBe(-30);
    expect(clockSkewSecondsOf('yesterday', NOW)).toBeNull();
    expect(clockSkewSecondsOf(undefined, NOW)).toBeNull();
  });

  it('flags a skew beyond the threshold only', () => {
    expect(isClockSkewFlagged(CLOCK_SKEW_FLAG_SECONDS)).toBe(false);
    expect(isClockSkewFlagged(-CLOCK_SKEW_FLAG_SECONDS - 1)).toBe(true);
    expect(isClockSkewFlagged(null)).toBe(false);
  });
});

describe('audit metadata', () => {
  const event = {
    id: ID,
    organizationId: ID,
    actorType: 'user',
    actorId: ID,
    action: 'work_log.created',
    entityType: 'work_log',
    entityId: ID,
    before: null,
    after: {},
    changes: null,
    correlationId: null,
    occurredAt: NOW.toISOString(),
  };

  it('accepts null and the offline-sync shape', () => {
    expect(auditEventSchema.safeParse({ ...event, metadata: null }).success).toBe(true);
    expect(
      auditEventSchema.safeParse({
        ...event,
        metadata: {
          via: 'offline_sync',
          deviceTime: '2026-10-27T12:01:00.000Z',
          serverTime: NOW.toISOString(),
          clockSkewSeconds: 60,
        },
      }).success,
    ).toBe(true);
  });
});

describe('organization offline setting', () => {
  it('defaults to seven days and keeps a valid value', () => {
    expect(DEFAULT_OFFLINE_MAX_BACKDATE_DAYS).toBe(7);
    expect(offlineMaxBackdateDaysOf({})).toBe(7);
    expect(offlineMaxBackdateDaysOf(null)).toBe(7);
    expect(offlineMaxBackdateDaysOf({ offlineMaxBackdateDays: 14 })).toBe(14);
    expect(offlineMaxBackdateDaysOf({ offlineMaxBackdateDays: 2.5 })).toBe(7);
    expect(offlineMaxBackdateDaysOf({ offlineMaxBackdateDays: 0 })).toBe(7);
  });

  it('validates the setting', () => {
    expect(organizationSettingsSchema.safeParse({ offlineMaxBackdateDays: 30 }).success).toBe(true);
    expect(organizationSettingsSchema.safeParse({ offlineMaxBackdateDays: 0 }).success).toBe(false);
    expect(organizationSettingsSchema.safeParse({ offlineMaxBackdateDays: 91 }).success).toBe(
      false,
    );
  });
});

describe('occurredAtRangeProblem', () => {
  it('accepts the past up to the limit and a small future margin', () => {
    expect(occurredAtRangeProblem(new Date(NOW.getTime() - 7 * DAY_MS), NOW, 7)).toBeNull();
    expect(occurredAtRangeProblem(new Date(NOW.getTime() + WORK_LOG_MAX_FUTURE_MS), NOW, 7)).toBe(
      null,
    );
  });

  it('refuses older than the limit and further ahead than the margin', () => {
    expect(occurredAtRangeProblem(new Date(NOW.getTime() - 7 * DAY_MS - 1), NOW, 7)).toBe(
      'too_old',
    );
    expect(
      occurredAtRangeProblem(
        new Date(NOW.getTime() + WORK_LOG_MAX_FUTURE_MS + 1).toISOString(),
        NOW,
        7,
      ),
    ).toBe('in_future');
  });
});

describe('work log bodies', () => {
  const create = { clientId: ID, occurredAt: NOW.toISOString() };

  it('declares no photos by default', () => {
    const parsed = createWorkLogSchema.parse(create);
    expect(parsed.attachmentClientIds).toEqual([]);
    expect(parsed.deviceCreatedAt).toBeUndefined();
  });

  it('accepts declared photo clientIds and the device time', () => {
    const parsed = createWorkLogSchema.parse({
      ...create,
      attachmentClientIds: [ID, ID2],
      deviceCreatedAt: '2026-10-25T08:00:00+02:00',
    });
    expect(parsed.attachmentClientIds).toEqual([ID, ID2]);
  });

  it('refuses duplicate, invalid or too many declared clientIds', () => {
    expect(
      createWorkLogSchema.safeParse({ ...create, attachmentClientIds: [ID, ID] }).success,
    ).toBe(false);
    expect(createWorkLogSchema.safeParse({ ...create, attachmentClientIds: ['x'] }).success).toBe(
      false,
    );
    const many = Array.from(
      { length: MAX_DECLARED_ATTACHMENTS + 1 },
      (_, index) => `0190f3a2-7c1e-7000-8000-${String(index).padStart(12, '0')}`,
    );
    expect(createWorkLogSchema.safeParse({ ...create, attachmentClientIds: many }).success).toBe(
      false,
    );
  });

  it('takes expectedVersion on an edit but not as the only field', () => {
    expect(updateWorkLogSchema.safeParse({ expectedVersion: 3, text: 'x' }).success).toBe(true);
    expect(updateWorkLogSchema.safeParse({ expectedVersion: 3 }).success).toBe(false);
    expect(updateWorkLogSchema.safeParse({ expectedVersion: 0, text: 'x' }).success).toBe(false);
    expect(updateWorkLogSchema.safeParse({ text: 'x' }).success).toBe(true);
  });

  it('takes expectedVersion on a status change', () => {
    expect(
      changeWorkLogStatusSchema.safeParse({ status: 'submitted', expectedVersion: 2 }).success,
    ).toBe(true);
    expect(
      changeWorkLogStatusSchema.safeParse({ status: 'submitted', expectedVersion: 'x' }).success,
    ).toBe(false);
  });
});

describe('task status body', () => {
  it('takes an optional expectedVersion', () => {
    expect(changeTaskStatusSchema.safeParse({ status: 'done', expectedVersion: 4 }).success).toBe(
      true,
    );
    expect(changeTaskStatusSchema.safeParse({ status: 'done' }).success).toBe(true);
    expect(changeTaskStatusSchema.safeParse({ status: 'done', expectedVersion: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('attachment upload start', () => {
  it('takes an optional clientId', () => {
    const file = { fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 10 };
    expect(startAttachmentUploadSchema.safeParse({ ...file, clientId: ID }).success).toBe(true);
    expect(startAttachmentUploadSchema.safeParse(file).success).toBe(true);
    expect(startAttachmentUploadSchema.safeParse({ ...file, clientId: 'x' }).success).toBe(false);
  });

  it('answers with a null upload when the photo is already ready', () => {
    const attachment = {
      id: ID,
      organizationId: ID,
      workLogId: ID,
      uploadedById: ID,
      clientId: ID2,
      fileName: 'a.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      status: 'ready',
      width: 1,
      height: 1,
      url: 'https://x.test/a',
      thumbnailUrl: 'https://x.test/t',
      urlsExpireAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
      archivedAt: null,
    };
    expect(startedAttachmentUploadSchema.safeParse({ attachment, upload: null }).success).toBe(
      true,
    );
  });
});

describe('sync pull', () => {
  const empty = { upserts: [], ids: [] };
  const response = {
    serverTime: NOW.toISOString(),
    cursor: 'opaque',
    full: true,
    organization: {
      view: 'summary',
      id: ID,
      name: 'HZ',
      slug: 'hz-demo',
      workLogEditWindowHours: 24,
      offlineMaxBackdateDays: 7,
      timeZone: 'Europe/Istanbul',
    },
    tasks: empty,
    logTypes: empty,
    sites: empty,
    teams: empty,
    workLogs: empty,
    notifications: { upserts: [], ids: [ID] },
  };

  it('parses an empty full pull', () => {
    expect(syncPullResponseSchema.safeParse(response).success).toBe(true);
  });

  it('requires every resource and its id set', () => {
    for (const resource of SYNC_RESOURCES) {
      const { [resource]: _dropped, ...rest } = response;
      expect(syncPullResponseSchema.safeParse(rest).success).toBe(false);
    }
    expect(syncPullResponseSchema.safeParse({ ...response, tasks: { upserts: [] } }).success).toBe(
      false,
    );
  });

  it('takes an optional cursor', () => {
    expect(syncPullQuerySchema.parse({})).toEqual({});
    expect(syncPullQuerySchema.parse({ cursor: 'abc' })).toEqual({ cursor: 'abc' });
    expect(syncPullQuerySchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});
