import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';

/**
 * Position of an event in the outbox: a 64-bit integer sent as a decimal string, because a JSON
 * number cannot hold it exactly.
 */
export const outboxSequenceSchema = z
  .string()
  .regex(/^\d{1,19}$/, 'must be a whole number')
  // The refinement also runs when the pattern above failed, so it must not assume digits.
  .refine((value) => !/^\d+$/.test(value) || BigInt(value) <= 9223372036854775807n, {
    error: 'must fit in a signed 64-bit integer',
  });

/** One domain event, as returned by the API. */
export const outboxEventSchema = z.object({
  id: idSchema,
  /** Consumer cursor. Strictly increasing; compare numerically, not as text. */
  sequence: outboxSequenceSchema,
  organizationId: idSchema.nullable(),
  /** Dotted event name: `<aggregate>.<past-tense verb>`, for example `task.status_changed`. */
  eventType: z.string(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  payload: z.unknown(),
  actorId: z.string().nullable(),
  /** The `x-request-id` of the request that caused the event. */
  correlationId: z.string().nullable(),
  occurredAt: isoDateTimeSchema,
  /** Set once a consumer has handled the event; null until then. */
  processedAt: isoDateTimeSchema.nullable(),
});
export type OutboxEvent = z.infer<typeof outboxEventSchema>;

export const OUTBOX_EVENT_SORT_FIELDS = ['sequence', 'occurredAt'] as const;

/**
 * Query string of `GET /outbox-events`. `eventType` matches exactly, or as a prefix when it ends
 * with a dot or an asterisk (`task.` and `task.*` both match every task event).
 */
export const listOutboxEventsQuerySchema = paginationQuerySchema.extend({
  eventType: z.string().trim().min(1).max(100).optional(),
  aggregateType: z.string().trim().min(1).max(100).optional(),
  aggregateId: z.string().trim().min(1).max(100).optional(),
  /** Cursor: only events with a sequence greater than this one. */
  afterSequence: outboxSequenceSchema.optional(),
  /** Inclusive lower bound on `occurredAt`. */
  from: isoDateTimeSchema.optional(),
  /** Exclusive upper bound on `occurredAt`. */
  to: isoDateTimeSchema.optional(),
  /** true: only handled events; false: only events still waiting. */
  processed: queryBooleanSchema.optional(),
  sort: sortQuerySchema(OUTBOX_EVENT_SORT_FIELDS, { field: 'sequence', direction: 'asc' }),
});
export type ListOutboxEventsQuery = z.infer<typeof listOutboxEventsQuerySchema>;

export const outboxEventListSchema = paginatedSchema(outboxEventSchema);

/** What a client passes to list outbox events (the wire form of `ListOutboxEventsQuery`). */
export interface ListOutboxEventsParams {
  page?: number;
  pageSize?: number;
  eventType?: string;
  aggregateType?: string;
  aggregateId?: string;
  afterSequence?: string;
  from?: string;
  to?: string;
  processed?: boolean;
  /** `sequence:asc` (default), `sequence:desc`, `occurredAt:asc` or `occurredAt:desc`. */
  sort?: string;
}

/** Read-only client for the event outbox. Internal and testing use. */
export function outboxEventsEndpoints(transport: ApiTransport) {
  return {
    /** GET /outbox-events */
    list(params: ListOutboxEventsParams = {}): Promise<ApiResult<Paginated<OutboxEvent>>> {
      return transport.request({
        path: '/outbox-events',
        query: { ...params },
        schema: outboxEventListSchema,
      });
    },
    /** GET /outbox-events/:id */
    get(id: string): Promise<ApiResult<OutboxEvent>> {
      return transport.request({
        path: `/outbox-events/${encodeURIComponent(id)}`,
        schema: outboxEventSchema,
      });
    },
  };
}
