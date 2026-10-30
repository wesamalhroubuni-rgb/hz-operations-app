import type { UserProfileLevel } from '@ops/shared';
import { overseesUser, type AccessContext } from '../access-context';
import { ALLOW, forbid, type Decision } from '../decision';
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

/** What the rules need to know about a user. */
export interface UserFacts {
  id: string;
  /** Everyone assigned to a non-archived task this user is assigned to. */
  coAssigneeIds: readonly string[];
  /** Everyone assigned to a non-archived task this user created. */
  createdTaskAssigneeIds: readonly string[];
}

/**
 * Who sees a user at all (in whichever shape): everyone when the caller oversees the whole
 * organization; otherwise the caller themselves, the people of their scope, the people they
 * work with (same site or team, and the supervisors there), and the people on their tasks
 * (co-assignees and the creator).
 */
export function userVisibility(context: AccessContext): Visibility<UserFacts> {
  const { scope } = context;
  if (scope.orgWide || scope.userIds === 'all') {
    return EVERYTHING;
  }
  const me = [context.userId];
  return anyOf<UserFacts>(
    fieldIn('id', [...me, ...scope.userIds, ...scope.colleagueIds]),
    relationIn(
      'coAssigneeIds',
      ['taskAssignments', 'some', 'task', 'assignees', 'some', 'userId'],
      me,
      { activeOnly: ['task'] },
    ),
    relationIn(
      'createdTaskAssigneeIds',
      ['createdTasks', 'some', 'assignees', 'some', 'userId'],
      me,
      { activeOnly: ['createdTasks'] },
    ),
  );
}

export function canSeeUser(context: AccessContext, user: UserFacts): boolean {
  return isVisible(userVisibility(context), user);
}

/** Prisma `where` fragment of {@link canSeeUser}; both read {@link userVisibility}. */
export function userVisibilityWhere(context: AccessContext): WhereFragment {
  return visibilityWhere(userVisibility(context));
}

/**
 * The shape a visible user is returned in:
 * - `full` (identifiers, memberships, activation, timestamps): an admin for everyone, and
 *   everyone for themselves;
 * - `contact` (adds email and phone): a manager for everyone, a supervisor for their people;
 * - `basic` (id, name, roles): everybody else the caller can see.
 */
export function userProfileLevel(context: AccessContext, userId: string): UserProfileLevel {
  if (context.isAdmin || userId === context.userId) {
    return 'full';
  }
  if (context.isManagerOrAbove || (context.isSupervisorOrAbove && overseesUser(context, userId))) {
    return 'contact';
  }
  return 'basic';
}

/**
 * Whose email and phone a search term may be matched against: only users the caller gets at
 * least the contact shape of (the username is searched for admins only, who see every field).
 * Searching a field the caller cannot read would let them guess its content one character at a
 * time.
 */
export function contactVisibility(context: AccessContext): Visibility<{ id: string }> {
  if (context.isManagerOrAbove) {
    return EVERYTHING;
  }
  if (!context.isSupervisorOrAbove) {
    return anyOf<{ id: string }>(fieldIn('id', [context.userId]));
  }
  const { userIds } = context.scope;
  return userIds === 'all'
    ? EVERYTHING
    : anyOf<{ id: string }>(fieldIn('id', [context.userId, ...userIds]));
}

export function contactVisibilityWhere(context: AccessContext): WhereFragment {
  return visibilityWhere(contactVisibility(context));
}

/** True when every user the caller can list comes with contact details (sorting by email is safe). */
export function seesEveryContact(context: AccessContext): boolean {
  return contactVisibility(context).all;
}

/** The fields a user may change about themselves (Phase 6 added the language). */
export const SELF_EDITABLE_USER_FIELDS: readonly string[] = ['displayName', 'locale'];

/**
 * Changing a user the caller can see (the service loads the user through
 * {@link userVisibilityWhere} first, which answers 404 for anyone else): an admin changes every
 * field of anyone; everyone else changes only their own display name and language.
 *
 * @param changedFields the keys present in the request body
 */
export function canUpdateUser(
  context: AccessContext,
  targetUserId: string,
  changedFields: readonly string[],
): Decision {
  if (context.isAdmin) {
    return ALLOW;
  }
  if (targetUserId !== context.userId) {
    return forbid('Only an admin can change another user');
  }
  const refused = changedFields.filter((field) => !SELF_EDITABLE_USER_FIELDS.includes(field));
  return refused.length === 0
    ? ALLOW
    : forbid(
        `Only an admin can change: ${refused.join(', ')}. You can change your display name ` +
          'and language',
      );
}
