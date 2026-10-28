import type { Task } from '@ops/shared';

import {
  assigneeStatusActions,
  countTasksByFilter,
  dueState,
  filterTasks,
  isDueToday,
  isOverdue,
  statusNeedsReason,
  tasksForToday,
} from './tasks';

// Local time: 2026-10-16 10:00.
const NOW = new Date(2026, 9, 16, 10, 0, 0);
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0, 0).toISOString();
const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

let counter = 0;
function task(overrides: Partial<Task> = {}): Task {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    organizationId: '00000000-0000-4000-8000-0000000000aa',
    title: `Task ${counter}`,
    description: null,
    status: 'todo',
    priority: 'normal',
    siteId: null,
    teamId: null,
    createdById: OTHER,
    assigneeIds: [ME],
    dueAt: null,
    completedAt: null,
    statusReason: null,
    version: 1,
    createdAt: at(1, 9),
    updatedAt: at(1, 9),
    archivedAt: null,
    ...overrides,
  };
}

describe('due states', () => {
  it('calls an open task whose due time passed overdue, even earlier today', () => {
    expect(isOverdue(task({ dueAt: at(16, 8) }), NOW)).toBe(true);
    expect(isOverdue(task({ dueAt: at(15, 18) }), NOW)).toBe(true);
    expect(isOverdue(task({ dueAt: at(16, 12) }), NOW)).toBe(false);
  });

  it('never calls a closed task overdue', () => {
    expect(isOverdue(task({ dueAt: at(10, 8), status: 'done' }), NOW)).toBe(false);
    expect(isOverdue(task({ dueAt: at(10, 8), status: 'cancelled' }), NOW)).toBe(false);
  });

  it('counts everything due during the local day as due today, up to midnight', () => {
    expect(isDueToday(task({ dueAt: at(16, 0) }), NOW)).toBe(true);
    expect(isDueToday(task({ dueAt: at(16, 23) }), NOW)).toBe(true);
    expect(isDueToday(task({ dueAt: at(17, 0) }), NOW)).toBe(false);
    expect(isDueToday(task({ dueAt: null }), NOW)).toBe(false);
  });

  it('labels each task once, overdue before today', () => {
    expect(dueState(task({ dueAt: at(16, 8) }), NOW)).toBe('overdue');
    expect(dueState(task({ dueAt: at(16, 15) }), NOW)).toBe('today');
    expect(dueState(task({ dueAt: at(20, 15) }), NOW)).toBe('later');
    expect(dueState(task(), NOW)).toBe('none');
    expect(dueState(task({ dueAt: at(16, 8), status: 'done' }), NOW)).toBe('none');
  });
});

describe('filterTasks', () => {
  const overdue = task({ title: 'Overdue', dueAt: at(14, 9) });
  const today = task({ title: 'Today', dueAt: at(16, 16), priority: 'urgent' });
  const later = task({ title: 'Later', dueAt: at(20, 9) });
  const undated = task({ title: 'Undated' });
  const blocked = task({ title: 'Blocked', status: 'blocked', dueAt: at(16, 11) });
  const done = task({ title: 'Done', status: 'done', completedAt: at(15, 12), dueAt: at(10, 9) });
  const cancelled = task({ title: 'Cancelled', status: 'cancelled', updatedAt: at(16, 9) });
  const all = [undated, done, later, today, cancelled, overdue, blocked];

  it('orders open tasks overdue first, then today, then later, then undated', () => {
    expect(filterTasks(all, 'open', NOW).map((t) => t.title)).toEqual([
      'Overdue',
      'Blocked',
      'Today',
      'Later',
      'Undated',
    ]);
  });

  it('shows due today (passed or not) and overdue separately', () => {
    expect(filterTasks(all, 'today', NOW).map((t) => t.title)).toEqual(['Blocked', 'Today']);
    expect(filterTasks(all, 'overdue', NOW).map((t) => t.title)).toEqual(['Overdue']);
  });

  it('keeps done and cancelled under done, most recent first', () => {
    expect(filterTasks(all, 'done', NOW).map((t) => t.title)).toEqual(['Cancelled', 'Done']);
  });

  it('counts each filter', () => {
    expect(countTasksByFilter(all, NOW)).toEqual({ open: 5, today: 2, overdue: 1, done: 2 });
  });

  it('puts the most urgent first among tasks due at the same time', () => {
    const a = task({ title: 'A', dueAt: at(18, 9), priority: 'low' });
    const b = task({ title: 'B', dueAt: at(18, 9), priority: 'high' });
    expect(filterTasks([a, b], 'open', NOW).map((t) => t.title)).toEqual(['B', 'A']);
  });

  it("limits the home screen's today list to overdue and due-today tasks", () => {
    expect(tasksForToday(all, NOW).map((t) => t.title)).toEqual(['Overdue', 'Blocked', 'Today']);
    expect(tasksForToday(all, NOW, 1)).toHaveLength(1);
  });
});

