// Where tapping a notification takes the worker: from the in-app list or from a push
// notification. Both carry the same `data` object (`taskId` or `workLogId`). Pure.

export type NotificationTarget =
  | { screen: 'TaskDetail'; params: { taskId: string } }
  | { screen: 'LogDetail'; params: { logId: string } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idIn(data: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && UUID.test(value)) {
      return value;
    }
  }
  return null;
}

/**
 * The screen a notification opens, or null when it names nothing the phone can open (the list
 * itself is then the destination). A work log wins over a task when both are named: a review
 * notification about a log that belongs to a task is about the log.
 */
export function notificationTarget(data: unknown, type?: string | null): NotificationTarget | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const logId = idIn(record, 'workLogId', 'logId');
  const taskId = idIn(record, 'taskId');
  const aboutTask = typeof type === 'string' && type.startsWith('task.');
  if (logId !== null && !(aboutTask && taskId !== null)) {
    return { screen: 'LogDetail', params: { logId } };
  }
  if (taskId !== null) {
    return { screen: 'TaskDetail', params: { taskId } };
  }
  return null;
}

/** The in-app list order: unread first, then newest first within each group. */
export function sortNotifications<Item extends { readAt: string | null; createdAt: string }>(
  items: readonly Item[],
): Item[] {
  return [...items].sort((a, b) => {
    const unread = Number(b.readAt === null) - Number(a.readAt === null);
    return unread !== 0 ? unread : Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}
