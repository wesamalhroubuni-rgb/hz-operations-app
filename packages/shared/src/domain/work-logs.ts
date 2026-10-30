import { z } from 'zod';
import type { ApiCallOptions, ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { apiErrorCodeSchema } from '../common/errors.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { customFieldValuesInputSchema, customFieldValuesSchema } from './custom-fields.js';
import { workLogSourceSchema, workLogStatusSchema } from './enums.js';
import { recordHistorySchema, type RecordHistory } from './history.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneFieldBesidesVersion,
  expectedVersionSchema,
  longTextSchema,
  nullableIsoDateTimeSchema,
  searchQuerySchema,
  uniqueIdListSchema,
  type ListQueryParams,
} from './shared.js';
import { latitudeSchema, longitudeSchema } from './sites.js';

/**
 * How far ahead of the server clock `occurredAt` may be. Work happens in the past; the margin
 * only absorbs a phone clock that runs fast. A log further ahead is refused with 422
 * `occurred_at_out_of_range` (ADR-0008 keeps one hour rather than a few minutes: a phone with a
 * wrong clock would otherwise lose every offline log; the skew is flagged instead).
 */
export const WORK_LOG_MAX_FUTURE_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why `occurredAt` is outside the accepted range, or null when it is inside: not more than
 * `maxBackdateDays` (the organization's `offlineMaxBackdateDays`) before `now` and not more than
 * {@link WORK_LOG_MAX_FUTURE_MS} after it. The API checks it with its own clock on create and when
 * an edit changes `occurredAt`; the phone checks it before queueing so the worker is told at once.
 */
export function occurredAtRangeProblem(
  occurredAt: string | Date,
  now: Date,
  maxBackdateDays: number,
): 'too_old' | 'in_future' | null {
  const time = occurredAt instanceof Date ? occurredAt.getTime() : Date.parse(occurredAt);
  if (time > now.getTime() + WORK_LOG_MAX_FUTURE_MS) {
    return 'in_future';
  }
  if (time < now.getTime() - maxBackdateDays * DAY_MS) {
    return 'too_old';
  }
  return null;
}

/**
 * Most attachment clientIds a create request may declare. Equal to the API's limit of
 * attachments per work log (`MAX_ATTACHMENTS_PER_WORK_LOG`).
 */
export const MAX_DECLARED_ATTACHMENTS = 20;

/**
 * How long after a log reached the server (`createdAt`) its author may still upload the photos
 * declared in its create request, whatever the edit window and the log's status (ADR-0008).
 */
export const DECLARED_ATTACHMENT_GRACE_DAYS = 30;

/** GPS position of a work log. Latitude and longitude always come together. */
export const workLogLocationSchema = z.strictObject({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
  /** Accuracy radius in metres. */
  accuracy: z.number().min(0).nullable().optional(),
});
export type WorkLogLocationInput = z.infer<typeof workLogLocationSchema>;

/**
 * A worker's entry. `occurredAt` is when the work happened, `createdAt` when the server stored
 * it. `clientId` is generated on the device and makes creation idempotent.
 */
export const workLogSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  clientId: idSchema,
  authorId: idSchema,
  occurredAt: isoDateTimeSchema,
  taskId: idSchema.nullable(),
  siteId: idSchema.nullable(),
  teamId: idSchema.nullable(),
  logTypeId: idSchema.nullable(),
  /** Version of the log type the custom fields were validated against. */
  logTypeVersion: z.number().int().nullable(),
  text: z.string().nullable(),
  customFields: customFieldValuesSchema,
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      accuracy: z.number().nullable(),
    })
    .nullable(),
  status: workLogStatusSchema,
  /** The last approval or rejection: who, when, and the note (the rejection reason). */
  review: z
    .object({
      reviewedById: idSchema,
      reviewedAt: isoDateTimeSchema,
      note: z.string().nullable(),
    })
    .nullable(),
  source: workLogSourceSchema,
  /** Reserved for AI-derived data. Always null today. */
  aiMetadata: z.record(z.string(), z.unknown()).nullable(),
  /** Optimistic-concurrency counter: send it back as `expectedVersion` (ADR-0008). */
  version: z.number().int().min(1),
  /** Sent by the phone's offline queue (`X-Client-Sync: offline` on the create request). */
  submittedOffline: z.boolean(),
  /** The phone's clock when the worker saved the log, as the phone reported it. */
  deviceCreatedAt: nullableIsoDateTimeSchema,
  /** Phone clock minus server clock at create, in seconds; null when unknown. */
  clockSkewSeconds: z.number().int().nullable(),
  /** True when |clockSkewSeconds| > CLOCK_SKEW_FLAG_SECONDS: the phone's times are doubtful. */
  clockSkewFlagged: z.boolean(),
  /** The photo clientIds declared at create: the "original submission" (ADR-0008). */
  declaredAttachmentClientIds: z.array(idSchema),
  /**
   * Ready, non-archived photos (Phase 6). Set by `GET /work-logs` and `GET /work-logs/:id`;
   * absent from write answers and from `/sync/pull`.
   */
  attachmentCount: z.number().int().min(0).optional(),
  /** When the server stored the log (its receive time; the edit window counts from it). */
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type WorkLog = z.infer<typeof workLogSchema>;

