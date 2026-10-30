import { TASK_STATUSES, type ChangeTaskStatus } from '@ops/shared';
import { describe, expect, it, vi } from 'vitest';

import { httpFailure, IDS, makeTask, ok } from './__fixtures__/agent-c-fixtures';
import { capabilitiesFor } from './permissions';
import {
  createTaskBody,
  dueInputToIso,
  editTaskBodies,
  emptyTaskForm,
  formatTaskHistoryValue,
  groupTasksByStatus,
  historyActionKey,
  isoToDueInput,
  isOverdue,
  statusChangeBody,
  submitTaskStatusChange,
  taskActions,
  taskFormFrom,
  taskWriteRefusal,
} from './tasks';
import { ApiCallError } from './api/errors';

const TZ = 'Europe/Istanbul';

describe('board grouping by status', () => {
  it('has every status in TASK_STATUSES order, keeping the list order inside a column', () => {
    const tasks = [
      makeTask({ id: 'a', status: 'done' }),
      makeTask({ id: 'b', status: 'blocked' }),
      makeTask({ id: 'c', status: 'todo' }),
      makeTask({ id: 'd', status: 'blocked' }),
    ];
    const groups = groupTasksByStatus(tasks);
    expect(Object.keys(groups)).toEqual([...TASK_STATUSES]);
    expect(groups.blocked.map((task) => task.id)).toEqual(['b', 'd']);
    expect(groups.todo.map((task) => task.id)).toEqual(['c']);
    expect(groups.in_progress).toEqual([]);
    expect(groups.cancelled).toEqual([]);
  });
});

describe('overdue', () => {
  const now = new Date('2026-10-28T12:00:00Z');
  it('is open and due before now', () => {
    expect(isOverdue(makeTask({ dueAt: '2026-10-28T11:00:00Z' }), now)).toBe(true);
    expect(isOverdue(makeTask({ dueAt: '2026-10-28T13:00:00Z' }), now)).toBe(false);
    expect(isOverdue(makeTask({ dueAt: '2026-10-01T00:00:00Z', status: 'done' }), now)).toBe(false);
    expect(isOverdue(makeTask({ dueAt: null }), now)).toBe(false);
  });
});

describe('task actions by role', () => {
  it('offers managing actions to supervisors, managers and admins, nothing to workers', () => {
    for (const role of ['supervisor', 'manager', 'admin']) {
      expect(taskActions(capabilitiesFor([role]), makeTask())).toEqual({
        edit: true,
        assign: true,
        changeStatus: true,
        cancel: true,
        archive: true,
      });
    }
    expect(Object.values(taskActions(capabilitiesFor(['worker']), makeTask()))).not.toContain(true);
  });

  it('offers nothing on an archived task and no cancel on a cancelled one', () => {
    const admin = capabilitiesFor(['admin']);
    expect(
      Object.values(taskActions(admin, makeTask({ archivedAt: '2026-10-21T00:00:00Z' }))),
    ).not.toContain(true);
    expect(taskActions(admin, makeTask({ status: 'cancelled' })).cancel).toBe(false);
  });
});

describe('due dates in the organization time zone', () => {
  it('reads a datetime-local value as Istanbul wall time and back', () => {
    expect(dueInputToIso('2026-10-30T17:00', TZ)).toBe('2026-10-30T14:00:00.000Z');
    expect(isoToDueInput('2026-10-30T14:00:00.000Z', TZ)).toBe('2026-10-30T17:00');
    expect(dueInputToIso('', TZ)).toBeNull();
    expect(dueInputToIso('tomorrow', TZ)).toBe('invalid');
  });
});

describe('create and edit bodies', () => {
  it('leaves empty optional fields out of a create', () => {
    const result = createTaskBody(
      {
        ...emptyTaskForm(),
        title: '  Paint  ',
        assigneeIds: [IDS.worker],
        due: '2026-11-01T09:30',
      },
      TZ,
      'bad due',
    );
    expect(result).toEqual({
      ok: true,
      body: {
        title: 'Paint',
        priority: 'normal',
        assigneeIds: [IDS.worker],
        dueAt: '2026-11-01T06:30:00.000Z',
      },
    });
  });

  it('refuses a missing title and an unreadable due date', () => {
    expect(createTaskBody(emptyTaskForm(), TZ, 'bad due').ok).toBe(false);
    expect(createTaskBody({ ...emptyTaskForm(), title: 'x', due: 'nope' }, TZ, 'bad due')).toEqual({
      ok: false,
      errors: { due: 'bad due' },
    });
  });

  it('sends only changed fields and the assignees separately', () => {
    const task = makeTask({ siteId: IDS.site, assigneeIds: [IDS.worker] });
    const form = {
      ...taskFormFrom(task, TZ),
      priority: 'urgent' as const,
      siteId: '',
      assigneeIds: [IDS.worker2],
    };
    expect(editTaskBodies(task, form, TZ, 'bad')).toEqual({
      ok: true,
      body: { update: { priority: 'urgent', siteId: null }, assigneeIds: [IDS.worker2] },
    });
    expect(editTaskBodies(task, taskFormFrom(task, TZ), TZ, 'bad')).toEqual({
      ok: true,
      body: { update: null, assigneeIds: null },
    });
  });
});

