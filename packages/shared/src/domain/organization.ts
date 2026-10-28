import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  nameSchema,
  nullableIsoDateTimeSchema,
} from './shared.js';

/** Edit window of a work log when the organization has not set one, in hours. */
export const DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS = 24;
/** Largest edit window an organization can set: one year. */
export const MAX_WORK_LOG_EDIT_WINDOW_HOURS = 24 * 366;

/**
 * How far in the past a new work log's `occurredAt` may be, in days, when the organization has
 * not set `offlineMaxBackdateDays` (ADR-0008). Counted back from the server clock at the moment
 * the log reaches the server, so a log kept offline longer than this is refused
 * (`occurred_at_out_of_range`).
 */
export const DEFAULT_OFFLINE_MAX_BACKDATE_DAYS = 7;
/** Largest backdating limit an organization can set. */
export const MAX_OFFLINE_MAX_BACKDATE_DAYS = 90;

/**
 * Organization settings. The keys the API acts on are typed and validated; any other key is
 * kept as it is (time zone, locale, feature switches).
 */
export const organizationSettingsSchema = z.looseObject({
  /**
   * How long after creating a work log its author may still edit it, in hours, counted from
   * `createdAt`. Defaults to {@link DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS} when absent.
   */
  workLogEditWindowHours: z.number().positive().max(MAX_WORK_LOG_EDIT_WINDOW_HOURS).optional(),
  /**
   * How many days before the server clock a new work log's `occurredAt` may be. Defaults to
   * {@link DEFAULT_OFFLINE_MAX_BACKDATE_DAYS} when absent.
   */
  offlineMaxBackdateDays: z.number().int().min(1).max(MAX_OFFLINE_MAX_BACKDATE_DAYS).optional(),
});
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;

/**
 * The edit window stored in an organization's settings, or the default when it is absent or not
 * a usable number (settings written before the key was validated).
 */
export function workLogEditWindowHoursOf(settings: unknown): number {
  const value =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).workLogEditWindowHours
      : undefined;
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_WORK_LOG_EDIT_WINDOW_HOURS
    ? value
    : DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS;
}

/**
 * The backdating limit stored in an organization's settings, or the default when it is absent or
 * not a usable whole number.
 */
export function offlineMaxBackdateDaysOf(settings: unknown): number {
  const value =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).offlineMaxBackdateDays
      : undefined;
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_OFFLINE_MAX_BACKDATE_DAYS
    ? value
    : DEFAULT_OFFLINE_MAX_BACKDATE_DAYS;
}

const organizationSummaryShape = {
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  /** The edit window in force (the default when the organization has not set one). */
  workLogEditWindowHours: z.number(),
  /** The backdating limit in force for new work logs, in days (the default when unset). */
  offlineMaxBackdateDays: z.number().int(),
};

/** What every signed-in user of the organization sees. */
export const organizationSummarySchema = z.object({
  view: z.literal('summary'),
  ...organizationSummaryShape,
});
export type OrganizationSummary = z.infer<typeof organizationSummarySchema>;

/** What an admin sees: the summary plus the settings and the timestamps. */
export const organizationFullSchema = z.object({
  view: z.literal('full'),
  ...organizationSummaryShape,
  settings: organizationSettingsSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type OrganizationFull = z.infer<typeof organizationFullSchema>;

/**
 * The organization as the caller may see it. `view` says which shape it is: `full` for admins,
 * `summary` for everyone else.
 */
export const organizationSchema = z.discriminatedUnion('view', [
  organizationSummarySchema,
  organizationFullSchema,
]);
export type Organization = z.infer<typeof organizationSchema>;

/** Admins only. `settings` replaces the stored settings object as a whole. */
export const updateOrganizationSchema = z
  .strictObject({
    name: nameSchema.optional(),
    settings: organizationSettingsSchema.optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;

export function organizationEndpoints(transport: ApiTransport) {
  return {
    /** GET /organization: the signed-in user's organization, in the shape they may see. */
    get(): Promise<ApiResult<Organization>> {
      return transport.request({ path: '/organization', schema: organizationSchema });
    },
    /** Admins only; always answers with the full shape. */
    update(body: UpdateOrganization): Promise<ApiResult<OrganizationFull>> {
      return transport.request({
        method: 'PATCH',
        path: '/organization',
        body,
        schema: organizationFullSchema,
      });
    },
  };
}
