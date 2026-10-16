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
 * Organization settings. The keys the API acts on are typed and validated; any other key is
 * kept as it is (time zone, locale, feature switches).
 */
export const organizationSettingsSchema = z.looseObject({
  /**
   * How long after creating a work log its author may still edit it, in hours, counted from
   * `createdAt`. Defaults to {@link DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS} when absent.
   */
  workLogEditWindowHours: z.number().positive().max(MAX_WORK_LOG_EDIT_WINDOW_HOURS).optional(),
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

const organizationSummaryShape = {
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  /** The edit window in force (the default when the organization has not set one). */
  workLogEditWindowHours: z.number(),
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