/** The statuses a log may be created with. `approved` and `rejected` are set by a reviewer. */
export const WORK_LOG_CREATE_STATUSES = ['draft', 'submitted'] as const;

/**
 * `clientId` is a UUID generated on the device: sending the same one again returns the log that
 * already exists (HTTP 200 instead of 201) and changes nothing; the same `clientId` sent by
 * another user is a conflict (409). The author is always the signed-in user: `authorId` is not
 * accepted. `customFields` is validated against the log type; without a log type it must be
 * empty.
 *
 * Phase 5 (ADR-0008): `occurredAt` must pass {@link occurredAtRangeProblem} with the
 * organization's `offlineMaxBackdateDays` (else 422 `occurred_at_out_of_range`).
 * `attachmentClientIds` declares the clientIds of the photos that belong to this submission
 * (stored as `declaredAttachmentClientIds`); only those may be uploaded after the edit window.
 * `deviceCreatedAt` is the phone's clock when the worker saved the log (informative).
 */
export const createWorkLogSchema = z.strictObject({
  clientId: idSchema,
  occurredAt: isoDateTimeSchema,
  attachmentClientIds: uniqueIdListSchema(MAX_DECLARED_ATTACHMENTS).default([]),
  deviceCreatedAt: isoDateTimeSchema.optional(),
  taskId: idSchema.nullable().optional(),
  siteId: idSchema.nullable().optional(),
  teamId: idSchema.nullable().optional(),
  logTypeId: idSchema.nullable().optional(),
  text: longTextSchema.nullable().optional(),
  customFields: customFieldValuesInputSchema.default({}),
  location: workLogLocationSchema.nullable().optional(),
  status: z.enum(WORK_LOG_CREATE_STATUSES).default('submitted'),
  source: workLogSourceSchema.default('manual'),
  /** Reserved for the AI phases; only null is accepted today. */
  aiMetadata: z.null().optional(),
});
export type CreateWorkLog = z.infer<typeof createWorkLogSchema>;
export type CreateWorkLogInput = z.input<typeof createWorkLogSchema>;

/**
 * A field left out is unchanged; `null` clears it. When `logTypeId` or `customFields` is sent,
 * the resulting custom fields are validated again against the current log type definition.
 * `expectedVersion` (optional) is the optimistic-concurrency check; it does not count as a field.
 */
