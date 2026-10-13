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
import { membershipSummarySchema } from './memberships.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  nameSchema,
  nullableIsoDateTimeSchema,
  searchQuerySchema,
  type ListQueryParams,
} from './shared.js';

/** A user, with the active (not archived) memberships that give them roles and scope. */
export const userSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  email: z.string(),
  displayName: z.string(),
  phone: z.string().nullable(),
  memberships: z.array(membershipSummarySchema),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type User = z.infer<typeof userSchema>;

/** Emails are stored lower-case, so uniqueness within an organization ignores case. */
export const emailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email());
const phoneSchema = z.string().trim().min(1).max(50);

export const createUserSchema = z.strictObject({
  email: emailSchema,
  displayName: nameSchema,
  phone: phoneSchema.nullable().optional(),
});
export type CreateUser = z.infer<typeof createUserSchema>;
export type CreateUserInput = z.input<typeof createUserSchema>;

export const updateUserSchema = z
  .strictObject({
    email: emailSchema.optional(),
    displayName: nameSchema.optional(),
    phone: phoneSchema.nullable().optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateUser = z.infer<typeof updateUserSchema>;

export const USER_SORT_FIELDS = ['displayName', 'email', 'createdAt', 'updatedAt'] as const;

/** `role`, `siteId` and `teamId` match users holding an active membership with that role/scope. */
export const listUsersQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(USER_SORT_FIELDS, { field: 'displayName', direction: 'asc' }),
  search: searchQuerySchema,
  role: roleSchema.optional(),
  siteId: idSchema.optional(),
  teamId: idSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const userListSchema = paginatedSchema(userSchema);

export function usersEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listUsersQuerySchema> = {},
    ): Promise<ApiResult<Paginated<User>>> {
      return transport.request({ path: '/users', query, schema: userListSchema });
    },
    get(id: string): Promise<ApiResult<User>> {
      return transport.request({ path: `/users/${id}`, schema: userSchema });
    },
    create(body: CreateUserInput): Promise<ApiResult<User>> {
      return transport.request({ method: 'POST', path: '/users', body, schema: userSchema });
    },
    update(id: string, body: UpdateUser): Promise<ApiResult<User>> {
      return transport.request({ method: 'PATCH', path: `/users/${id}`, body, schema: userSchema });
    },
    archive(id: string): Promise<ApiResult<User>> {
      return transport.request({
        method: 'POST',
        path: `/users/${id}/archive`,
        schema: userSchema,
      });
    },
    restore(id: string): Promise<ApiResult<User>> {
      return transport.request({
        method: 'POST',
        path: `/users/${id}/restore`,
        schema: userSchema,
      });
    },
  };
}
