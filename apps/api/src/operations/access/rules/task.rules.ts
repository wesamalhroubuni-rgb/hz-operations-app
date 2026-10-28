import type { TaskStatus } from '@ops/shared';
import type { AccessContext } from '../access-context';
import { ALLOW, conflict, forbid, notVisible, type Decision } from '../decision';
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

/** What the rules need to know about a task. */
export interface TaskFacts {
  siteId: string | null;
  teamId: string | null;
  createdById: string;
  assigneeIds: readonly string[];
  status: TaskStatus;
}

type TaskPlacement = Pick<TaskFacts, 'siteId' | 'teamId' | 'createdById' | 'assigneeIds'>;

/**
 * Who sees a task: its assignees; whoever oversees the whole organization; a supervisor when
 * the task's site or team is in their scope, when an assignee is one of their people, or when
 * they created it. A worker therefore sees the tasks assigned to them only.
 */
export function taskVisibility(context: AccessContext): Visibility<TaskPlacement> {
  const { scope } = context;
  if (scope.orgWide || scope.userIds === 'all') {
    return EVERYTHING;
  }
  return anyOf<TaskPlacement>(
    relationIn('assigneeIds', ['assignees', 'some', 'userId'], [context.userId, ...scope.userIds]),
    fieldIn('siteId', scope.siteIds),
    fieldIn('teamId', scope.teamIds),
    fieldIn('createdById', context.isSupervisorOrAbove ? [context.userId] : []),
  );
}

export function canSeeTask(context: AccessContext, task: TaskPlacement): boolean {
  return isVisible(taskVisibility(context), task);
}

/** Prisma `where` fragment of {@link canSeeTask}; both read {@link taskVisibility}. */
export function taskVisibilityWhere(context: AccessContext): WhereFragment {
  return visibilityWhere(taskVisibility(context));
}

/**
 * Where a task may be placed by this caller: anywhere for someone who oversees the whole
 * organization; otherwise the task must belong to a site or a team of the caller's scope
 * (one of the two is enough, as for visibility). A task with neither has no place in a scope,
 * so only an organization-wide caller can create one.
 */
export function canPlaceTask(
  context: AccessContext,
  placement: Pick<TaskFacts, 'siteId' | 'teamId'>,
): Decision {
  if (!context.isSupervisorOrAbove) {
    return forbid('Only a supervisor, manager or admin can manage tasks');
  }
  if (context.scope.orgWide) {
    return ALLOW;
  }
  const inScope =
    (placement.siteId !== null && context.scope.siteIds.includes(placement.siteId)) ||
    (placement.teamId !== null && context.scope.teamIds.includes(placement.teamId));
  return inScope ? ALLOW : forbid('The task must belong to a site or a team within your scope');
}

/**
 * Creating, editing, assigning and archiving: a supervisor for tasks placed in their scope,
 * a manager or admin for every task. Being able to see a task (as an assignee, or because an
 * assignee is one of your people) is not enough to manage it.
 */
export function canManageTask(context: AccessContext, task: TaskFacts): Decision {
  if (!canSeeTask(context, task)) {
    return notVisible();
  }
  return canPlaceTask(context, task);
}

/**
 * Who may be made an assignee by this caller: anyone for an organization-wide caller, otherwise
 * only the caller's people (the users of their scope, themselves included).
 */
export function assignableUserVisibility(context: AccessContext): Visibility<{ id: string }> {
  const { scope } = context;
  if (scope.orgWide || scope.userIds === 'all') {
    return EVERYTHING;
  }
  return anyOf<{ id: string }>(fieldIn('id', [context.userId, ...scope.userIds]));
}

export function canAssignUser(context: AccessContext, userId: string): boolean {
  return isVisible(assignableUserVisibility(context), { id: userId });
}

export function assignableUserWhere(context: AccessContext): WhereFragment {
  return visibilityWhere(assignableUserVisibility(context));
}

/** The statuses an assignee may give their task. Cancelling is a management decision. */
export const ASSIGNEE_TASK_STATUSES: readonly TaskStatus[] = [
  'todo',
  'in_progress',
  'blocked',
  'done',
];

/**
 * Changing the status: whoever may manage the task sets any status; an assignee moves their
 * task between `todo`, `in_progress`, `blocked` and `done`, and can neither cancel it nor bring
 * a cancelled task back.
 */
export function canChangeTaskStatus(
  context: AccessContext,
  task: TaskFacts,
  to: TaskStatus,
): Decision {
  if (!canSeeTask(context, task)) {
    return notVisible();
  }
  if (canPlaceTask(context, task).allowed) {
    return ALLOW;
  }
  if (!task.assigneeIds.includes(context.userId)) {
    return forbid(
      'Only an assignee or a manager of this task can change its status',
      'task_not_assigned',
    );
  }
  if (task.status === 'cancelled') {
    return conflict(
      'A cancelled task can only be reopened by whoever manages it',
      'task_cancelled',
    );
  }
  return ASSIGNEE_TASK_STATUSES.includes(to)
    ? ALLOW
    : forbid(`An assignee cannot set a task to ${to}`);
}
