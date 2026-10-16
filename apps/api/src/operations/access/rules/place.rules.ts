import type { AccessContext } from '../access-context';
import {
  anyOf,
  EVERYTHING,
  fieldIn,
  isVisible,
  relationIn,
  visibilityWhere,
  type Visibility,
  type WhereFragment,
} from '../visibility';

/** What the rules need to know about a site or a team. */
export interface PlaceFacts {
  id: string;
  /** Users assigned to a non-archived task that belongs to this site or team. */
  taskAssigneeIds: readonly string[];
}

const TASK_ASSIGNEE_PATH = ['tasks', 'some', 'assignees', 'some', 'userId'] as const;

function placeVisibility(
  context: AccessContext,
  overseen: readonly string[],
  memberOf: readonly string[],
): Visibility<PlaceFacts> {
  // Someone who oversees or works in the whole organization sees every site and team.
  if (context.scope.orgWide || context.scope.memberOf.orgWide) {
    return EVERYTHING;
  }
  return anyOf<PlaceFacts>(
    fieldIn('id', [...overseen, ...memberOf]),
    relationIn('taskAssigneeIds', TASK_ASSIGNEE_PATH, [context.userId], { activeOnly: ['tasks'] }),
  );
}

/**
 * Who sees a site: manager and admin all of them; a supervisor the sites of their scope; and
 * everyone the sites they belong to as a worker (descendants included) plus the sites of the
 * tasks assigned to them. Managing sites is a route-level rule (manager and admin).
 */
export function siteVisibility(context: AccessContext): Visibility<PlaceFacts> {
  return placeVisibility(context, context.scope.siteIds, context.scope.memberOf.siteIds);
}

export function canSeeSite(context: AccessContext, site: PlaceFacts): boolean {
  return isVisible(siteVisibility(context), site);
}

export function siteVisibilityWhere(context: AccessContext): WhereFragment {
  return visibilityWhere(siteVisibility(context));
}

/** Who sees a team: the same rule as for a site, read on the team side of the scope. */
export function teamVisibility(context: AccessContext): Visibility<PlaceFacts> {
  return placeVisibility(context, context.scope.teamIds, context.scope.memberOf.teamIds);
}

export function canSeeTeam(context: AccessContext, team: PlaceFacts): boolean {
  return isVisible(teamVisibility(context), team);
}

export function teamVisibilityWhere(context: AccessContext): WhereFragment {
  return visibilityWhere(teamVisibility(context));
}
