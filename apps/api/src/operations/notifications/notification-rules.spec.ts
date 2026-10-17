import { renderNotification } from './notification-messages';
import { planNotifications, type DomainEvent } from './notification-rules';

// Which events notify whom, as pure functions. Example values only.

const ORG = 'org-1';
const ADMIN = 'user-admin';
const DENIZ = 'user-deniz';
const EMRE = 'user-emre';
const SELIN = 'user-selin';

function event(eventType: string, payload: unknown, actorId: string | null = ADMIN): DomainEvent {
  return { id: 'event-1', eventType, organizationId: ORG, actorId, payload };
}

const task = (assigneeIds: string[]) => ({
  id: 'task-1',
  title: 'Fix the pump',
  createdById: ADMIN,
  assigneeIds,
});

describe('task assigned', () => {
  it('notifies every assignee of a new task', () => {
    expect(planNotifications(event('task.created', { task: task([DENIZ, EMRE]) }))).toEqual([
      {
        type: 'task.assigned',
        organizationId: ORG,
        recipientIds: [DENIZ, EMRE],
        taskId: 'task-1',
        taskTitle: 'Fix the pump',
      },
    ]);
  });

  it('never notifies the actor who assigned themselves', () => {
    expect(planNotifications(event('task.created', { task: task([ADMIN]) }))).toEqual([]);
    expect(
      planNotifications(event('task.created', { task: task([ADMIN, DENIZ]) }))[0]?.recipientIds,
    ).toEqual([DENIZ]);
  });

  it('falls back to the creator as the actor when the event has none', () => {
    expect(
      planNotifications(event('task.created', { task: task([ADMIN, DENIZ]) }, null))[0]
        ?.recipientIds,
    ).toEqual([DENIZ]);
  });

  it('creates nothing for a task without assignees', () => {
    expect(planNotifications(event('task.created', { task: task([]) }))).toEqual([]);
  });

  it('notifies only the added assignees when the list changes', () => {
    const plans = planNotifications(
      event('task.assignees_changed', {
        added: [EMRE, ADMIN],
        removed: [DENIZ],
        task: task([EMRE, ADMIN]),
      }),
    );
    expect(plans).toEqual([expect.objectContaining({ recipientIds: [EMRE], taskId: 'task-1' })]);
  });

  it('creates nothing when only people were removed', () => {
    expect(
      planNotifications(
        event('task.assignees_changed', { added: [], removed: [DENIZ], task: task([]) }),
      ),
    ).toEqual([]);
  });

  it('ignores other task events', () => {
    expect(planNotifications(event('task.updated', { task: task([DENIZ]) }))).toEqual([]);
    expect(
      planNotifications(event('task.status_changed', { from: 'todo', to: 'done', task: task([]) })),
    ).toEqual([]);
  });
});

const workLog = (status: string, review: unknown = null) => ({
  id: 'log-1',
  authorId: DENIZ,
  status,
  review,
});