export const updateWorkLogSchema = z
  .strictObject({
    expectedVersion: expectedVersionSchema.optional(),
    occurredAt: isoDateTimeSchema.optional(),
    taskId: idSchema.nullable().optional(),
    siteId: idSchema.nullable().optional(),
    teamId: idSchema.nullable().optional(),
    logTypeId: idSchema.nullable().optional(),
    text: longTextSchema.nullable().optional(),
    customFields: customFieldValuesInputSchema.optional(),
    location: workLogLocationSchema.nullable().optional(),
  })
  .refine(atLeastOneFieldBesidesVersion, AT_LEAST_ONE_FIELD);
export type UpdateWorkLog = z.infer<typeof updateWorkLogSchema>;

/**
 * Who may make which move is decided by the API: the author moves a log between `draft` and
 * `submitted` and resubmits a rejected one; a reviewer approves, rejects and reopens.
 */
export const WORK_LOG_REVIEW_NOTE_MAX_LENGTH = 2000;

/**
 * A status change. `note` is the reviewer's note: required when rejecting (it is the rejection
 * reason the author sees), optional when approving, not accepted otherwise.
 */
export const changeWorkLogStatusSchema = z
  .strictObject({
    /** Optimistic-concurrency check (ADR-0008). Setting the status the log already has is a no-op. */
    expectedVersion: expectedVersionSchema.optional(),
    status: workLogStatusSchema,
    note: z.string().trim().min(1).max(WORK_LOG_REVIEW_NOTE_MAX_LENGTH).optional(),
  })
  .refine((body) => body.status !== 'rejected' || body.note !== undefined, {
    path: ['note'],
    error: 'is required when rejecting a log',
  })
  .refine(
    (body) => body.note === undefined || body.status === 'approved' || body.status === 'rejected',
    { path: ['note'], error: 'is only accepted when approving or rejecting' },
  );
export type ChangeWorkLogStatus = z.infer<typeof changeWorkLogStatusSchema>;

export const WORK_LOG_SORT_FIELDS = ['occurredAt', 'createdAt', 'updatedAt', 'status'] as const;

/**
 * The filters that the work-log list, the map, the CSV export and the dashboard links share
 * (Phase 6, ADR-0009). Each is a query parameter of the same name, and the dashboard's page URLs
 * use the same names, so a filtered view is a shareable link and opens as an export unchanged.
 * Every filter only NARROWS the caller's visibility (ADR-0005). `occurredFrom` is inclusive,
 * `occurredTo` exclusive (build them from calendar days with `zonedDaysRange` in the
 * organization's time zone).
 *
 * Phase 6 added `search` (case-insensitive match on the log text) and `hasPhotos` (true: at
 * least one ready, non-archived attachment; false: none).
 */
export const workLogFilterShape = {
  authorId: idSchema.optional(),
  siteId: idSchema.optional(),
  teamId: idSchema.optional(),
  taskId: idSchema.optional(),
  logTypeId: idSchema.optional(),
  status: workLogStatusSchema.optional(),
  source: workLogSourceSchema.optional(),
  occurredFrom: isoDateTimeSchema.optional(),
  occurredTo: isoDateTimeSchema.optional(),
  search: searchQuerySchema,
  hasPhotos: queryBooleanSchema.optional(),
  /**
   * True: leave out the caller's own logs (the review queue: a reviewer never approves their
   * own). False or absent: no effect. Used by the overview's "awaiting approval" link.
   */
  excludeOwn: queryBooleanSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
};

export type WorkLogFilterKey = keyof typeof workLogFilterShape;
/** The filter parameter names. */
export const WORK_LOG_FILTER_KEYS = Object.keys(workLogFilterShape) as WorkLogFilterKey[];

/** `sort` of the work-log list and export: `occurredAt:desc` by default. */
export const workLogSortSchema = sortQuerySchema(WORK_LOG_SORT_FIELDS, {
  field: 'occurredAt',
  direction: 'desc',
});

export const listWorkLogsQuerySchema = paginationQuerySchema.extend({
  sort: workLogSortSchema,
  ...workLogFilterShape,
});
export type ListWorkLogsQuery = z.infer<typeof listWorkLogsQuerySchema>;

export const workLogListSchema = paginatedSchema(workLogSchema);

