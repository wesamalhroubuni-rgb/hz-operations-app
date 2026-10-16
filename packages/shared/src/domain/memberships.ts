import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { roleSchema, type Role } from './enums.js';
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

/** Roles whose memberships always cover the whole organization. */
export const ORG_WIDE_ROLES: readonly Role[] = ['manager', 'admin'];

/**
 * What is wrong with the scope of a membership for its role, as error details (empty when it is
 * fine). A `manager` or `admin` membership must be organization-wide and list no site or team.
 * Used by the create schema and by the API on the result of an update.
 */
export function membershipScopeIssues(membership: {
  role: Role;
  orgWide: boolean;
  siteIds: readonly string[];
  teamIds: readonly string[];
}): Array<{ path: string; message: string }> {
  if (!ORG_WIDE_ROLES.includes(membership.role)) {
    return [];
  }
  const issues: Array<{ path: string; message: string }> = [];
  if (!membership.orgWide) {
    issues.push({ path: 'orgWide', message: `must be true for the ${membership.role} role` });
  }
  if (membership.siteIds.length > 0) {
    issues.push({ path: 'siteIds', message: `must be empty for the ${membership.role} role` });
  }
  if (membership.teamIds.length > 0) {
    issues.push({ path: 'teamIds', message: `must be empty for the ${membership.role} role` });
  }
  return issues;
}

/** A `manager` or `admin` membership must send `orgWide: true` and no sites or teams. */
export const createMembershipSchema = z
  .strictObject({
    userId: idSchema,
    role: roleSchema,
    orgWide: z.boolean().default(false),
    siteIds: uniqueIdListSchema().default([]),
    teamIds: uniqueIdListSchema().default([]),
  })
  .superRefine((membership, context) => {
    for (const issue of membershipScopeIssues(membership)) {
      context.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
export type CreateMembership = z.infer<typeof createMembershipSchema>;
export type CreateMembershipInput = z.input<typeof createMembershipSchema>;

/**
 * `siteIds` / `teamIds` replace the current scope lists when given. The result must satisfy
 * {@link membershipScopeIssues}, which the API checks against the stored membership.
 */
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
