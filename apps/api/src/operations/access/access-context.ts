import { roleRank, rolesHighestFirst, type ResolvedScope, type Role } from '@ops/shared';

/**
 * Who is asking, and what their memberships give them. Resolved once per request by
 * `AccessService` and handed to the pure rule functions in `./rules`.
 *
 * Capabilities are the union over the user's active memberships: `roles` lists every role held,
 * and the `is...OrAbove` flags answer for the highest one.
 */
export interface AccessContext {
  userId: string;
  organizationId: string;
  /**
   * True only for the internal system context (`AccessService.runAsSystem`: the seed and other
   * code that runs without a request). Never true for an HTTP request.
   */
  system: boolean;
  /** Every role held through an active membership, highest first. */
  roles: readonly Role[];
  /** The highest of `roles`, or null for a user with no active membership. */
  highestRole: Role | null;
  isAdmin: boolean;
  isManagerOrAbove: boolean;
  isSupervisorOrAbove: boolean;
  /** What the user may see (sites, teams, people), from `resolveScope`. */
  scope: ResolvedScope;
}

/** Id used as `userId` of the system context. It never matches a real user. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** Builds the context from a resolved scope. Pure. An inactive (archived) user gets no role. */
export function buildAccessContext(scope: ResolvedScope): AccessContext {
  const roles = scope.active ? rolesHighestFirst(scope.roles) : [];
  const highestRole = roles[0] ?? null;
  const rank = roleRank(highestRole);
  return {
    userId: scope.userId,
    organizationId: scope.organizationId,
    system: false,
    roles,
    highestRole,
    isAdmin: rank >= roleRank('admin'),
    isManagerOrAbove: rank >= roleRank('manager'),
    isSupervisorOrAbove: rank >= roleRank('supervisor'),
    scope,
  };
}

/**
 * The context of code that runs without a signed-in user (the seed). It has an admin's rights
 * over one organization and is nobody's author: services that record an author refuse it.
 */
export function systemAccessContext(organizationId: string): AccessContext {
  return {
    ...buildAccessContext({
      userId: SYSTEM_USER_ID,
      organizationId,
      active: true,
      roles: ['admin'],
      orgWide: true,
      siteIds: [],
      teamIds: [],
      userIds: 'all',
      colleagueIds: [],
      memberOf: { orgWide: false, siteIds: [], teamIds: [] },
    }),
    system: true,
  };
}

/**
 * The id recorded as author, creator or uploader: always the signed-in user, never a value from
 * a request body. The system context is nobody, so it is refused rather than written into a
 * foreign key.
 */
export function authorOf(context: AccessContext): string {
  if (context.system) {
    throw new Error('A record with an author cannot be created without a signed-in user');
  }
  return context.userId;
}

/** True when the context holds at least one of the roles. An empty list never matches. */
export function hasAnyRole(context: AccessContext, roles: readonly Role[]): boolean {
  return roles.some((role) => context.roles.includes(role));
}

/** True when the user is one of the people the caller oversees (or the caller themselves). */
export function overseesUser(context: AccessContext, userId: string): boolean {
  const { userIds } = context.scope;
  return userIds === 'all' || userIds.includes(userId);
}
