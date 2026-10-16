import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { issuedCodeSchema, type IssuedCode } from '../platform/auth.js';
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

// ---------------------------------------------------------------------------
// Response shapes. The API answers with the shape the caller is entitled to for each user;
// `profile` says which one it is, so a client can narrow on it.
// ---------------------------------------------------------------------------

export const USER_PROFILE_LEVELS = ['basic', 'contact', 'full'] as const;
export type UserProfileLevel = (typeof USER_PROFILE_LEVELS)[number];

const basicShape = {
  id: idSchema,
  displayName: z.string(),
  /** Roles held through active memberships, highest first. */
  roles: z.array(roleSchema),
};

const contactShape = {
  ...basicShape,
  email: z.string().nullable(),
  phone: z.string().nullable(),
};

/** Who somebody is: what a worker sees of the people they work with. */
export const userBasicSchema = z.object({ profile: z.literal('basic'), ...basicShape });
export type UserBasic = z.infer<typeof userBasicSchema>;

/** Adds how to reach them: what a manager sees of everyone and a supervisor of their people. */
export const userContactSchema = z.object({ profile: z.literal('contact'), ...contactShape });
export type UserContact = z.infer<typeof userContactSchema>;

/**
 * Everything: what an admin sees of everyone, and every user of themselves. `memberships` are
 * the active (not archived) ones; `activated` is true once the user has set a password.
 */
export const userFullSchema = z.object({
  profile: z.literal('full'),
  ...contactShape,
  organizationId: idSchema,
  username: z.string().nullable(),
  memberships: z.array(membershipSummarySchema),
  activated: z.boolean(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type UserFull = z.infer<typeof userFullSchema>;

/** A user as the caller may see them. Narrow on `profile`. */
export const userSchema = z.discriminatedUnion('profile', [
  userBasicSchema,
  userContactSchema,
  userFullSchema,
]);
export type User = z.infer<typeof userSchema>;

/** The answer to creating a user: the user, and the one-time code that lets them sign in. */
export const createdUserSchema = userFullSchema.extend({ activation: issuedCodeSchema });
export type CreatedUser = z.infer<typeof createdUserSchema>;

// ---------------------------------------------------------------------------
// Login identifiers. A user has at least one of email, phone and username; each is unique
// within the organization. The schemas normalise, so what is stored is what sign-in looks up:
// email and username lower-case, phone as digits with an optional leading +.
// ---------------------------------------------------------------------------

/** Emails are stored lower-case, so uniqueness within an organization ignores case. */
export const emailSchema = z.string().trim().toLowerCase().max(320).pipe(z.email());

export const PHONE_MIN_DIGITS = 6;
export const PHONE_MAX_DIGITS = 15;

/** `+90 (532) 555-01 02` becomes `+905325550102`: spaces, dashes and parentheses go. */
export function normalizePhone(value: string): string {
  return value.replace(/[\s\-()]/g, '');
}

export const phoneSchema = z
  .string()
  .max(50)
  .transform(normalizePhone)
  .pipe(
    z.string().regex(new RegExp(`^\\+?\\d{${PHONE_MIN_DIGITS},${PHONE_MAX_DIGITS}}$`), {
      error: `must be a phone number: ${PHONE_MIN_DIGITS} to ${PHONE_MAX_DIGITS} digits, optionally starting with +`,
    }),
  );

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/**
 * 3 to 32 characters of `a-z 0-9 . _ -` with at least one letter, so a username can never be
 * mistaken for an email (no `@`) or a phone number (not only digits).
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .regex(new RegExp(`^[a-z0-9._-]{${USERNAME_MIN_LENGTH},${USERNAME_MAX_LENGTH}}$`), {
        error: `must be ${USERNAME_MIN_LENGTH} to ${USERNAME_MAX_LENGTH} characters: letters, digits, dot, underscore or dash`,
      })
      .regex(/[a-z]/, { error: 'must contain at least one letter' }),
  );

export const USER_IDENTIFIER_FIELDS = ['email', 'phone', 'username'] as const;
export type UserIdentifierField = (typeof USER_IDENTIFIER_FIELDS)[number];

/** True when at least one login identifier is present. */
export function hasLoginIdentifier(user: {
  email?: string | null;
  phone?: string | null;
  username?: string | null;
}): boolean {
  return USER_IDENTIFIER_FIELDS.some((field) => typeof user[field] === 'string');
}

const AT_LEAST_ONE_IDENTIFIER = {
  error: 'Provide at least one of email, phone or username',
  path: ['email'],
};

/** Admins only. The new user has no role until a membership is created for them. */
export const createUserSchema = z
  .strictObject({
    displayName: nameSchema,
    email: emailSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    username: usernameSchema.nullable().optional(),
  })
  .refine(hasLoginIdentifier, AT_LEAST_ONE_IDENTIFIER);
export type CreateUser = z.infer<typeof createUserSchema>;
export type CreateUserInput = z.input<typeof createUserSchema>;

/**
 * A field left out is unchanged; `null` clears an identifier (at least one must remain). An
 * admin may change every field of any user; everyone else may change only their own
 * `displayName`.
 */
export const updateUserSchema = z
  .strictObject({
    displayName: nameSchema.optional(),
    email: emailSchema.nullable().optional(),
    phone: phoneSchema.nullable().optional(),
    username: usernameSchema.nullable().optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateUser = z.infer<typeof updateUserSchema>;
export type UpdateUserInput = z.input<typeof updateUserSchema>;

export const USER_SORT_FIELDS = ['displayName', 'email', 'createdAt', 'updatedAt'] as const;

/**
 * `role`, `siteId` and `teamId` match users holding an active membership with that role/scope.
 * The list holds only the users the caller may see. `search` matches the display name; the email
 * and phone only of users whose contact details the caller may see; the username for admins only.
 */
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
    /** Admins only. Answers with the user and their activation code. */
    create(body: CreateUserInput): Promise<ApiResult<CreatedUser>> {
      return transport.request({
        method: 'POST',
        path: '/users',
        body,
        schema: createdUserSchema,
      });
    },
    /** An admin changes any field; anyone else only their own `displayName`. */
    update(id: string, body: UpdateUserInput): Promise<ApiResult<UserFull>> {
      return transport.request({
        method: 'PATCH',
        path: `/users/${id}`,
        body,
        schema: userFullSchema,
      });
    },
    archive(id: string): Promise<ApiResult<UserFull>> {
      return transport.request({
        method: 'POST',
        path: `/users/${id}/archive`,
        schema: userFullSchema,
      });
    },
    restore(id: string): Promise<ApiResult<UserFull>> {
      return transport.request({
        method: 'POST',
        path: `/users/${id}/restore`,
        schema: userFullSchema,
      });
    },
    /** Admins only. A new activation code for a user who has not set a password yet. */
    issueActivationCode(id: string): Promise<ApiResult<IssuedCode>> {
      return transport.request({
        method: 'POST',
        path: `/users/${id}/activation-code`,
        schema: issuedCodeSchema,
      });
    },
    /** Admins only. A password-reset code for a user who has already been activated. */
    issuePasswordReset(id: string): Promise<ApiResult<IssuedCode>> {
      return transport.request({
        method: 'POST',
        path: `/users/${id}/password-reset`,
        schema: issuedCodeSchema,
      });
    },
  };
}
