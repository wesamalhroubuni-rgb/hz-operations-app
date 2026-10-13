import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { customFieldDefinitionsSchema } from './custom-fields.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  longTextSchema,
  nameSchema,
  nullableIsoDateTimeSchema,
  searchQuerySchema,
  type ListQueryParams,
} from './shared.js';

/** Stable identifier of a log type within its organization, e.g. `material_usage`. */
export const logTypeKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, {
  error:
    'must be a slug: lowercase letters, digits and underscores, starting with a letter (max 64)',
});

/**
 * A kind of work log an organization defines ("Inspection", "Delivery", ...). `fields` is the
 * ordered list of custom fields; `version` goes up by one every time `fields` changes, and each
 * work log records the version it was validated against.
 */
export const logTypeSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  fields: customFieldDefinitionsSchema,
  version: z.number().int().min(1),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type LogType = z.infer<typeof logTypeSchema>;

export const createLogTypeSchema = z.strictObject({
  key: logTypeKeySchema,
  name: nameSchema,
  description: longTextSchema.nullable().optional(),
  fields: customFieldDefinitionsSchema.default([]),
});
export type CreateLogType = z.infer<typeof createLogTypeSchema>;
export type CreateLogTypeInput = z.input<typeof createLogTypeSchema>;

/** `key` cannot change. `fields` replaces the whole field list and bumps `version`. */
export const updateLogTypeSchema = z
  .strictObject({
    name: nameSchema.optional(),
    description: longTextSchema.nullable().optional(),
    fields: customFieldDefinitionsSchema.optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateLogType = z.infer<typeof updateLogTypeSchema>;
export type UpdateLogTypeInput = z.input<typeof updateLogTypeSchema>;

export const LOG_TYPE_SORT_FIELDS = ['name', 'key', 'createdAt', 'updatedAt'] as const;

export const listLogTypesQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(LOG_TYPE_SORT_FIELDS, { field: 'name', direction: 'asc' }),
  search: searchQuerySchema,
  includeArchived: queryBooleanSchema.default(false),
});
export type ListLogTypesQuery = z.infer<typeof listLogTypesQuerySchema>;

export const logTypeListSchema = paginatedSchema(logTypeSchema);

export function logTypesEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listLogTypesQuerySchema> = {},
    ): Promise<ApiResult<Paginated<LogType>>> {
      return transport.request({ path: '/log-types', query, schema: logTypeListSchema });
    },
    get(id: string): Promise<ApiResult<LogType>> {
      return transport.request({ path: `/log-types/${id}`, schema: logTypeSchema });
    },
    create(body: CreateLogTypeInput): Promise<ApiResult<LogType>> {
      return transport.request({
        method: 'POST',
        path: '/log-types',
        body,
        schema: logTypeSchema,
      });
    },
    update(id: string, body: UpdateLogTypeInput): Promise<ApiResult<LogType>> {
      return transport.request({
        method: 'PATCH',
        path: `/log-types/${id}`,
        body,
        schema: logTypeSchema,
      });
    },
    archive(id: string): Promise<ApiResult<LogType>> {
      return transport.request({
        method: 'POST',
        path: `/log-types/${id}/archive`,
        schema: logTypeSchema,
      });
    },
  };
}
