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

/** A group of people. `parentId` makes departments and sub-teams possible. */
export const teamSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  parentId: idSchema.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type Team = z.infer<typeof teamSchema>;

const teamFields = {
  name: nameSchema,
  description: longTextSchema.nullable().optional(),
  parentId: idSchema.nullable().optional(),
};

export const createTeamSchema = z.strictObject(teamFields);
export type CreateTeam = z.infer<typeof createTeamSchema>;

/** A field left out is unchanged; `null` clears it. */
export const updateTeamSchema = z
  .strictObject({ ...teamFields, name: nameSchema.optional() })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateTeam = z.infer<typeof updateTeamSchema>;

export const TEAM_SORT_FIELDS = ['name', 'createdAt', 'updatedAt'] as const;

/** `parentId=<id>` lists the direct children of a team. */
export const listTeamsQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(TEAM_SORT_FIELDS, { field: 'name', direction: 'asc' }),
  search: searchQuerySchema,
  parentId: idSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
});
export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;

export const teamListSchema = paginatedSchema(teamSchema);

export function teamsEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listTeamsQuerySchema> = {},
    ): Promise<ApiResult<Paginated<Team>>> {
      return transport.request({ path: '/teams', query, schema: teamListSchema });
    },
    get(id: string): Promise<ApiResult<Team>> {
      return transport.request({ path: `/teams/${id}`, schema: teamSchema });
    },
    create(body: CreateTeam): Promise<ApiResult<Team>> {
      return transport.request({ method: 'POST', path: '/teams', body, schema: teamSchema });
    },
    update(id: string, body: UpdateTeam): Promise<ApiResult<Team>> {
      return transport.request({ method: 'PATCH', path: `/teams/${id}`, body, schema: teamSchema });
    },
    archive(id: string): Promise<ApiResult<Team>> {
      return transport.request({
        method: 'POST',
        path: `/teams/${id}/archive`,
        schema: teamSchema,
      });
    },
    restore(id: string): Promise<ApiResult<Team>> {
      return transport.request({
        method: 'POST',
        path: `/teams/${id}/restore`,
        schema: teamSchema,
      });
    },
  };
}