describe('work log approved or rejected', () => {
  it('notifies the author of an approval', () => {
    expect(
      planNotifications(
        event(
          'work_log.status_changed',
          {
            from: 'submitted',
            to: 'approved',
            workLog: workLog('approved'),
          },
          SELIN,
        ),
      ),
    ).toEqual([
      {
        type: 'work_log.approved',
        organizationId: ORG,
        recipientIds: [DENIZ],
        workLogId: 'log-1',
        note: null,
      },
    ]);
  });

  it('includes the reviewer note of a rejection (current payload shape)', () => {
    const plans = planNotifications(
      event(
        'work_log.status_changed',
        {
          from: 'submitted',
          to: 'rejected',
          workLog: workLog('rejected', {
            reviewedById: SELIN,
            reviewedAt: '2026-10-16T10:00:00.000Z',
            note: 'Photo missing',
          }),
        },
        SELIN,
      ),
    );
    expect(plans).toEqual([
      expect.objectContaining({
        type: 'work_log.rejected',
        recipientIds: [DENIZ],
        note: 'Photo missing',
      }),
    ]);
  });

  it('a repeated rejection (corrected note) notifies again; a repeated approval does not', () => {
    const repeated = (to: 'approved' | 'rejected') =>
      planNotifications(
        event(
          'work_log.status_changed',
          {
            from: to,
            to,
            workLog: workLog(to, {
              reviewedById: SELIN,
              reviewedAt: '2026-10-16T10:00:00.000Z',
              note: 'Corrected note',
            }),
          },
          SELIN,
        ),
      );
    expect(repeated('approved')).toEqual([]);
    expect(repeated('rejected')).toEqual([
      expect.objectContaining({ type: 'work_log.rejected', note: 'Corrected note' }),
    ]);
    // Without `from` (an older payload) the decision still notifies.
    expect(
      planNotifications(
        event('work_log.status_changed', { to: 'approved', workLog: workLog('approved') }, SELIN),
      ),
    ).toHaveLength(1);
  });

  it('understands the extended payload (authorId, reviewerId, note at the top)', () => {
    const plans = planNotifications(
      event(
        'work_log.status_changed',
        {
          from: 'submitted',
          to: 'rejected',
          authorId: DENIZ,
          reviewerId: SELIN,
          note: 'Wrong site',
          workLog: { id: 'log-1' },
        },
        null,
      ),
    );
    expect(plans).toEqual([
      expect.objectContaining({
        type: 'work_log.rejected',
        recipientIds: [DENIZ],
        note: 'Wrong site',
      }),
    ]);
  });

  it('never notifies when the reviewer is the author', () => {
    expect(
      planNotifications(
        event('work_log.status_changed', { to: 'approved', workLog: workLog('approved') }, DENIZ),
      ),
    ).toEqual([]);
    expect(
      planNotifications(
        event(
          'work_log.status_changed',
          { to: 'approved', authorId: DENIZ, reviewerId: DENIZ, workLog: { id: 'log-1' } },
          null,
        ),
      ),
    ).toEqual([]);
  });

  it('ignores the other transitions', () => {
    for (const to of ['draft', 'submitted']) {
      expect(
        planNotifications(event('work_log.status_changed', { to, workLog: workLog(to) }, DENIZ)),
      ).toEqual([]);
    }
  });

  it('carries no note on an approval even if one is present', () => {
    const plans = planNotifications(
      event(
        'work_log.status_changed',
        { to: 'approved', note: 'Nice', workLog: workLog('approved') },
        SELIN,
      ),
    );
    expect(plans[0]).toMatchObject({ note: null });
  });
});

describe('robustness', () => {
  it('produces nothing for an unreadable payload or an event without organization', () => {
    expect(planNotifications(event('task.created', null))).toEqual([]);
    expect(planNotifications(event('task.created', { task: { title: 'x' } }))).toEqual([]);
    expect(planNotifications(event('work_log.status_changed', { to: 'approved' }))).toEqual([]);
    expect(
      planNotifications({
        ...event('task.created', { task: task([DENIZ]) }),
        organizationId: null,
      }),
    ).toEqual([]);
  });
});

describe('message catalogue', () => {
  it('renders the English texts', () => {
    expect(renderNotification('task.assigned', { taskTitle: 'Fix the pump' }).title).toBe(
      'New task: Fix the pump',
    );
    expect(renderNotification('work_log.approved', {})).toEqual({
      title: 'Work log approved',
      body: 'Your work log was approved.',
      push: { title: 'Work log approved', body: 'Open the app to see it.' },
    });
    expect(renderNotification('work_log.rejected', { note: 'Photo missing' }).body).toBe(
      'Your work log was rejected: Photo missing',
    );
    expect(renderNotification('work_log.rejected', { note: null }).body).toBe(
      'Your work log was rejected.',
    );
  });

  it('gives every type a generic push text without the task title or the rejection note', () => {
    const assigned = renderNotification('task.assigned', { taskTitle: 'Fix the secret pump' });
    expect(assigned.push).toEqual({ title: 'New task assigned', body: 'Open the app to see it.' });
    const rejected = renderNotification('work_log.rejected', { note: 'Photo of the wrong site' });
    expect(rejected.push).toEqual({
      title: 'Work log rejected',
      body: 'Open the app for the reason.',
    });
    expect(JSON.stringify([assigned.push, rejected.push])).not.toMatch(/secret|wrong site/);
    // The in-app text keeps them.
    expect(assigned.title).toContain('Fix the secret pump');
    expect(rejected.body).toContain('Photo of the wrong site');
  });

  it('falls back to English for an unknown locale', () => {
    expect(renderNotification('work_log.approved', {}, 'xx').title).toBe('Work log approved');
  });
});
