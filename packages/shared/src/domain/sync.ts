import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import { notificationSchema } from '../platform/notifications.js';
import { logTypeSchema } from './log-types.js';
import { organizationSummarySchema } from './organization.js';
import { siteSchema } from './sites.js';
import { taskSchema } from './tasks.js';
import { teamSchema } from './teams.js';
import { workLogSchema } from './work-logs.js';

// GET /sync/pull: what the phone caches for offline work (ADR-0008). One call returns, for the
// signed-in user only and filtered by the same visibility rules as every other read:
//
// - tasks: the non-archived tasks the caller is ASSIGNED to (for a worker, exactly the visible
//   ones), except done or cancelled ones not changed for SYNC_WINDOW_DAYS;
// - logTypes: every non-archived log type of the organization, with its field definitions;
// - sites, teams: the non-archived ones the caller can see;
// - workLogs: the caller's OWN non-archived logs created or occurred within SYNC_WINDOW_DAYS;
// - notifications: the caller's notifications created within SYNC_WINDOW_DAYS;
// - organization: the summary (edit window, backdating limit).
//
// Every resource answers `{ upserts, ids }`:
// - `ids` is ALWAYS the complete set of ids the phone should hold now for that resource (the
//   window above). The phone deletes every cached row whose id is not in it: that covers
//   archived records, records that left the caller's visibility (a reassigned task, a site
//   removed from the scope) and records that aged out of the window, without tombstones.
// - `upserts` holds the full records changed since the cursor (all of them when `full` is true).
//   Log types, sites and teams are small and always sent in full.
// If an id in `ids` is neither cached nor in `upserts` (should not happen), the phone pulls again
// without a cursor.

/** How far back the phone keeps its own logs, notifications and finished tasks, in days. */
export const SYNC_WINDOW_DAYS = 30;

/**
 * The cursor's safety overlap: changes are sent from `cursor time - overlap`, so a transaction
 * that stamped `updatedAt` before the previous pull but committed after it is not missed.
 * Re-sending a few unchanged records is harmless (upserts are idempotent).
 */
export const SYNC_CURSOR_OVERLAP_SECONDS = 60;

/**
 * Opaque to the client: store it and send it back unchanged. (The API encodes the server time
 * of the pull and a fingerprint of the caller's scope; a cursor it cannot read, or one whose
 * scope differs from the caller's current scope, gives a full pull, never an error.)
 */
export const syncCursorSchema = z.string().min(1).max(512);
export type SyncCursor = z.infer<typeof syncCursorSchema>;

/** Query string of GET /sync/pull. No cursor: a full pull. */
export const syncPullQuerySchema = z.object({
  cursor: syncCursorSchema.optional(),
});
export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;

/** One resource of a pull. See the comment at the top of this file. */
export function syncResourceSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    upserts: z.array(item),
    ids: z.array(idSchema),
  });
}
export interface SyncResource<Item> {
  upserts: Item[];
  ids: string[];
}

export const syncPullResponseSchema = z.object({
  /** The server clock when the pull was taken. Show "last refreshed" from the phone's clock. */
  serverTime: isoDateTimeSchema,
  /** Send it with the next pull. */
  cursor: syncCursorSchema,
  /** True when `upserts` hold every record (no cursor, or the cursor could not be used). */
  full: z.boolean(),
  organization: organizationSummarySchema,
  tasks: syncResourceSchema(taskSchema),
  logTypes: syncResourceSchema(logTypeSchema),
  sites: syncResourceSchema(siteSchema),
  teams: syncResourceSchema(teamSchema),
  workLogs: syncResourceSchema(workLogSchema),
  notifications: syncResourceSchema(notificationSchema),
});
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

/** The resource keys of a pull, in the order a client applies them. */
export const SYNC_RESOURCES = [
  'logTypes',
  'sites',
  'teams',
  'tasks',
  'workLogs',
  'notifications',
] as const;
export type SyncResourceName = (typeof SYNC_RESOURCES)[number];

export function syncEndpoints(transport: ApiTransport) {
  return {
    /** GET /sync/pull (policy `sync.pull`): the caller's offline data, changed since `cursor`. */
    pull(query: { cursor?: string } = {}): Promise<ApiResult<SyncPullResponse>> {
      return transport.request({ path: '/sync/pull', query, schema: syncPullResponseSchema });
    },
  };
}
