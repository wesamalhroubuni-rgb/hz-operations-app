import { ORG_WIDE_ROLES, ROLES, type ResolvedScope, type Role } from '@ops/shared';
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

/** Manager and admin memberships cover the whole organization, whatever the row says. */
function isOrgWide(membership: ScopeMembership): boolean {
  return membership.orgWide || ORG_WIDE_ROLES.includes(membership.role);
}

/** Where a membership places its holder: everywhere, or its sites and teams with descendants. */
interface Places {
  everywhere: boolean;
  siteIds: Set<string>;
  teamIds: Set<string>;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const id of left) {
    if (right.has(id)) {
      return true;
    }
  }
  return false;
}

function isSomewhere(places: Places): boolean {
  return places.everywhere || places.siteIds.size > 0 || places.teamIds.size > 0;
}

function sharePlace(mine: Places, theirs: Places): boolean {
  if (mine.everywhere || theirs.everywhere) {
    return isSomewhere(mine) && isSomewhere(theirs);
  }
  return intersects(mine.siteIds, theirs.siteIds) || intersects(mine.teamIds, theirs.teamIds);
}

/**
 * Resolves what a user may see from their memberships. Pure: plain data in, plain data out.
 *
 * Rules
 * 1. An archived membership grants nothing. An archived user has no scope at all: `active` is
 *    false, there are no roles, and only their own id is listed.
 * 2. A `worker` membership gives no view of other people's records. It marks where the user
 *    works: its sites and teams (descendants included) go to `memberOf`, and `memberOf.orgWide`
 *    is true when the membership is organization-wide. A worker sees their own records only.
 * 3. A `supervisor` membership gives a view over its scope. If it is `orgWide`, that is the
 *    whole organization. Otherwise it is the union of its sites and its teams, each including
 *    all descendants through `parentId`. Sites and teams on one membership are a union, never
 *    an intersection.
 * 4. A `manager` or `admin` membership ALWAYS covers the whole organization. The API refuses to
 *    store one that is not `orgWide` or that lists sites or teams; a row that says otherwise
 *    (written before that rule) is still read as organization-wide, and its sites and teams are
 *    ignored. What each role may DO is decided by the access rules, not here.
 * 5. Several memberships combine as a union.
 * 6. Visible users (`userIds`): always the user themselves, plus every user who holds an active
 *    membership at a visible site or team. A worker membership counts at its sites and teams
 *    and all their descendants (a worker of a region works at each of its sites); a supervisor
 *    membership counts only where it is scoped directly, so a supervisor does not see the
 *    supervisor above. When the view is organization-wide it is everyone, written as `'all'`.
 *    An organization-wide membership of somebody else does not make that person visible to a
 *    site or team supervisor: only a site or team in common does. Archived colleagues stay
 *    listed, so their past records remain visible.
 * 7. A user with no active membership sees only themselves.
 * 8. Colleagues (`colleagueIds`): always the user themselves, plus, for each place where the
 *    user WORKS (their worker memberships, descendants included), everyone who works there too
 *    and every supervisor of that place. A supervisor is "of that place" when their scope
 *    covers it, descendants included (the supervisor of a region is the supervisor of each of
 *    its sites) or is organization-wide. Managers and admins are not listed: a worker meets
 *    them only through a task. Colleagues are people a worker may see by name; the list gives
 *    no view of their records.
 *
 * Archived sites and teams still count as scope and still pass scope down to their
 * descendants, so records attached to them stay visible to whoever supervised them.
 *
 * `siteIds`, `teamIds`, `userIds` and `colleagueIds` are sorted, so equal scopes compare equal.
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
  const orgWide = oversight.some(isOrgWide);

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
      // A manager or admin is organization-wide and scoped nowhere in particular (rule 4).
      if (membership.archived || ORG_WIDE_ROLES.includes(membership.role)) {
        continue;
      }
      // A worker membership means belonging, and belonging passes down the tree (see `memberOf`
      // below): a worker assigned to a region works at each of its sites, so the supervisor of
      // one of those sites sees them. A supervisor membership is authority, not belonging, so
      // it only counts where it is scoped directly: a site supervisor does not get to see the
      // regional supervisor above them.
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

  const memberOf: Places = {
    everywhere: worker.some((membership) => membership.orgWide),
    siteIds: withDescendants(
      input.sites,
      worker.flatMap((membership) => membership.siteIds),
    ),
    teamIds: withDescendants(
      input.teams,
      worker.flatMap((membership) => membership.teamIds),
    ),
  };

  const colleagues = new Set([user.id]);
  if (isSomewhere(memberOf)) {
    for (const membership of input.memberships) {
      if (
        membership.archived ||
        ORG_WIDE_ROLES.includes(membership.role) ||
        colleagues.has(membership.userId)
      ) {
        continue;
      }
      const theirs: Places = {
        everywhere: membership.orgWide,
        siteIds: withDescendants(input.sites, membership.siteIds),
        teamIds: withDescendants(input.teams, membership.teamIds),
      };
      if (sharePlace(memberOf, theirs)) {
        colleagues.add(membership.userId);
      }
    }
  }

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
    colleagueIds: [...colleagues].sort(),
    memberOf: {
      orgWide: memberOf.everywhere,
      siteIds: [...memberOf.siteIds].sort(),
      teamIds: [...memberOf.teamIds].sort(),
    },
  };
}
