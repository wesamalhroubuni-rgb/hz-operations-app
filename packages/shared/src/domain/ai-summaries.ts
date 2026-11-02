import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { localeSchema } from '../common/locale.js';
import { paginatedSchema, paginationQuerySchema, type Paginated } from '../common/pagination.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import { dayKeySchema } from '../common/time-zone.js';
import { roleSchema } from './enums.js';
import type { ListQueryParams } from './shared.js';

// Daily summaries and anomaly flags (Phase 7, ADR-0011).
//
// A summary is generated once per (recipient, org-local day) at the organization's
// `settings.ai.summaryTime`, for exactly the recipient's visibility (the same filters as the
// dashboard). Every number is computed in code (`stats`); the model only writes `narrative` from
// those facts, and a narrative containing a number that is not in the facts is refused (one
// retry, then the code template). Anomaly flags are rule-based suggestions with the numbers
// behind them; nothing is ever done automatically.

/** Must match the Prisma enum `AnomalyKind`, in order. */
export const ANOMALY_KINDS = [
  'no_activity_site',
  'slow_task',
  'repeated_rejections',
  'far_location',
] as const;
export const anomalyKindSchema = z.enum(ANOMALY_KINDS);
export type AnomalyKind = z.infer<typeof anomalyKindSchema>;

/** Must match the Prisma enum `AnomalySeverity`, in order. */
export const ANOMALY_SEVERITIES = ['low', 'medium', 'high'] as const;
export const anomalySeveritySchema = z.enum(ANOMALY_SEVERITIES);
export type AnomalySeverity = z.infer<typeof anomalySeveritySchema>;

/** Must match the Prisma enum `SummaryNarrativeSource`, in order. */
export const SUMMARY_NARRATIVE_SOURCES = ['ai', 'template'] as const;
export const summaryNarrativeSourceSchema = z.enum(SUMMARY_NARRATIVE_SOURCES);
export type SummaryNarrativeSource = z.infer<typeof summaryNarrativeSourceSchema>;

/**
 * Thresholds of the anomaly rules v1 (ADR-0011). Constants, not settings, in v1.
 * - no_activity_site: an active site (an open task there, or a log there in the last
 *   `activeSiteLookbackDays` days) with no log on the day.
 * - slow_task: an open task older than `slowTaskFactor` x the median duration (createdAt to
 *   completedAt) of tasks completed in the last `slowTaskLookbackDays` days in the same group
 *   (site and the task's dominant log type; site only when that sample is too small), with at
 *   least `slowTaskMinSample` tasks in the sample.
 * - repeated_rejections: a worker with at least `repeatedRejectionsCount` rejections in the
 *   last `repeatedRejectionsWindowDays` days.
 * - far_location: a log of the day more than `farLocationKm` from its site's reference point:
 *   the site's own coordinates, else the median of the site's located logs of the last
 *   `farLocationLookbackDays` days (at least `farLocationMinSample` logs).
 */
export const ANOMALY_THRESHOLDS = {
  activeSiteLookbackDays: 14,
  slowTaskFactor: 3,
  slowTaskMinSample: 5,
  slowTaskLookbackDays: 90,
  repeatedRejectionsCount: 3,
  repeatedRejectionsWindowDays: 7,
  farLocationKm: 2,
  farLocationMinSample: 5,
  farLocationLookbackDays: 90,
} as const;

/** The numbers behind each kind's reason; clients render the reason text from them. */
export const anomalyParamsSchemas = {
  no_activity_site: z.object({
    lookbackDays: z.number().int().min(1),
    /** The site's latest log before the day, or null. */
    lastLogAt: isoDateTimeSchema.nullable(),
    openTasks: z.number().int().min(0),
  }),
  slow_task: z.object({
    ageHours: z.number().min(0),
    medianHours: z.number().min(0),
    /** ageHours / medianHours. */
    factor: z.number().min(0),
    sampleSize: z.number().int().min(1),
    group: z.enum(['site_log_type', 'site']),
  }),
  repeated_rejections: z.object({
    rejections: z.number().int().min(1),
    windowDays: z.number().int().min(1),
  }),
  far_location: z.object({
    distanceKm: z.number().min(0),
    thresholdKm: z.number().min(0),
    reference: z.enum(['site_coordinates', 'median_of_logs']),
    /** Logs behind a `median_of_logs` reference; null for site coordinates. */
    sampleSize: z.number().int().min(1).nullable(),
  }),
} as const;
export type AnomalyParams<Kind extends AnomalyKind> = z.infer<(typeof anomalyParamsSchemas)[Kind]>;

