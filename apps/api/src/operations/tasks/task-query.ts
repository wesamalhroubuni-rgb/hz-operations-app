import { OPEN_TASK_STATUSES, type ListTasksQuery } from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { taskVisibilityWhere, type AccessContext } from '../access';
import { activeUnless, contains } from '../common/db';

/** The filters the task list, the CSV export and the dashboard links share (`taskFilterShape`). */
export type TaskFilters = Partial<Omit<ListTasksQuery, 'page' | 'pageSize' | 'sort'>>;

/** An open task: not done and not cancelled. */
export const OPEN_TASK: Prisma.TaskWhereInput = { status: { in: [...OPEN_TASK_STATUSES] } };

/** An open task whose due time is before `now`. */
export function overdueTask(now: Date): Prisma.TaskWhereInput {
  return { ...OPEN_TASK, dueAt: { lt: now } };
}

/**
 * The one `where` of every task read: the caller's organization, the caller's visibility (under
 * `AND`, so the filters can only narrow it), and the filters asked for. `now` is the server
 * clock that `overdue` is judged by.
 */
export function taskWhere(
  context: AccessContext,
  filters: TaskFilters,
  now: Date,
): Prisma.TaskWhereInput {
  const and: Prisma.TaskWhereInput[] = [taskVisibilityWhere(context) as Prisma.TaskWhereInput];
  if (filters.search) {
    and.push({
      OR: [{ title: contains(filters.search) }, { description: contains(filters.search) }],
    });
  }
  if (filters.open !== undefined) {
    and.push(filters.open ? OPEN_TASK : { NOT: OPEN_TASK });
  }
  if (filters.overdue !== undefined) {
    // Not overdue, written out so that a task without a due time matches (SQL's NOT over a NULL
    // comparison would drop it).
    and.push(
      filters.overdue
        ? overdueTask(now)
        : { OR: [{ NOT: OPEN_TASK }, { dueAt: null }, { dueAt: { gte: now } }] },
    );
  }
  if (filters.dueFrom || filters.dueTo) {
    and.push({
      dueAt: {
        ...(filters.dueFrom ? { gte: new Date(filters.dueFrom) } : {}),
        ...(filters.dueTo ? { lt: new Date(filters.dueTo) } : {}),
      },
    });
  }
  return {
    organizationId: context.organizationId,
    ...activeUnless(filters.includeArchived ?? false),
    AND: and,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.priority ? { priority: filters.priority } : {}),
    ...(filters.siteId ? { siteId: filters.siteId } : {}),
    ...(filters.teamId ? { teamId: filters.teamId } : {}),
    ...(filters.createdById ? { createdById: filters.createdById } : {}),
    ...(filters.assigneeId ? { assignees: { some: { userId: filters.assigneeId } } } : {}),
  };
}
