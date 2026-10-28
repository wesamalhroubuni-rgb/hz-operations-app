import { z } from 'zod';
import { isoDateTimeSchema } from '../common/primitives.js';

// The wire contract of offline sync that is not tied to a resource (ADR-0008): the request
// headers a phone's queue sends with a replayed write, what the API records about them in the
// audit log, and the idempotency rules. Product-neutral: the reusable platform reads these.

/**
 * A client-generated UUID, one per queued write and kept for every retry of it. Honoured on the
 * routes marked idempotent (work-log create, update and status change; task status change): a
 * repeat with the same request replays the stored answer; with a different request it is a 422
 * `idempotency_key_reused`; while the first is still running, a 409 `request_in_progress`.
 * Ignored on every other route.
 */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Response header set to `true` when the answer is a stored replay. */
export const IDEMPOTENT_REPLAYED_HEADER = 'idempotent-replayed';

/** How long the API keeps an idempotency key and its stored answer. */
export const IDEMPOTENCY_RETENTION_DAYS = 14;

/**
 * How long a claimed key blocks a repeat (409 `request_in_progress`) before a repeat may take
 * over, for a first request whose process died before storing its answer.
 */
export const IDEMPOTENCY_LOCK_SECONDS = 60;

/** Sent with value {@link CLIENT_SYNC_OFFLINE} on every write replayed from the offline queue. */
export const CLIENT_SYNC_HEADER = 'x-client-sync';
export const CLIENT_SYNC_OFFLINE = 'offline';

/** The phone's clock (ISO 8601 with offset) when it sent the request. */
export const DEVICE_TIME_HEADER = 'x-device-time';

/** A phone clock this far (in seconds, either way) from the server clock is flagged. */
export const CLOCK_SKEW_FLAG_SECONDS = 300;

export const deviceTimeHeaderSchema = isoDateTimeSchema;

/**
 * Phone clock minus server clock, in whole seconds (positive: the phone is ahead). Null when the
 * device time is missing or not a valid ISO date-time.
 */
export function clockSkewSecondsOf(
  deviceTime: string | null | undefined,
  serverTime: Date,
): number | null {
  if (!deviceTime || !deviceTimeHeaderSchema.safeParse(deviceTime).success) {
    return null;
  }
  return Math.round((Date.parse(deviceTime) - serverTime.getTime()) / 1000);
}

export function isClockSkewFlagged(clockSkewSeconds: number | null): boolean {
  return clockSkewSeconds !== null && Math.abs(clockSkewSeconds) > CLOCK_SKEW_FLAG_SECONDS;
}

/** What a client passes to say a write comes from its offline queue. */
export interface OfflineSyncRequestInfo {
  /** The queue item's idempotency key (a UUID), the same on every retry. */
  idempotencyKey?: string;
  /** The phone's clock now. */
  deviceTime: Date;
}

/** The request headers of a write replayed from the offline queue. */
export function offlineSyncHeaders(info: OfflineSyncRequestInfo): Record<string, string> {
  return {
    [CLIENT_SYNC_HEADER]: CLIENT_SYNC_OFFLINE,
    [DEVICE_TIME_HEADER]: info.deviceTime.toISOString(),
    ...(info.idempotencyKey ? { [IDEMPOTENCY_KEY_HEADER]: info.idempotencyKey } : {}),
  };
}

/**
 * `metadata` of an audit event written by a request sent from the offline queue. The platform
 * fills it from the request headers; it is null for ordinary requests.
 */
export const auditMetadataSchema = z.looseObject({
  via: z.literal('offline_sync'),
  /** The `X-Device-Time` header, or null when it was missing or invalid. */
  deviceTime: isoDateTimeSchema.nullable(),
  /** The server's clock when it received the request. */
  serverTime: isoDateTimeSchema,
  /** {@link clockSkewSecondsOf} of the two. */
  clockSkewSeconds: z.number().int().nullable(),
  /**
   * Body fields the API set to null because their reference was no longer usable by the caller
   * when the queued create arrived (e.g. `taskId` of a task reassigned meanwhile). Absent when
   * nothing was dropped. Written by the domain, not the platform.
   */
  droppedReferences: z.array(z.string()).optional(),
});
export type AuditMetadata = z.infer<typeof auditMetadataSchema>;
