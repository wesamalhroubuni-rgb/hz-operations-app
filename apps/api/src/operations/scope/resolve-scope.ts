import { ROLES, type ResolvedScope, type Role } from '@ops/shared';
import { withDescendants, type HierarchyNode } from '../common/hierarchy';

/** The user whose scope is resolved. */
export interface ScopeUser {
  id: string;
  organizationId: string;
  archived: boolean;
}

/** One membership of the organization, in plain data. */
export interface ScopeMembership {
  userId: string;
  role: Role;
  orgWide: boolean;
  archived: boolean;
  siteIds: readonly string[];
  teamIds: readonly string[];
}

export interface ScopeInput {
  user: ScopeUser;
  /** Every membership of the organization (the user's own and everyone else's). */
  memberships: readonly ScopeMembership[];
  /** Every site of the organization, archived ones included, as a tree. */
  sites: readonly HierarchyNode[];
  /** Every team of the organization, archived ones included, as a tree. */
  teams: readonly HierarchyNode[];
}

/** Roles whose memberships let the holder see other people's records within the scope. */
const OVERSIGHT_ROLES: ReadonlySet<Role> = new Set(['supervisor', 'manager', 'admin']);

/**
 * Resolves what a user may see from their memberships. Pure: plain data in, plain data out.
 *
 * Rules
 * 1. An archived membership grants nothing. An archived user has no scope at all: `active` is
 *    false, there are no roles, and only their own id is listed.
 * 2. A `worker` membership gives no view of other people. It marks where the user works:
 *    its sites and teams (descendants included) go to `memberOf`, and `memberOf.orgWide` is
 *    true when the membership is organization-wide. A worker sees their own records only.
 * 3. A `supervisor`, `manager` or `admin` membership gives a view over its scope. If it is
 *    `orgWide`, that is the whole organization. Otherwise it is the union of its sites and its
 *    teams, each including all descendants through `parentId`. Sites and teams on one
 *    membership are a union, never an intersection. The three roles see the same data here;
 *    what each may DO is a Phase 3 permission question, not a visibility one.
 * 4. Several memberships combine as a union.
 * 5. Visible users: always the user themselves, plus every user who holds an active membership
 *    at a visible site or team. A worker membership counts at its sites and teams and all their
 *    descendants (a worker of a region works at each of its sites); an oversight membership
 *    counts only where it is scoped directly, so a supervisor does not see the manager above. When the view is organization-wide
 *    it is everyone, written as `'all'`. An organization-wide membership of somebody else does
 *    not make that person visible to a site or team supervisor: only a site or team in common
 *    does. Archived colleagues stay listed, so their past records remain visible.
 * 6. A user with no active membership sees only themselves.
 *
 * Archived sites and teams still count as scope and still pass scope down to their
 * descendants, so records attached to them stay visible to whoever supervised them.
 *
 * `siteIds`, `teamIds` and `userIds` are sorted, so equal scopes compare equal.
 */
export function resolveScope(input: ScopeInput): ResolvedScope {
  const { user } = input;
  const own = user.archived
    ? []
    : input.memberships.filter(
        (membership) => membership.userId === user.id && !membership.archived,
      );

  const oversight = own.filter((membership) => OVERSIGHT_ROLES.has(membership.role));
  const worker = own.filter((membership) => membership.role === 'worker');
  const orgWide = oversight.some((membership) => membership.orgWide);

  const allSiteIds = input.sites.map((site) => site.id);
  const allTeamIds = input.teams.map((team) => team.id);
  const visibleSites = orgWide
    ? new Set(allSiteIds)
    : withDescendants(
        input.sites,
        oversight.flatMap((membership) => membership.siteIds),
      );
  const visibleTeams = orgWide
    ? new Set(allTeamIds)
    : withDescendants(
        input.teams,
        oversight.flatMap((membership) => membership.teamIds),
      );

  const visibleUsers = new Set([user.id]);
  if (!orgWide) {
    for (const membership of input.memberships) {
      if (membership.archived) {
        continue;
      }
      // A worker membership means belonging, and belonging passes down the tree (see `memberOf`
      // below): a worker assigned to a region works at each of its sites, so the supervisor of
      // one of those sites sees them. An oversight membership is authority, not belonging, so
      // it only counts where it is scoped directly: a site supervisor does not get to see the
      // regional manager above them.
      const siteIds =
        membership.role === 'worker'
          ? [...withDescendants(input.sites, membership.siteIds)]
          : membership.siteIds;
      const teamIds =
        membership.role === 'worker'
          ? [...withDescendants(input.teams, membership.teamIds)]
          : membership.teamIds;
      if (
        siteIds.some((siteId) => visibleSites.has(siteId)) ||
        teamIds.some((teamId) => visibleTeams.has(teamId))
      ) {
        visibleUsers.add(membership.userId);
      }
    }
  }

  const memberOfOrgWide = worker.some((membership) => membership.orgWide);
  const heldRoles = new Set(own.map((membership) => membership.role));

  return {
    userId: user.id,
    organizationId: user.organizationId,
    active: !user.archived,
    roles: ROLES.filter((role) => heldRoles.has(role)),
    orgWide,
    siteIds: [...visibleSites].sort(),
    teamIds: [...visibleTeams].sort(),
    userIds: orgWide ? 'all' : [...visibleUsers].sort(),
    memberOf: {
      orgWide: memberOfOrgWide,
      siteIds: [
        ...withDescendants(
          input.sites,
          worker.flatMap((membership) => membership.siteIds),
        ),
      ].sort(),
      teamIds: [
        ...withDescendants(
          input.teams,
          worker.flatMap((membership) => membership.teamIds),
        ),
      ].sort(),
    },
  };
}