describe('status change with expectedVersion', () => {
  it('always carries the task version and requires a reason for blocked and cancelled', () => {
    expect(statusChangeBody(makeTask({ version: 7 }), 'in_progress', '')).toEqual({
      ok: true,
      body: { expectedVersion: 7, status: 'in_progress' },
    });
    expect(statusChangeBody(makeTask(), 'blocked', ' ').ok).toBe(false);
    expect(statusChangeBody(makeTask(), 'cancelled', '').ok).toBe(false);
    expect(statusChangeBody(makeTask(), 'cancelled', ' Not needed ')).toEqual({
      ok: true,
      body: { expectedVersion: 3, status: 'cancelled', reason: 'Not needed' },
    });
  });

  it('on version_conflict reloads the task instead of retrying, and the next try uses the new version', async () => {
    const stale = makeTask({ version: 3 });
    const latest = makeTask({ version: 4, status: 'blocked', statusReason: 'No parts' });
    const sent: ChangeTaskStatus[] = [];
    const api = {
      changeStatus: vi.fn(async (_id: string, body: ChangeTaskStatus) => {
        sent.push(body);
        return body.expectedVersion === 4
          ? ok(makeTask({ version: 5, status: 'done' }))
          : httpFailure(409, 'version_conflict');
      }),
      get: vi.fn(async () => ok(latest)),
    };

    const first = await submitTaskStatusChange(api, stale, 'done', '');
    expect(first).toEqual({ kind: 'conflict', latest });
    expect(api.changeStatus).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(1);

    const second = await submitTaskStatusChange(api, latest, 'done', '');
    expect(second.kind).toBe('changed');
    expect(sent.map((body) => body.expectedVersion)).toEqual([3, 4]);
  });

  it('reports other refusals without reloading', async () => {
    const api = {
      changeStatus: vi.fn(async () => httpFailure(409, 'task_cancelled')),
      get: vi.fn(),
    };
    const outcome = await submitTaskStatusChange(api, makeTask(), 'done', '');
    expect(outcome).toMatchObject({ kind: 'refused', refusal: 'task_cancelled' });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('does not call the API for an invalid change', async () => {
    const api = { changeStatus: vi.fn(), get: vi.fn() };
    expect((await submitTaskStatusChange(api, makeTask(), 'blocked', '')).kind).toBe('invalid');
    expect(api.changeStatus).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it('maps codes and statuses', () => {
    const error = (status: number, code: string) => {
      const result = httpFailure(status, code);
      return new ApiCallError(result.ok ? (undefined as never) : result.failure);
    };
    expect(taskWriteRefusal(error(409, 'version_conflict'))).toBe('version_conflict');
    expect(taskWriteRefusal(error(403, 'forbidden'))).toBe('forbidden');
    expect(taskWriteRefusal(error(422, 'unprocessable'))).toBe('invalid_reference');
    expect(taskWriteRefusal(new Error('x'))).toBe('other');
  });
});

describe('history', () => {
  const names = {
    user: (id?: string | null) => (id === IDS.worker ? 'Ayşe' : 'Unknown'),
    site: () => 'North',
    team: () => 'Crew',
    dateTime: (value: string) => `T(${value})`,
    status: (value: string) => `S(${value})`,
    priority: (value: string) => `P(${value})`,
    none: '—',
  };
  it('formats ids as names, times and labels', () => {
    expect(formatTaskHistoryValue('assigneeIds', [IDS.worker, 'x'], names)).toBe('Ayşe, Unknown');
    expect(formatTaskHistoryValue('siteId', IDS.site, names)).toBe('North');
    expect(formatTaskHistoryValue('dueAt', '2026-10-28T10:00:00Z', names)).toBe(
      'T(2026-10-28T10:00:00Z)',
    );
    expect(formatTaskHistoryValue('status', 'blocked', names)).toBe('S(blocked)');
    expect(formatTaskHistoryValue('title', null, names)).toBe('—');
    expect(historyActionKey('task.status_changed')).toBe('status_changed');
    expect(historyActionKey('task.something_new')).toBe('unknown');
  });
});