const anomalyFlagShape = {
  id: idSchema,
  organizationId: idSchema,
  /** The org-local day it was raised for. */
  day: dayKeySchema,
  severity: anomalySeveritySchema,
  siteId: idSchema.nullable(),
  teamId: idSchema.nullable(),
  userId: idSchema.nullable(),
  taskId: idSchema.nullable(),
  workLogId: idSchema.nullable(),
  logTypeId: idSchema.nullable(),
  createdAt: isoDateTimeSchema,
};

/** A flag as a reader sees it: only ever one whose every subject the reader may see. */
export const anomalyFlagSchema = z.discriminatedUnion('kind', [
  z.object({
    ...anomalyFlagShape,
    kind: z.literal('no_activity_site'),
    params: anomalyParamsSchemas.no_activity_site,
  }),
  z.object({
    ...anomalyFlagShape,
    kind: z.literal('slow_task'),
    params: anomalyParamsSchemas.slow_task,
  }),
  z.object({
    ...anomalyFlagShape,
    kind: z.literal('repeated_rejections'),
    params: anomalyParamsSchemas.repeated_rejections,
  }),
  z.object({
    ...anomalyFlagShape,
    kind: z.literal('far_location'),
    params: anomalyParamsSchemas.far_location,
  }),
]);
export type AnomalyFlag = z.infer<typeof anomalyFlagSchema>;

/** Longest day range of `GET /ai/anomalies` and `GET /ai/summaries`. */
export const AI_DAY_RANGE_MAX_DAYS = 92;

/**
 * `GET /ai/anomalies` [ai_anomaly.read]: the flags visible to the caller, newest day first.
 * `from` and `to` are inclusive org-local days (default: today); filters only narrow.
 */
export const listAnomaliesQuerySchema = paginationQuerySchema.extend({
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
  kind: anomalyKindSchema.optional(),
  siteId: idSchema.optional(),
  teamId: idSchema.optional(),
  userId: idSchema.optional(),
});
export type ListAnomaliesQuery = z.infer<typeof listAnomaliesQuerySchema>;
export const anomalyFlagListSchema = paginatedSchema(anomalyFlagSchema);

/** The recipient's scope when the summary was made (their own; ids, not names). */
export const dailySummaryScopeSchema = z.object({
  roles: z.array(roleSchema),
  orgWide: z.boolean(),
  siteIds: z.array(idSchema),
  teamIds: z.array(idSchema),
  /** People the recipient oversees (themselves included); null for org-wide. */
  peopleCount: z.number().int().min(0).nullable(),
});
export type DailySummaryScope = z.infer<typeof dailySummaryScopeSchema>;

const placeStatsSchema = z.object({
  /** Null for the row of records without a site (or team). */
  id: idSchema.nullable(),
  name: z.string().nullable(),
  logs: z.number().int().min(0),
  tasksOpen: z.number().int().min(0),
  tasksOverdue: z.number().int().min(0),
  tasksBlocked: z.number().int().min(0),
  tasksCompleted: z.number().int().min(0),
});
export type DailySummaryPlaceStats = z.infer<typeof placeStatsSchema>;

/**
 * The facts of a summary, computed in code with the recipient's visibility. "In the day" means
 * inside [dayStart, dayEnd) of the org-local day. Every count excludes archived records.
 */
export const dailySummaryStatsSchema = z.object({
  day: dayKeySchema,
  timeZone: z.string(),
  dayStart: isoDateTimeSchema,
  dayEnd: isoDateTimeSchema,
  /** Logs whose `occurredAt` is in the day, by current status. */
  logs: z.object({
    total: z.number().int().min(0),
    draft: z.number().int().min(0),
    submitted: z.number().int().min(0),
    approved: z.number().int().min(0),
    rejected: z.number().int().min(0),
    aiAssisted: z.number().int().min(0),
  }),
  /** Reviews made in the day (`reviewedAt` in the day). */
  reviews: z.object({
    approved: z.number().int().min(0),
    rejected: z.number().int().min(0),
  }),
  /** Logs in status `submitted` of any day, not the recipient's own: their review queue. */
  awaitingApproval: z.number().int().min(0),
  /**
   * Open = todo, in_progress, blocked; overdue = open with `dueAt` before `dayEnd`, or before the
   * generation time while the day is still running (the anomaly rules use the same moment).
   */
  tasks: z.object({
    open: z.number().int().min(0),
    overdue: z.number().int().min(0),
    blocked: z.number().int().min(0),
    completed: z.number().int().min(0),
    created: z.number().int().min(0),
  }),
  /** Workers in scope with at least one log in the day, and without. */
  workers: z.object({
    active: z.number().int().min(0),
    idle: z.number().int().min(0),
  }),
  /** Visible sites (and teams) with activity or open tasks, most logs first. */
  bySite: z.array(placeStatsSchema),
  byTeam: z.array(placeStatsSchema),
  anomalies: z.object({
    total: z.number().int().min(0),
    byKind: z.object({
      no_activity_site: z.number().int().min(0),
      slow_task: z.number().int().min(0),
      repeated_rejections: z.number().int().min(0),
      far_location: z.number().int().min(0),
    }),
  }),
});
export type DailySummaryStats = z.infer<typeof dailySummaryStatsSchema>;

