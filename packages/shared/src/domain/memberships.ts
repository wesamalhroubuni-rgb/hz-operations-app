import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { roleSchema } from './enums.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  nullableIsoDateTimeSchema,
  uniqueIdListSchema,
  type ListQueryParams,
} from './shared.js';

/**
 * A role held by a user, with its scope: the whole organization (`orgWide`), any number of
 * sites and/or any number of teams. Site and team scopes are a union. "Belongs to a team" and
 * "assigned to a site" are worker memberships scoped to that team or site.
 */
export const membershipSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  userId: idSchema,
  role: roleSchema,
  orgWide: z.boolean(),
  siteIds: z.array(idSchema),
  teamIds: z.array(idSchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type Membership = z.infer<typeof membershipSchema>;

/** The part of a membership embedded in a user. */
export const membershipSummarySchema = membershipSchema.pick({
  id: true,
  role: true,
  orgWide: true,
  siteIds: true,
  teamIds: true,
});
export type MembershipSummary = z.infer<typeof membershipSummarySchema>;

export const createMembershipSchema = z.strictObject({
  userId: idSchema,
  role: roleSchema,
  orgWide: z.boolean().default(false),
  siteIds: uniqueIdListSchema().default([]),
  teamIds: uniqueIdListSchema().default([]),
});
export type CreateMembership = z.infer<typeof createMembershipSchema>;
export type CreateMembershipInput = z.input<typeof createMembershipSchema>;

/** `siteIds` / `teamIds` replace the current scope lists when given. */
export const updateMembershipSchema = z
  .strictObject({
    role: roleSchema.optional(),
    orgWide: z.boolean().optional(),
    siteIds: uniqueIdListSchema().optional(),
    teamIds: uniqueIdListSchema().optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateMembership = z.infer<typeof updateMembershipSchema>;

export const MEMBERSHIP_SORT_FIELDS = ['createdAt', 'updatedAt', 'role'] as const;

export const listMembershipsQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(MEMBERSHIP_SORT_FIELDS, { field: 'createdAt', direction: 'asc' }),
  userId: idSchema.optional(),
  role: roleSchema.optional(),
  siteId: idSchema.optional(),
  teamId: idSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
});
export type ListMembershipsQuery = z.infer<typeof listMembershipsQuerySchema>;

export const membershipListSchema = paginatedSchema(membershipSchema);

export function membershipsEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listMembershipsQuerySchema> = {},
    ): Promise<ApiResult<Paginated<Membership>>> {
      return transport.request({ path: '/memberships', query, schema: membershipListSchema });
    },
    get(id: string): Promise<ApiResult<Membership>> {
      return transport.request({ path: `/memberships/${id}`, schema: membershipSchema });
    },
    create(body: CreateMembershipInput): Promise<ApiResult<Membership>> {
      return transport.request({
        method: 'POST',
        path: '/memberships',
        body,
        schema: membershipSchema,
      });
    },
    update(id: string, body: UpdateMembership): Promise<ApiResult<Membership>> {
      return transport.request({
        method: 'PATCH',
        path: `/memberships/${id}`,
        body,
        schema: membershipSchema,
      });
    },
    archive(id: string): Promise<ApiResult<Membership>> {
      return transport.request({
        method: 'POST',
        path: `/memberships/${id}/archive`,
        schema: membershipSchema,
      });
    },
  };
}