// ---------------------------------------------------------------------------
// Bulk review (Phase 6): POST /work-logs/bulk-status [work_log.review]
// ---------------------------------------------------------------------------

export const BULK_REVIEW_MAX_ITEMS = 100;
export const BULK_REVIEW_STATUSES = ['approved', 'rejected'] as const;

/**
 * Approve or reject many logs at once. Each item is processed on its own, exactly as
 * `PATCH /work-logs/:id/status` would process it (same rules, its own transaction, its own audit
 * event and notification), so one refusal never undoes another item. Never self-approval: the
 * caller's own logs are refused per item (403). `note` is required when rejecting and applies to
 * every item.
 */
export const bulkWorkLogStatusSchema = z
  .strictObject({
    status: z.enum(BULK_REVIEW_STATUSES),
    note: z.string().trim().min(1).max(WORK_LOG_REVIEW_NOTE_MAX_LENGTH).optional(),
    items: z
      .array(
        z.strictObject({
          id: idSchema,
          expectedVersion: expectedVersionSchema.optional(),
        }),
      )
      .min(1)
      .max(BULK_REVIEW_MAX_ITEMS)
      .refine((items) => new Set(items.map((item) => item.id)).size === items.length, {
        error: 'must not contain the same log twice',
      }),
  })
  .refine((body) => body.status !== 'rejected' || body.note !== undefined, {
    path: ['note'],
    error: 'is required when rejecting logs',
  });
export type BulkWorkLogStatus = z.infer<typeof bulkWorkLogStatusSchema>;
export type BulkWorkLogStatusInput = z.input<typeof bulkWorkLogStatusSchema>;

/** One item's outcome: the log as it is now, or the error the single call would have given. */
export const bulkWorkLogStatusItemResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), id: idSchema, workLog: workLogSchema }),
  z.object({
    ok: z.literal(false),
    id: idSchema,
    error: z.object({
      statusCode: z.number().int(),
      code: apiErrorCodeSchema,
      message: z.string(),
    }),
  }),
]);
export type BulkWorkLogStatusItemResult = z.infer<typeof bulkWorkLogStatusItemResultSchema>;

