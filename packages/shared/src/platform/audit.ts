import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';

/** Who caused an audited change: a signed-in user, or the system itself (seed, background job). */
export const AUDIT_ACTOR_TYPES = ['user', 'system'] as const;
export const auditActorTypeSchema = z.enum(AUDIT_ACTOR_TYPES);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

/** Value written in place of a sensitive field (password, token, secret) in an audit event. */
export const AUDIT_REDACTED = '[redacted]';

/** One changed top-level field of the audited record. */
export const auditFieldChangeSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
});
export type AuditFieldChange = z.infer<typeof auditFieldChangeSchema>;

/** One row of the append-only audit log, as returned by the API. */
export const auditEventSchema = z.object({
  id: idSchema,
  organizationId: idSchema.nullable(),
  actorType: auditActorTypeSchema,
  /** The acting user's id; null when `actorType` is `system`. */
  actorId: z.string().nullable(),
  /** Dotted action name: `<entity>.<past-tense verb>`, for example `task.created`. */
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  /** The record before the change; null on create. */
  before: z.unknown(),
  /** The record after the change; null when the record is gone. */
  after: z.unknown(),
  /** `{ field: { from, to } }` for every top-level field that differs; null when not comparable. */
  changes: z.record(z.string(), auditFieldChangeSchema).nullable(),
  /** The `x-request-id` of the request that caused the change. */
  correlationId: z.string().nullable(),
  occurredAt: isoDateTimeSchema,
});
export type AuditEvent = z.infer<typeof auditEventSchema>;

export const AUDIT_EVENT_SORT_FIELDS = ['occurredAt'] as const;

/**
 * Query string of `GET /audit-events`. `action` matches exactly, or as a prefix when it ends with
 * a dot or an asterisk (`task.` and `task.*` both match every task action).
 */
export const listAuditEventsQuerySchema = paginationQuerySchema.extend({
  entityType: z.string().trim().min(1).max(100).optional(),
  entityId: z.string().trim().min(1).max(100).optional(),
  actorId: z.string().trim().min(1).max(100).optional(),
  action: z.string().trim().min(1).max(100).optional(),
  correlationId: z.string().trim().min(1).max(100).optional(),
  /** Inclusive lower bound on `occurredAt`. */
  from: isoDateTimeSchema.optional(),
  /** Exclusive upper bound on `occurredAt`. */
  to: isoDateTimeSchema.optional(),
  sort: sortQuerySchema(AUDIT_EVENT_SORT_FIELDS, { field: 'occurredAt', direction: 'desc' }),
});
export type ListAuditEventsQuery = z.infer<typeof listAuditEventsQuerySchema>;

export const auditEventListSchema = paginatedSchema(auditEventSchema);

/** What a client passes to list audit events (the wire form of `ListAuditEventsQuery`). */
export interface ListAuditEventsParams {
  page?: number;
  pageSize?: number;
  entityType?: string;
  entityId?: string;
  actorId?: string;
  action?: string;
  correlationId?: string;
  from?: string;
  to?: string;
  /** `occurredAt:asc` or `occurredAt:desc` (default). */
  sort?: string;
}

/** Read-only client for the audit log. There are no write endpoints by design. */
export function auditEventsEndpoints(transport: ApiTransport) {
  return {
    /** GET /audit-events */
    list(params: ListAuditEventsParams = {}): Promise<ApiResult<Paginated<AuditEvent>>> {
      return transport.request({
        path: '/audit-events',
        query: { ...params },
        schema: auditEventListSchema,
      });
    },
    /** GET /audit-events/:id */
    get(id: string): Promise<ApiResult<AuditEvent>> {
      return transport.request({
        path: `/audit-events/${encodeURIComponent(id)}`,
        schema: auditEventSchema,
      });
    },
  };
}
