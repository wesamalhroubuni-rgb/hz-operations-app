import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  longTextSchema,
  nameSchema,
  nullableIsoDateTimeSchema,
  searchQuerySchema,
  type ListQueryParams,
} from './shared.js';

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

/** A physical location or project. `parentId` makes sub-sites possible. */
export const siteSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  parentId: idSchema.nullable(),
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  address: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type Site = z.infer<typeof siteSchema>;

const siteFields = {
  name: nameSchema,
  /** Short reference such as "N-01"; unique within the organization. */
  code: z.string().trim().min(1).max(50).nullable().optional(),
  description: longTextSchema.nullable().optional(),
  address: z.string().trim().max(500).nullable().optional(),
  latitude: latitudeSchema.nullable().optional(),
  longitude: longitudeSchema.nullable().optional(),
  parentId: idSchema.nullable().optional(),
};

export const createSiteSchema = z.strictObject(siteFields);
export type CreateSite = z.infer<typeof createSiteSchema>;

/** A field left out is unchanged; `null` clears it. */
export const updateSiteSchema = z
  .strictObject({ ...siteFields, name: nameSchema.optional() })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateSite = z.infer<typeof updateSiteSchema>;

export const SITE_SORT_FIELDS = ['name', 'code', 'createdAt', 'updatedAt'] as const;

/** `parentId=<id>` lists the direct children of a site. */
export const listSitesQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(SITE_SORT_FIELDS, { field: 'name', direction: 'asc' }),
  search: searchQuerySchema,
  parentId: idSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
});
export type ListSitesQuery = z.infer<typeof listSitesQuerySchema>;

export const siteListSchema = paginatedSchema(siteSchema);

export function sitesEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listSitesQuerySchema> = {},
    ): Promise<ApiResult<Paginated<Site>>> {
      return transport.request({ path: '/sites', query, schema: siteListSchema });
    },
    get(id: string): Promise<ApiResult<Site>> {
      return transport.request({ path: `/sites/${id}`, schema: siteSchema });
    },
    create(body: CreateSite): Promise<ApiResult<Site>> {
      return transport.request({ method: 'POST', path: '/sites', body, schema: siteSchema });
    },
    update(id: string, body: UpdateSite): Promise<ApiResult<Site>> {
      return transport.request({ method: 'PATCH', path: `/sites/${id}`, body, schema: siteSchema });
    },
    archive(id: string): Promise<ApiResult<Site>> {
      return transport.request({
        method: 'POST',
        path: `/sites/${id}/archive`,
        schema: siteSchema,
      });
    },
    restore(id: string): Promise<ApiResult<Site>> {
      return transport.request({
        method: 'POST',
        path: `/sites/${id}/restore`,
        schema: siteSchema,
      });
    },
  };
}
