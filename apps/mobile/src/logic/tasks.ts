import type { Task, TaskPriority, TaskStatus } from '@ops/shared';

import { addLocalDays, parseIso, startOfLocalDay } from './dates';

// What the worker sees of their tasks: which are open, which are due today or overdue, in what
// order, and which status changes they may make. Pure functions; `now` is passed in.

/** The filters of the "My tasks" screen. */
export const TASK_FILTERS = ['open', 'today', 'overdue', 'done'] as const;
export type TaskFilter = (typeof TASK_FILTERS)[number];

const OPEN_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked'];

export function isOpenTask(task: Pick<Task, 'status'>): boolean {
  return OPEN_STATUSES.includes(task.status);
}

/** Open and its due time has passed. */
export function isOverdue(task: Pick<Task, 'status' | 'dueAt'>, now: Date): boolean {
  const due = parseIso(task.dueAt);
  return isOpenTask(task) && due !== null && due.getTime() < now.getTime();
}

/** Open and due some time during today (local), earlier today included. */
export function isDueToday(task: Pick<Task, 'status' | 'dueAt'>, now: Date): boolean {
  const due = parseIso(task.dueAt);
  if (!isOpenTask(task) || due === null) {
    return false;
  }
  const start = startOfLocalDay(now);
  const end = addLocalDays(start, 1);
  return due.getTime() >= start.getTime() && due.getTime() < end.getTime();
}

export type DueState = 'overdue' | 'today' | 'later' | 'none';

/** One label per task for the list: overdue wins over today. Closed tasks are `none`. */
export function dueState(task: Pick<Task, 'status' | 'dueAt'>, now: Date): DueState {
  if (!isOpenTask(task) || task.dueAt === null) return 'none';
  if (isOverdue(task, now)) return 'overdue';
  if (isDueToday(task, now)) return 'today';
  return 'later';
}

/** Whether a task belongs under a filter. `done` also holds cancelled tasks: both are closed. */
export function matchesTaskFilter(task: Task, filter: TaskFilter, now: Date): boolean {
  switch (filter) {
    case 'open':
      return isOpenTask(task);
    case 'today':
      return isDueToday(task, now);
    case 'overdue':
      return isOverdue(task, now);
    case 'done':
      return task.status === 'done' || task.status === 'cancelled';
  }
}

const PRIORITY_RANK: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const DUE_RANK: Record<DueState, number> = { overdue: 0, today: 1, later: 2, none: 3 };

/**
 * The order of a worker's list: overdue first, then due today, then later, then without a due
 * date; within each, the earliest due first, then the most urgent, then the title.
 */
export function compareTasksForWorker(a: Task, b: Task, now: Date): number {
  const byState = DUE_RANK[dueState(a, now)] - DUE_RANK[dueState(b, now)];
  if (byState !== 0) return byState;
  const dueA = parseIso(a.dueAt)?.getTime() ?? Number.POSITIVE_INFINITY;
  const dueB = parseIso(b.dueAt)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  return a.title.localeCompare(b.title);
}

/** Closed tasks: the most recently completed or changed first. */
function compareClosedTasks(a: Task, b: Task): number {
  const timeA = parseIso(a.completedAt ?? a.updatedAt)?.getTime() ?? 0;
  const timeB = parseIso(b.completedAt ?? b.updatedAt)?.getTime() ?? 0;
  return timeB - timeA;
}

/** The tasks of one filter, in display order. */
export function filterTasks(tasks: readonly Task[], filter: TaskFilter, now: Date): Task[] {
  const matching = tasks.filter((task) => matchesTaskFilter(task, filter, now));
  return filter === 'done'
    ? matching.sort(compareClosedTasks)
    : matching.sort((a, b) => compareTasksForWorker(a, b, now));
}

/** How many tasks each filter holds, for the counts on the filter buttons. */
export function countTasksByFilter(tasks: readonly Task[], now: Date): Record<TaskFilter, number> {
  const counts: Record<TaskFilter, number> = { open: 0, today: 0, overdue: 0, done: 0 };
  for (const task of tasks) {
    for (const filter of TASK_FILTERS) {
      if (matchesTaskFilter(task, filter, now)) counts[filter] += 1;
    }
  }
  return counts;
}

/**
 * The home screen's "today": open tasks that are overdue or due today, overdue first, at most
 * `limit` of them.
 */
export function tasksForToday(tasks: readonly Task[], now: Date, limit = 5): Task[] {
  return tasks
    .filter((task) => isOverdue(task, now) || isDueToday(task, now))
    .sort((a, b) => compareTasksForWorker(a, b, now))
    .slice(0, limit);
}

/**
 * The status changes the signed-in user may make from the phone, mirroring the API's rule for an
 * assignee (`canChangeTaskStatus`): their own task, not cancelled, to `todo`, `in_progress`,
 * `blocked` or `done`, never to the status it already has. A supervisor who manages the task may
 * do more on the web; the phone offers the assignee's moves only. The API decides in the end.
 */
/** The statuses an assignee may set: everything but `cancelled`. */
export type AssigneeTaskStatus = Exclude<TaskStatus, 'cancelled'>;

export function assigneeStatusActions(
  task: Pick<Task, 'status' | 'assigneeIds' | 'archivedAt'>,
  userId: string,
): AssigneeTaskStatus[] {
  if (task.archivedAt !== null || task.status === 'cancelled') return [];
  if (!task.assigneeIds.includes(userId)) return [];
  const actions: AssigneeTaskStatus[] =
    task.status === 'done' ? ['in_progress', 'todo'] : ['in_progress', 'blocked', 'done', 'todo'];
  // Same status is not a move, except "blocked" again with a new reason.
  return actions.filter((status) => status !== task.status || status === 'blocked');
}

/** `blocked` needs a reason (the API refuses it without one). */
export function statusNeedsReason(status: TaskStatus): boolean {
  return status === 'blocked';
}
