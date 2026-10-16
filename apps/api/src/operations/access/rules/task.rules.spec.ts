import { contextFor, orgWideContextFor } from '../testing';
import {
  canAssignUser,
  canChangeTaskStatus,
  canManageTask,
  canPlaceTask,
  canSeeTask,
  type TaskFacts,
} from './task.rules';

function task(overrides: Partial<TaskFacts> = {}): TaskFacts {
  return {
    siteId: 'depot',
    teamId: null,
    createdById: 'sup',
    assigneeIds: ['worker'],
    status: 'todo',
    ...overrides,
  };
}

const worker = contextFor('worker', ['worker']);
const other = contextFor('other', ['worker']);
const supervisor = contextFor('sup', ['supervisor'], {
  siteIds: ['depot'],
  userIds: ['sup', 'worker'],
});
const manager = orgWideContextFor('boss', 'manager');

describe('task visibility', () => {
  it('shows a worker the tasks assigned to them only', () => {
    expect(canSeeTask(worker, task())).toBe(true);
    expect(canSeeTask(other, task())).toBe(false);
  });

  it('shows a supervisor tasks of their scope, of their people and their own', () => {
    expect(canSeeTask(supervisor, task({ assigneeIds: [] }))).toBe(true);
    expect(canSeeTask(supervisor, task({ siteId: 'harbour' }))).toBe(true);
    expect(
      canSeeTask(supervisor, task({ siteId: null, assigneeIds: [], createdById: 'sup' })),
    ).toBe(true);
    expect(
      canSeeTask(supervisor, task({ siteId: 'harbour', assigneeIds: ['x'], createdById: 'x' })),
    ).toBe(false);
  });
});

describe('managing tasks', () => {
  it('refuses a worker (403 on a task they see, 404 otherwise)', () => {
    expect(canManageTask(worker, task())).toMatchObject({ outcome: 'forbidden' });
    expect(canManageTask(other, task())).toMatchObject({ outcome: 'not_found' });
  });

  it('lets a supervisor manage tasks placed in their scope only', () => {
    expect(canManageTask(supervisor, task()).allowed).toBe(true);
    expect(canManageTask(supervisor, task({ siteId: 'harbour' }))).toMatchObject({
      outcome: 'forbidden',
    });
    expect(canPlaceTask(supervisor, { siteId: null, teamId: null }).allowed).toBe(false);
    expect(canPlaceTask(manager, { siteId: null, teamId: null }).allowed).toBe(true);
  });

  it('lets a supervisor assign their people only; a manager anyone', () => {
    expect(canAssignUser(supervisor, 'worker')).toBe(true);
    expect(canAssignUser(supervisor, 'stranger')).toBe(false);
    expect(canAssignUser(manager, 'stranger')).toBe(true);
  });
});

describe('changing a task status', () => {
  it.each(['todo', 'in_progress', 'blocked', 'done'] as const)(
    'lets an assignee set %s',
    (status) => {
      expect(canChangeTaskStatus(worker, task(), status).allowed).toBe(true);
    },
  );

  it('does not let an assignee cancel, or reopen a cancelled task', () => {
    expect(canChangeTaskStatus(worker, task(), 'cancelled')).toMatchObject({
      outcome: 'forbidden',
    });
    expect(canChangeTaskStatus(worker, task({ status: 'cancelled' }), 'todo')).toMatchObject({
      outcome: 'forbidden',
    });
  });

  it('lets whoever manages the task set any status', () => {
    expect(canChangeTaskStatus(supervisor, task(), 'cancelled').allowed).toBe(true);
    expect(canChangeTaskStatus(manager, task({ status: 'cancelled' }), 'todo').allowed).toBe(true);
  });
});
