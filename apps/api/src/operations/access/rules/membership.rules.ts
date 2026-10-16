import { roleRank, type Role } from '@ops/shared';
import type { AccessContext } from '../access-context';
import { ALLOW, conflict, forbid, type Decision } from '../decision';

/** The role and scope of a membership, as granted or as stored. */
export interface MembershipGrant {
  role: Role;
  orgWide: boolean;
  siteIds: readonly string[];
  teamIds: readonly string[];
}

/**
 * No privilege escalation: nobody grants a role higher than their own highest role, nor a scope
 * outside their own. It is checked on the membership being created, on the result of an update,
 * and on an existing membership before it is changed or archived (so a lower role can never
 * touch a higher one). Admins are organization-wide and hold the highest role, so they satisfy
 * it trivially; the rule is written for any granter.
 */
export function canGrantMembership(context: AccessContext, grant: MembershipGrant): Decision {
  if (roleRank(grant.role) < 0 || roleRank(grant.role) > roleRank(context.highestRole)) {
    return forbid('You cannot grant or change a role higher than your own');
  }
  if (context.scope.orgWide) {
    return ALLOW;
  }
  const outside =
    grant.orgWide ||
    grant.siteIds.some((siteId) => !context.scope.siteIds.includes(siteId)) ||
    grant.teamIds.some((teamId) => !context.scope.teamIds.includes(teamId));
  return outside ? forbid('You cannot grant or change a scope outside your own') : ALLOW;
}

/** One active admin membership of a user who is not archived. */
export interface AdminHolder {
  membershipId: string;
  userId: string;
}

/**
 * The last active admin of an organization cannot be archived, demoted or stripped of the admin
 * membership: after the change at least one active user must still hold an active admin
 * membership. Answers 409 (the caller is entitled to manage users; the organization's state
 * forbids this particular change).
 *
 * @param holders every active admin membership of a non-archived user, before the change
 * @param removal what the change takes away: one membership (archived or demoted) and/or
 *   every membership of one user (the user is archived)
 */
export function canRemoveAdmin(
  holders: readonly AdminHolder[],
  removal: { membershipId?: string; userId?: string },
): Decision {
  const remaining = holders.filter(
    (holder) => holder.membershipId !== removal.membershipId && holder.userId !== removal.userId,
  );
  if (remaining.length === holders.length || remaining.length > 0) {
    return ALLOW;
  }
  return conflict('The organization must keep at least one active admin');
}

/**
 * True when an update takes something away from the holder: a lower role, the loss of
 * organization-wide scope, or a site or team removed. Their sessions are ended then, so the
 * next request cannot run with what they no longer have.
 */
export function isMembershipReduced(before: MembershipGrant, after: MembershipGrant): boolean {
  return (
    roleRank(after.role) < roleRank(before.role) ||
    (before.orgWide && !after.orgWide) ||
    before.siteIds.some((siteId) => !after.siteIds.includes(siteId)) ||
    before.teamIds.some((teamId) => !after.teamIds.includes(teamId))
  );
}
