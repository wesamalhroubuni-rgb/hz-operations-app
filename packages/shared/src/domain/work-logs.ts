import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { customFieldValuesInputSchema, customFieldValuesSchema } from './custom-fields.js';
import { workLogSourceSchema, workLogStatusSchema } from './enums.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  longTextSchema,
  nullableIsoDateTimeSchema,
  type ListQueryParams,
} from './shared.js';
import { latitudeSchema, longitudeSchema } from './sites.js';

/**
 * How far ahead of the server clock `occurredAt` may be. Work happens in the past; the margin
 * only absorbs a phone clock that runs fast.
 */
export const WORK_LOG_MAX_FUTURE_MS = 60 * 60 * 1000;

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
 */
export const createWorkLogSchema = z.strictObject({
  clientId: idSchema,
  occurredAt: isoDateTimeSchema,
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
 */
export const updateWorkLogSchema = z
  .strictObject({
    occurredAt: isoDateTimeSchema.optional(),
    taskId: idSchema.nullable().optional(),
    siteId: idSchema.nullable().optional(),
    teamId: idSchema.nullable().optional(),
    logTypeId: idSchema.nullable().optional(),
    text: longTextSchema.nullable().optional(),
    customFields: customFieldValuesInputSchema.optional(),
    location: workLogLocationSchema.nullable().optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
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

export const WORK_LOG_SORT_FIELDS = ['occurredAt', 'createdAt'] as const;

/** `occurredFrom` is inclusive, `occurredTo` is exclusive. */
export const listWorkLogsQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(WORK_LOG_SORT_FIELDS, { field: 'occurredAt', direction: 'desc' }),
  authorId: idSchema.optional(),
  siteId: idSchema.optional(),
  teamId: idSchema.optional(),
  taskId: idSchema.optional(),
  logTypeId: idSchema.optional(),
  status: workLogStatusSchema.optional(),
  source: workLogSourceSchema.optional(),
  occurredFrom: isoDateTimeSchema.optional(),
  occurredTo: isoDateTimeSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
});
export type ListWorkLogsQuery = z.infer<typeof listWorkLogsQuerySchema>;

export const workLogListSchema = paginatedSchema(workLogSchema);

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
    /** Resolves with status 201 for a new log and 200 when the `clientId` already existed. */
    create(body: CreateWorkLogInput): Promise<ApiResult<WorkLog>> {
      return transport.request({
        method: 'POST',
        path: '/work-logs',
        body,
        schema: workLogSchema,
      });
    },
    update(id: string, body: UpdateWorkLog): Promise<ApiResult<WorkLog>> {
      return transport.request({
        method: 'PATCH',
        path: `/work-logs/${id}`,
        body,
        schema: workLogSchema,
      });
    },
    changeStatus(id: string, body: ChangeWorkLogStatus): Promise<ApiResult<WorkLog>> {
      return transport.request({
        method: 'PATCH',
        path: `/work-logs/${id}/status`,
        body,
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
  };
}