/** HTTP 200 once the body is valid, even when every item failed. Results keep the item order. */
export const bulkWorkLogStatusResultSchema = z.object({
  results: z.array(bulkWorkLogStatusItemResultSchema),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type BulkWorkLogStatusResult = z.infer<typeof bulkWorkLogStatusResultSchema>;

// ---------------------------------------------------------------------------
// Map (Phase 6): GET /work-logs/map [work_log.read]
// ---------------------------------------------------------------------------

export const WORK_LOG_MAP_DEFAULT_LIMIT = 500;
export const WORK_LOG_MAP_MAX_LIMIT = 1000;
/** Without `occurredFrom`, the map covers the last this many days (up to `occurredTo` or now). */
export const WORK_LOG_MAP_DEFAULT_DAYS = 7;
/** Length of the text excerpt in map points and report rows. */
export const WORK_LOG_EXCERPT_LENGTH = 140;

/**
 * The visible logs WITH a location, newest `occurredAt` first, capped at `limit`. The same
 * filters as the list.
 */
export const workLogMapQuerySchema = z.object({
  ...workLogFilterShape,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORK_LOG_MAP_MAX_LIMIT)
    .default(WORK_LOG_MAP_DEFAULT_LIMIT),
});
export type WorkLogMapQuery = z.infer<typeof workLogMapQuerySchema>;

export const workLogMapPointSchema = z.object({
  id: idSchema,
  authorId: idSchema,
  occurredAt: isoDateTimeSchema,
  status: workLogStatusSchema,
  siteId: idSchema.nullable(),
  teamId: idSchema.nullable(),
  logTypeId: idSchema.nullable(),
  latitude: z.number(),
  longitude: z.number(),
  accuracy: z.number().nullable(),
  /** The first `WORK_LOG_EXCERPT_LENGTH` characters of the text, or null. */
  excerpt: z.string().nullable(),
  /** Ready, non-archived photos. */
  attachmentCount: z.number().int().min(0),
});
export type WorkLogMapPoint = z.infer<typeof workLogMapPointSchema>;

export const workLogMapSchema = z.object({
  items: z.array(workLogMapPointSchema),
  /** Matching logs with a location, before the cap. */
  total: z.number().int().min(0),
  truncated: z.boolean(),
  /** The range actually used (the default range when none was asked for). */
  occurredFrom: isoDateTimeSchema,
  occurredTo: isoDateTimeSchema,
});
export type WorkLogMap = z.infer<typeof workLogMapSchema>;

// ---------------------------------------------------------------------------
// History (Phase 6): GET /work-logs/:id/history [work_log.read]
// ---------------------------------------------------------------------------

/**
 * The fields of a work log whose changes the history shows. Every other field of the audit
 * record (organization id, client id, AI metadata, version, offline metadata) is left out.
 */
export const WORK_LOG_HISTORY_FIELDS = [
  'status',
  'review',
  'occurredAt',
  'text',
  'customFields',
  'location',
  'taskId',
  'siteId',
  'teamId',
  'logTypeId',
  'archivedAt',
] as const;

export function workLogsEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listWorkLogsQuerySchema> = {},
    ): Promise<ApiResult<Paginated<WorkLog>>> {
      return transport.request({ path: '/work-logs', query, schema: workLogListSchema });
    },
    get(id: string): Promise<ApiResult<WorkLog>> {
      return transport.request({ path: `/work-logs/${id}`, schema: workLogSchema });
    },
    /**
     * Resolves with status 201 for a new log and 200 when the `clientId` already existed.
     * `options.headers`: the offline queue's `offlineSyncHeaders(...)`.
     */
    create(body: CreateWorkLogInput, options: ApiCallOptions = {}): Promise<ApiResult<WorkLog>> {
      return transport.request({
        method: 'POST',
        path: '/work-logs',
        body,
        headers: options.headers,
        schema: workLogSchema,
      });
    },
    update(
      id: string,
      body: UpdateWorkLog,
      options: ApiCallOptions = {},
    ): Promise<ApiResult<WorkLog>> {
      return transport.request({
        method: 'PATCH',
        path: `/work-logs/${id}`,
        body,
        headers: options.headers,
        schema: workLogSchema,
      });
    },
    changeStatus(
      id: string,
      body: ChangeWorkLogStatus,
      options: ApiCallOptions = {},
    ): Promise<ApiResult<WorkLog>> {
      return transport.request({
        method: 'PATCH',
        path: `/work-logs/${id}/status`,
        body,
        headers: options.headers,
        schema: workLogSchema,
      });
    },
    archive(id: string): Promise<ApiResult<WorkLog>> {
      return transport.request({
        method: 'POST',
        path: `/work-logs/${id}/archive`,
        schema: workLogSchema,
      });
    },
    /** Phase 6. Approve or reject many logs; per-item results (see `bulkWorkLogStatusSchema`). */
    bulkChangeStatus(body: BulkWorkLogStatusInput): Promise<ApiResult<BulkWorkLogStatusResult>> {
      return transport.request({
        method: 'POST',
        path: '/work-logs/bulk-status',
        body,
        schema: bulkWorkLogStatusResultSchema,
      });
    },
    /** Phase 6. Located logs for the map. */
    map(query: ListQueryParams<typeof workLogMapQuerySchema> = {}): Promise<ApiResult<WorkLogMap>> {
      return transport.request({ path: '/work-logs/map', query, schema: workLogMapSchema });
    },
    /** Phase 6. The log's audit trail (and its photos'), oldest first, role-shaped. */
    history(id: string): Promise<ApiResult<RecordHistory>> {
      return transport.request({
        path: `/work-logs/${id}/history`,
        schema: recordHistorySchema,
      });
    },
  };
}
