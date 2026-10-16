import type { ResolvedScope, Role } from '@ops/shared';
import { buildAccessContext, type AccessContext } from './access-context';

/**
 * Builds an access context from a few facts, for unit tests of the rules (and for anyone who
 * wants to evaluate a rule without a database). Not used by the application.
 */
export function contextFor(
  userId: string,
  roles: Role[],
  scope: Partial<Omit<ResolvedScope, 'userId' | 'organizationId' | 'roles'>> = {},
): AccessContext {
  return buildAccessContext({
    userId,
    organizationId: 'org',
    active: true,
    roles,
    orgWide: false,
    siteIds: [],
    teamIds: [],
    userIds: [userId],
    colleagueIds: [userId],
    memberOf: { orgWide: false, siteIds: [], teamIds: [] },
    ...scope,
  });
}

/** A manager or an admin: organization-wide by rule. */
export function orgWideContextFor(userId: string, role: 'manager' | 'admin'): AccessContext {
  return contextFor(userId, [role], { orgWide: true, userIds: 'all' });
}