describe('due and overdue edges (Phase 4 coverage)', () => {
  it('a task due exactly now is due today, not overdue; a millisecond earlier it is overdue', () => {
    const now = NOW.toISOString();
    expect(dueState(task({ dueAt: now }), NOW)).toBe('today');
    expect(dueState(task({ dueAt: new Date(NOW.getTime() - 1).toISOString() }), NOW)).toBe(
      'overdue',
    );
  });

  it('counts a blocked or in-progress task as open for the due filters; done and cancelled never', () => {
    for (const status of ['in_progress', 'blocked'] as const) {
      expect(isOverdue(task({ status, dueAt: at(15, 9) }), NOW)).toBe(true);
    }
    const closed = [
      task({ status: 'done', dueAt: at(16, 15) }),
      task({ status: 'cancelled', dueAt: at(14, 9) }),
    ];
    expect(countTasksByFilter(closed, NOW)).toEqual({ open: 0, today: 0, overdue: 0, done: 2 });
    expect(tasksForToday(closed, NOW)).toEqual([]);
  });

  it('ignores an unreadable due date instead of calling the task overdue', () => {
    expect(dueState(task({ dueAt: 'not a date' }), NOW)).toBe('later');
    expect(isOverdue(task({ dueAt: 'not a date' }), NOW)).toBe(false);
    expect(isDueToday(task({ dueAt: 'not a date' }), NOW)).toBe(false);
  });

  it('orders by due time before priority, and by title last', () => {
    const urgentLater = task({ title: 'Urgent later', dueAt: at(18, 12), priority: 'urgent' });
    const lowSooner = task({ title: 'Low sooner', dueAt: at(18, 9), priority: 'low' });
    const sameB = task({ title: 'B', dueAt: at(19, 9) });
    const sameA = task({ title: 'A', dueAt: at(19, 9) });
    expect(
      filterTasks([urgentLater, sameB, lowSooner, sameA], 'open', NOW).map((t) => t.title),
    ).toEqual(['Low sooner', 'Urgent later', 'A', 'B']);
  });
});

describe('assigneeStatusActions (mirrors the API rule for assignees)', () => {
  // The integration suite apps/api/test/worker-app.int-spec.ts drives these same moves through
  // the API and checks that every move offered here is accepted there.
  it('offers blocked again on a blocked task, to update the reason (the API allows it)', () => {
    expect(assigneeStatusActions(task({ status: 'blocked' }), ME)).toContain('blocked');
  });

  it('a co-assignee gets the same moves', () => {
    expect(assigneeStatusActions(task({ assigneeIds: [OTHER, ME] }), ME)).toEqual([
      'in_progress',
      'blocked',
      'done',
    ]);
  });

  it('offers start, blocked, done and back to to-do, never the current status (blocked excepted)', () => {
    expect(assigneeStatusActions(task({ status: 'todo' }), ME)).toEqual([
      'in_progress',
      'blocked',
      'done',
    ]);
    expect(assigneeStatusActions(task({ status: 'in_progress' }), ME)).toEqual([
      'blocked',
      'done',
      'todo',
    ]);
    expect(assigneeStatusActions(task({ status: 'blocked' }), ME)).toEqual([
      'in_progress',
      'blocked',
      'done',
      'todo',
    ]);
  });

  it('lets a finished task be reopened', () => {
    expect(assigneeStatusActions(task({ status: 'done' }), ME)).toEqual(['in_progress', 'todo']);
  });

  it('never offers cancelling, and nothing on a cancelled task', () => {
    for (const status of ['todo', 'in_progress', 'blocked', 'done'] as const) {
      expect(assigneeStatusActions(task({ status }), ME)).not.toContain('cancelled');
    }
    expect(assigneeStatusActions(task({ status: 'cancelled' }), ME)).toEqual([]);
  });

  it('offers nothing to someone who is not assigned, or on an archived task', () => {
    expect(assigneeStatusActions(task({ assigneeIds: [OTHER] }), ME)).toEqual([]);
    expect(assigneeStatusActions(task({ archivedAt: at(15, 9) }), ME)).toEqual([]);
  });

  it('asks for a reason only when blocking', () => {
    expect(statusNeedsReason('blocked')).toBe(true);
    expect(statusNeedsReason('done')).toBe(false);
  });
});
