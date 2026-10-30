import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import { dayKeySchema } from '../common/time-zone.js';
import { roleSchema } from './enums.js';

// GET /dashboard/overview [dashboard.read] (Phase 6, ADR-0009): the numbers of the dashboard's
// home page, for the CALLER'S scope only (the same visibility as GET /work-logs and GET /tasks:
// a supervisor's numbers count only what their lists would show).
//
// Every number carries `filter`: the query parameters of the list it summarises, with the same
// names as the list endpoint's query (`listWorkLogsQuerySchema` / `listTasksQuerySchema`) and the
// dashboard's page URLs. The page links to `/work-logs?<filter>` or `/tasks?<filter>`, so a
// number and the list it opens always agree.

/**
 * Query parameters of a list, as strings (`{ status: 'submitted', occurredFrom: '...' }`). Turn
 * them into a URL with `new URLSearchParams(filter)`.
 */
export const listFilterSchema = z.record(z.string(), z.string());
export type ListFilter = z.infer<typeof listFilterSchema>;

export const linkedCountSchema = z.object({
  count: z.number().int().min(0),
  filter: listFilterSchema,
});
export type LinkedCount = z.infer<typeof linkedCountSchema>;

/** How many workers without activity the overview lists by name. */
export const IDLE_WORKERS_LIMIT = 50;

export const dashboardOverviewQuerySchema = z.object({
  /** A day in the organization's time zone; defaults to today there. */
  day: dayKeySchema.optional(),
});
export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;

export const dashboardPlaceActivitySchema = z.object({
  /** Null for the row of logs and tasks without a site (or team). */
  id: idSchema.nullable(),
  name: z.string().nullable(),
  logsToday: z.number().int().min(0),
  tasksOpen: z.number().int().min(0),
  /** Work-log list filter: this place, this day. */
  logsFilter: listFilterSchema,
  /** Task list filter: this place, open tasks. */
  tasksFilter: listFilterSchema,
});
export type DashboardPlaceActivity = z.infer<typeof dashboardPlaceActivitySchema>;

export const dashboardIdleWorkerSchema = z.object({
  userId: idSchema,
  displayName: z.string(),
  roles: z.array(roleSchema),
  /** The `occurredAt` of their latest visible log, or null when they have none. */
  lastLogAt: isoDateTimeSchema.nullable(),
  /** Work-log list filter: this worker's logs (any day). */
  filter: listFilterSchema,
});
export type DashboardIdleWorker = z.infer<typeof dashboardIdleWorkerSchema>;

export const dashboardOverviewSchema = z.object({
  generatedAt: isoDateTimeSchema,
  /** The organization's time zone, in which `day` was counted. */
  timeZone: z.string(),
  day: dayKeySchema,
  /** The instants `day` covers: inclusive start, exclusive end. */
  dayStart: isoDateTimeSchema,
  dayEnd: isoDateTimeSchema,
  /** Non-archived logs whose `occurredAt` is in `day`. */
  logsToday: linkedCountSchema,
  /** Non-archived logs in status `submitted`, any day: the review queue. */
  logsAwaitingApproval: linkedCountSchema,
  /** Non-archived tasks in an open status. */
  tasksOpen: linkedCountSchema,
  /** Open tasks whose `dueAt` is before `generatedAt`. */
  tasksOverdue: linkedCountSchema,
  tasksBlocked: linkedCountSchema,
  /** One row per visible site with activity (logs in `day` or open tasks), most logs first. */
  bySite: z.array(dashboardPlaceActivitySchema),
  /** The same per team. */
  byTeam: z.array(dashboardPlaceActivitySchema),
  /**
   * Active users with the worker role whom the caller supervises (a supervisor: their people; a
   * manager or admin: everyone) and who have no log with `occurredAt` in `day`.
   */
  idleWorkers: z.object({
    total: z.number().int().min(0),
    items: z.array(dashboardIdleWorkerSchema),
    truncated: z.boolean(),
  }),
});
export type DashboardOverview = z.infer<typeof dashboardOverviewSchema>;

export function dashboardEndpoints(transport: ApiTransport) {
  return {
    overview(query: { day?: string } = {}): Promise<ApiResult<DashboardOverview>> {
      return transport.request({
        path: '/dashboard/overview',
        query,
        schema: dashboardOverviewSchema,
      });
    },
  };
}
