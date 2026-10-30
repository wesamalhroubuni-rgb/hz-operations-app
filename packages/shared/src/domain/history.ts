import { z } from 'zod';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import { auditActorTypeSchema, auditFieldChangeSchema } from '../platform/audit.js';

// The history of one record (Phase 6, ADR-0009): `GET /work-logs/:id/history` and
// `GET /tasks/:id/history`. Built by the API from the audit log, for whoever can see the record
// (404 otherwise, the same as `GET /work-logs/:id`), so it works for supervisors and managers
// without the admin-only `audit.read`. It is ROLE-SHAPED and REDACTED:
//
// - only the audit events of that record (for a work log also its attachments' events), oldest
//   first, at most `RECORD_HISTORY_LIMIT`;
// - `changes` holds only the fields of `WORK_LOG_HISTORY_FIELDS` / `TASK_HISTORY_FIELDS`, as
//   stored (the audit log already redacts sensitive keys); never `before` / `after` in full,
//   never the correlation id, never device or clock metadata beyond the `offline` flag;
// - `actorName` is the display name of the acting user when the caller may see that user, else
//   null (the client shows "Someone"); `actorId` is null for the system.

export const RECORD_HISTORY_LIMIT = 200;

export const recordHistoryEntrySchema = z.object({
  /** The audit event's id. */
  id: idSchema,
  /** Dotted action, e.g. `work_log.status_changed`, `attachment.completed`, `task.created`. */
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  occurredAt: isoDateTimeSchema,
  actorType: auditActorTypeSchema,
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  /** Changed fields among the allowed ones; null on create and when none of them changed. */
  changes: z.record(z.string(), auditFieldChangeSchema).nullable(),
  /** True when the change came from a phone's offline queue. */
  offline: z.boolean(),
});
export type RecordHistoryEntry = z.infer<typeof recordHistoryEntrySchema>;

export const recordHistorySchema = z.object({
  items: z.array(recordHistoryEntrySchema),
  /** True when the record has more than `RECORD_HISTORY_LIMIT` events (the oldest are kept). */
  truncated: z.boolean(),
});
export type RecordHistory = z.infer<typeof recordHistorySchema>;
