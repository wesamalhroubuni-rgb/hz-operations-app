import { notificationTarget, sortNotifications } from './notificationRouting';

const TASK = '11111111-1111-4111-8111-111111111111';
const LOG = '22222222-2222-4222-8222-222222222222';

describe('notificationTarget', () => {
  it('opens the task of a task notification', () => {
    expect(notificationTarget({ taskId: TASK }, 'task.assigned')).toEqual({
      screen: 'TaskDetail',
      params: { taskId: TASK },
    });
  });

  it('opens the log of a review notification, even when it names the task too', () => {
    expect(notificationTarget({ workLogId: LOG, taskId: TASK }, 'work_log.rejected')).toEqual({
      screen: 'LogDetail',
      params: { logId: LOG },
    });
    expect(notificationTarget({ logId: LOG })).toEqual({
      screen: 'LogDetail',
      params: { logId: LOG },
    });
  });

  it('prefers the task for a task notification that also names a log', () => {
    expect(notificationTarget({ workLogId: LOG, taskId: TASK }, 'task.assigned')?.screen).toBe(
      'TaskDetail',
    );
  });

  it('opens nothing for missing, malformed or foreign data', () => {
    expect(notificationTarget(null)).toBeNull();
    expect(notificationTarget('task')).toBeNull();
    expect(notificationTarget([TASK])).toBeNull();
    expect(notificationTarget({ taskId: 'not-a-uuid' })).toBeNull();
    expect(notificationTarget({ taskId: 42 })).toBeNull();
    expect(notificationTarget({ url: 'https://example.com' })).toBeNull();
  });
});

describe('sortNotifications', () => {
  it('lists unread first, newest first within each group', () => {
    const items = [
      { id: 'read-new', readAt: '2026-10-16T10:00:00Z', createdAt: '2026-10-16T09:00:00Z' },
      { id: 'unread-old', readAt: null, createdAt: '2026-10-14T09:00:00Z' },
      { id: 'read-old', readAt: '2026-10-15T10:00:00Z', createdAt: '2026-10-15T09:00:00Z' },
      { id: 'unread-new', readAt: null, createdAt: '2026-10-16T08:00:00Z' },
    ];
    expect(sortNotifications(items).map((item) => item.id)).toEqual([
      'unread-new',
      'unread-old',
      'read-new',
      'read-old',
    ]);
  });
});
