import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { taskFilterShape, taskSortSchema } from './tasks.js';
import type { ListQueryParams } from './shared.js';
import { workLogFilterShape, workLogSortSchema } from './work-logs.js';

// CSV exports (Phase 6, ADR-0009):
//   GET /exports/work-logs.csv [export.work_logs]
//   GET /exports/tasks.csv     [export.tasks]
//
// The same filters (and sort) as the lists, applied INSIDE the caller's visibility, so an export
// never holds a row the caller's list would not show. The answer is `text/csv; charset=utf-8`
// with a UTF-8 BOM and `Content-Disposition: attachment; filename="work-logs-<day>.csv"`, written
// with `toCsv` (formula-injection safe). Times are in the organization's time zone
// (`formatSortableInTimeZone`), plus a UTC column. More than `EXPORT_MAX_ROWS` matching rows is
// 422 `export_too_large` (narrow the filters). Every export is audited (action
// `export.work_logs` / `export.tasks`, entity type `export`, the filters and the row count in
// `after`; audit only, no outbox event), including an export of zero rows.

export const EXPORT_MAX_ROWS = 10_000;
export const EXPORT_TIMEOUT_MS = 60_000;

export const exportWorkLogsQuerySchema = z.object({
  sort: workLogSortSchema,
  ...workLogFilterShape,
});
export type ExportWorkLogsQuery = z.infer<typeof exportWorkLogsQuerySchema>;

export const exportTasksQuerySchema = z.object({ sort: taskSortSchema, ...taskFilterShape });
export type ExportTasksQuery = z.infer<typeof exportTasksQuerySchema>;

/**
 * Columns of the work-log export, in order. Header line = these English labels (exports are not
 * localised yet). `*Local` columns are in the organization's time zone, named in `timeZone`.
 * `customFields` is the values as JSON text; names are resolved through the caller's visibility
 * (an invisible name is empty).
 */
export const WORK_LOG_EXPORT_COLUMNS = [
  ['id', 'ID'],
  ['occurredAtLocal', 'Occurred at'],
  ['timeZone', 'Time zone'],
  ['occurredAtUtc', 'Occurred at (UTC)'],
  ['status', 'Status'],
  ['author', 'Worker'],
  ['site', 'Site'],
  ['team', 'Team'],
  ['logType', 'Log type'],
  ['task', 'Task'],
  ['text', 'Text'],
  ['customFields', 'Custom fields'],
  ['photoCount', 'Photos'],
  ['latitude', 'Latitude'],
  ['longitude', 'Longitude'],
  ['accuracyMeters', 'Accuracy (m)'],
  ['reviewedBy', 'Reviewed by'],
  ['reviewedAtLocal', 'Reviewed at'],
  ['reviewNote', 'Review note'],
  ['submittedOffline', 'Sent offline'],
  ['createdAtUtc', 'Received at (UTC)'],
] as const;

/** Columns of the task export, in order (see {@link WORK_LOG_EXPORT_COLUMNS}). */
export const TASK_EXPORT_COLUMNS = [
  ['id', 'ID'],
  ['title', 'Title'],
  ['status', 'Status'],
  ['statusReason', 'Status reason'],
  ['priority', 'Priority'],
  ['site', 'Site'],
  ['team', 'Team'],
  ['assignees', 'Assignees'],
  ['createdBy', 'Created by'],
  ['dueAtLocal', 'Due'],
  ['completedAtLocal', 'Completed'],
  ['timeZone', 'Time zone'],
  ['description', 'Description'],
  ['createdAtUtc', 'Created at (UTC)'],
  ['updatedAtUtc', 'Updated at (UTC)'],
] as const;

/** The CSV text as the API sent it, without the BOM (`Response.text()` strips it). */
const csvTextSchema = z.string();

export function exportsEndpoints(transport: ApiTransport) {
  return {
    workLogsCsv(
      query: ListQueryParams<typeof exportWorkLogsQuerySchema> = {},
    ): Promise<ApiResult<string>> {
      return transport.request({
        path: '/exports/work-logs.csv',
        query,
        schema: csvTextSchema,
        responseType: 'text',
        timeoutMs: EXPORT_TIMEOUT_MS,
      });
    },
    tasksCsv(
      query: ListQueryParams<typeof exportTasksQuerySchema> = {},
    ): Promise<ApiResult<string>> {
      return transport.request({
        path: '/exports/tasks.csv',
        query,
        schema: csvTextSchema,
        responseType: 'text',
        timeoutMs: EXPORT_TIMEOUT_MS,
      });
    },
  };
}
