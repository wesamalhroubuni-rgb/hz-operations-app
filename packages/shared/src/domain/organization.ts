import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  nameSchema,
  nullableIsoDateTimeSchema,
} from './shared.js';

/** Free-form organization settings (time zone, locale, feature switches). */
export const organizationSettingsSchema = z.record(z.string(), z.unknown());

export const organizationSchema = z.object({
  id: idSchema,
  name: z.string(),
  slug: z.string(),
  settings: organizationSettingsSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type Organization = z.infer<typeof organizationSchema>;

/** `settings` replaces the stored settings object as a whole. */
export const updateOrganizationSchema = z
  .strictObject({
    name: nameSchema.optional(),
    settings: organizationSettingsSchema.optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateOrganization = z.infer<typeof updateOrganizationSchema>;

export function organizationEndpoints(transport: ApiTransport) {
  return {
    /** GET /organization: the acting user's organization. */
    get(): Promise<ApiResult<Organization>> {
      return transport.request({ path: '/organization', schema: organizationSchema });
    },
    update(body: UpdateOrganization): Promise<ApiResult<Organization>> {
      return transport.request({
        method: 'PATCH',
        path: '/organization',
        body,
        schema: organizationSchema,
      });
    },
  };
}
