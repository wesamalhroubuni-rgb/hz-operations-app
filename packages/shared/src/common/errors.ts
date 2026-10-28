import { z } from 'zod';

/**
 * Machine-readable error codes. Clients branch on `code`, never on `message`.
 *
 * The first nine are generic, one per HTTP status. The rest (Phase 5, ADR-0008) are specific
 * reasons a client must tell apart, mostly when the offline queue replays a write the server
 * now refuses; each has exactly one status, listed in {@link API_ERROR_STATUS}.
 */
export const API_ERROR_CODES = [
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'unprocessable',
  'rate_limited',
  'service_unavailable',
  'internal_error',
  // Phase 5 (ADR-0008)
  'version_conflict',
  'edit_window_closed',
  'already_reviewed',
  'record_archived',
  'task_not_assigned',
  'task_cancelled',
  'occurred_at_out_of_range',
  'attachment_not_declared',
  'idempotency_key_reused',
  'request_in_progress',
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/**
 * The HTTP status of every code. The API never sends a code with another status.
 *
 * - `version_conflict` (409): `expectedVersion` differs from the record's current version
 *   (somebody else changed it since the client last read it).
 * - `edit_window_closed` (403): the author's edit window of the work log has passed (also for
 *   a late photo that is not part of the original submission once its grace period is over).
 * - `already_reviewed` (409): the work log was approved; its author can no longer change it.
 * - `record_archived` (409): the work log, task or attachment is archived.
 * - `task_not_assigned` (403): the caller sees the task but is neither an assignee nor its
 *   manager. (A worker who was unassigned no longer sees the task at all: `not_found`.)
 * - `task_cancelled` (409): an assignee tried to change a cancelled task.
 * - `occurred_at_out_of_range` (422): `occurredAt` is older than the organization's
 *   `offlineMaxBackdateDays` or more than `WORK_LOG_MAX_FUTURE_MS` ahead of the server clock.
 * - `attachment_not_declared` (403): a photo for a log whose edit window has passed, whose
 *   clientId was not declared in the log's create request.
 * - `idempotency_key_reused` (422): an `Idempotency-Key` sent again with a different request.
 * - `request_in_progress` (409): the first request with this `Idempotency-Key` is still running.
 *   The only one of these codes worth retrying as it is.
 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  rate_limited: 429,
  service_unavailable: 503,
  internal_error: 500,
  version_conflict: 409,
  edit_window_closed: 403,
  already_reviewed: 409,
  record_archived: 409,
  task_not_assigned: 403,
  task_cancelled: 409,
  occurred_at_out_of_range: 422,
  attachment_not_declared: 403,
  idempotency_key_reused: 422,
  request_in_progress: 409,
};

/**
 * Codes after which the same request may succeed later without any change: try again with
 * backoff. Every other code is final for that request (a queued write becomes
 * `failed_permanent`), except `unauthenticated`, which means "sign in again, then retry".
 */
export const RETRYABLE_API_ERROR_CODES: readonly ApiErrorCode[] = [
  'rate_limited',
  'service_unavailable',
  'internal_error',
  'request_in_progress',
];

export function isRetryableApiErrorCode(code: ApiErrorCode): boolean {
  return RETRYABLE_API_ERROR_CODES.includes(code);
}

/** One problem with one part of the input. `path` is dotted, for example `customFields.quantity`. */
export const apiErrorDetailSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;

/** Body of every non-2xx response of the API (except GET /health, which keeps its own shape). */
export const apiErrorSchema = z.object({
  statusCode: z.number().int(),
  code: apiErrorCodeSchema,
  message: z.string(),
  details: z.array(apiErrorDetailSchema).optional(),
  /** Identifier of the request, also sent as the `x-request-id` response header. */
  correlationId: z.string().nullable(),
  timestamp: z.iso.datetime(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