export const dailySummarySchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  recipientId: idSchema,
  day: dayKeySchema,
  timeZone: z.string(),
  scope: dailySummaryScopeSchema,
  stats: dailySummaryStatsSchema,
  /** The flags of the day that the recipient may see, as they were when generated. */
  anomalies: z.array(anomalyFlagSchema),
  /** Plain text, a few short paragraphs. People are named only by their display names. */
  narrative: z.string(),
  narrativeSource: summaryNarrativeSourceSchema,
  locale: localeSchema,
  createdAt: isoDateTimeSchema,
});
export type DailySummary = z.infer<typeof dailySummarySchema>;

/**
 * `GET /ai/summaries` [ai_summary.read]: the caller's OWN summaries (recipient = caller), newest
 * day first. `from` / `to` are inclusive org-local days.
 */
export const listDailySummariesQuerySchema = paginationQuerySchema.extend({
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
});
export type ListDailySummariesQuery = z.infer<typeof listDailySummariesQuerySchema>;
export const dailySummaryListSchema = paginatedSchema(dailySummarySchema);

/** How many days back an admin may (re)generate summaries for. */
export const AI_SUMMARY_GENERATE_MAX_DAYS_BACK = 7;

/**
 * `POST /ai/summaries/generate` [ai_summary.generate] (admins): generate the summaries of one day
 * now instead of waiting for the schedule, for every recipient (by the organization's settings)
 * or one. Idempotent: an existing (recipient, day) summary is kept and counted as skipped.
 * `day` defaults to the last day whose summaries are due: today in the organization's time zone
 * once its local time has reached `summaryTime`, else yesterday. Today before `summaryTime` is
 * refused (422: the summaries would be partial and the scheduled run would skip them); at most
 * {@link AI_SUMMARY_GENERATE_MAX_DAYS_BACK} days back, never in the future (422). Refused with
 * 403 `ai_disabled` while `dailySummaryEnabled` is off.
 */
export const generateDailySummariesSchema = z.strictObject({
  day: dayKeySchema.optional(),
  recipientId: idSchema.optional(),
});
export type GenerateDailySummaries = z.infer<typeof generateDailySummariesSchema>;

export const generateDailySummariesResultSchema = z.object({
  day: dayKeySchema,
  generated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  /** Recipients whose summary could not be written (logged; the template fallback failed too). */
  failed: z.number().int().min(0),
  summaryIds: z.array(idSchema),
});
export type GenerateDailySummariesResult = z.infer<typeof generateDailySummariesResultSchema>;

/** The in-app notification of a new summary; `data` is `{ summaryId, day }`. Push text is generic. */
export const DAILY_SUMMARY_NOTIFICATION_TYPE = 'ai.daily_summary';

export function aiSummariesEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listDailySummariesQuerySchema> = {},
    ): Promise<ApiResult<Paginated<DailySummary>>> {
      return transport.request({ path: '/ai/summaries', query, schema: dailySummaryListSchema });
    },
    get(id: string): Promise<ApiResult<DailySummary>> {
      return transport.request({ path: `/ai/summaries/${id}`, schema: dailySummarySchema });
    },
    /** Admins. */
    generate(body: GenerateDailySummaries): Promise<ApiResult<GenerateDailySummariesResult>> {
      return transport.request({
        method: 'POST',
        path: '/ai/summaries/generate',
        body,
        schema: generateDailySummariesResultSchema,
        timeoutMs: 300_000,
      });
    },
    anomalies(
      query: ListQueryParams<typeof listAnomaliesQuerySchema> = {},
    ): Promise<ApiResult<Paginated<AnomalyFlag>>> {
      return transport.request({ path: '/ai/anomalies', query, schema: anomalyFlagListSchema });
    },
  };
}
