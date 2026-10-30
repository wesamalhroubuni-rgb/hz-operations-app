import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import { dayKeySchema } from '../common/time-zone.js';
import { workLogStatusSchema } from './enums.js';

// GET /reports/work-logs [report.read] (Phase 6, ADR-0009): the data of the printable work-log
// report for a date range, for the caller's scope (the same visibility as GET /work-logs).
// The web page lays it out for printing (`@media print`); there is no PDF on the server.

/** Longest range a report may cover. */
export const REPORT_MAX_DAYS = 92;
/** Most log rows a report lists (the totals always count every log). */
export const REPORT_MAX_LOGS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `occurredFrom` inclusive, `occurredTo` exclusive (build them with `zonedDaysRange` from the
 * days the user picked, in the organization's time zone), at most `REPORT_MAX_DAYS` apart.
 */
export const workLogReportQuerySchema = z
  .object({
    occurredFrom: isoDateTimeSchema,
    occurredTo: isoDateTimeSchema,
    siteId: idSchema.optional(),
    teamId: idSchema.optional(),
    authorId: idSchema.optional(),
    logTypeId: idSchema.optional(),
    status: workLogStatusSchema.optional(),
  })
  .refine((query) => Date.parse(query.occurredFrom) < Date.parse(query.occurredTo), {
    path: ['occurredTo'],
    error: 'must be after occurredFrom',
  })
  .refine(
    (query) =>
      // Two hours of slack: a range of whole local days can be longer than N * 24 h across a
      // daylight-saving change.
      Date.parse(query.occurredTo) - Date.parse(query.occurredFrom) <=
      REPORT_MAX_DAYS * DAY_MS + 2 * 60 * 60 * 1000,
    { path: ['occurredTo'], error: `must be at most ${REPORT_MAX_DAYS} days after occurredFrom` },
  );
export type WorkLogReportQuery = z.infer<typeof workLogReportQuerySchema>;

const countSchema = z.number().int().min(0);

export const workLogReportGroupSchema = z.object({
  /** Null for logs without a site / team / log type. */
  id: idSchema.nullable(),
  name: z.string().nullable(),
  count: countSchema,
});

export const workLogReportRowSchema = z.object({
  id: idSchema,
  occurredAt: isoDateTimeSchema,
  authorId: idSchema,
  authorName: z.string().nullable(),
  siteName: z.string().nullable(),
  teamName: z.string().nullable(),
  logTypeName: z.string().nullable(),
  status: workLogStatusSchema,
  excerpt: z.string().nullable(),
  attachmentCount: countSchema,
});
export type WorkLogReportRow = z.infer<typeof workLogReportRowSchema>;

export const workLogReportSchema = z.object({
  generatedAt: isoDateTimeSchema,
  timeZone: z.string(),
  occurredFrom: isoDateTimeSchema,
  occurredTo: isoDateTimeSchema,
  totals: z.object({
    logs: countSchema,
    draft: countSchema,
    submitted: countSchema,
    approved: countSchema,
    rejected: countSchema,
    withPhotos: countSchema,
    withLocation: countSchema,
  }),
  /** One entry per day of the range in the organization's time zone, empty days included. */
  byDay: z.array(z.object({ day: dayKeySchema, count: countSchema })),
  bySite: z.array(workLogReportGroupSchema),
  byTeam: z.array(workLogReportGroupSchema),
  byLogType: z.array(workLogReportGroupSchema),
  byWorker: z.array(
    z.object({
      authorId: idSchema,
      displayName: z.string().nullable(),
      count: countSchema,
      approved: countSchema,
      rejected: countSchema,
    }),
  ),
  /** Newest first, at most `REPORT_MAX_LOGS`. */
  logs: z.array(workLogReportRowSchema),
  logsTruncated: z.boolean(),
});
export type WorkLogReport = z.infer<typeof workLogReportSchema>;

export interface WorkLogReportParams {
  occurredFrom: string;
  occurredTo: string;
  siteId?: string;
  teamId?: string;
  authorId?: string;
  logTypeId?: string;
  status?: string;
}

export function reportsEndpoints(transport: ApiTransport) {
  return {
    workLogs(query: WorkLogReportParams): Promise<ApiResult<WorkLogReport>> {
      return transport.request({
        path: '/reports/work-logs',
        query: { ...query },
        schema: workLogReportSchema,
        timeoutMs: 30_000,
      });
    },
  };
}
