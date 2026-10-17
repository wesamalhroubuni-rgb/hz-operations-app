/**
 * Which domain events notify whom: pure functions from an outbox event to the notifications it
 * should produce. No I/O; the handler (./operations-notifications.service.ts) re-checks the
 * current state of the record before anything is written.
 *
 * | Event                                   | Recipients                          | Type              |
 * | --------------------------------------- | ----------------------------------- | ----------------- |
 * | `task.created`                          | the task's assignees, minus actor   | task.assigned     |
 * | `task.assignees_changed`                | the `added` ids, minus actor        | task.assigned     |
 * | `work_log.status_changed`, to approved  | the author, unless they reviewed it | work_log.approved |
 * | `work_log.status_changed`, to rejected  | the author, unless they reviewed it | work_log.rejected |
 *
 * A repeated decision (`from === to`, the reviewer corrected the note) notifies again only for
 * `rejected` (the reason changed); approved to approved notifies nobody.
 *
 * Payloads are read defensively: the current shape (`{ from, to, workLog }`, the entity under
 * its camelCase key) and an extended one with top-level `authorId`, `reviewerId` /
 * `reviewedById`, `note` / `reviewNote` are both understood. Anything unreadable produces no
 * notification rather than an error.
 */
import type { OperationsNotificationType } from './notification-messages';

/** The fields of an outbox event the rules read. */
export interface DomainEvent {
  id: string;
  eventType: string;
  organizationId: string | null;
  actorId: string | null;
  payload: unknown;
}

export type PlannedNotification =
  | {
      type: Extract<OperationsNotificationType, 'task.assigned'>;
      organizationId: string;
      recipientIds: string[];
      taskId: string;
      /** The title at the time of the event; the handler prefers the current one. */
      taskTitle: string | null;
    }
  | {
      type: Extract<OperationsNotificationType, 'work_log.approved' | 'work_log.rejected'>;
      organizationId: string;
      recipientIds: string[];
      workLogId: string;
      /** The reviewer's note (rejections only), or null. */
      note: string | null;
    };

/** The event types the rules react to (the handlers register for exactly these). */
export const NOTIFYING_EVENT_TYPES = [
  'task.created',
  'task.assignees_changed',
  'work_log.status_changed',
] as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string'))]
    : [];
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const found = text(value);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function planTaskAssigned(event: DomainEvent, organizationId: string): PlannedNotification[] {
  const payload = record(event.payload);
  const task = record(payload?.task);
  const taskId = text(task?.id);
  if (!payload || !task || !taskId) {
    return [];
  }
  const assigned = event.eventType === 'task.created' ? ids(task.assigneeIds) : ids(payload.added);
  const actorId =
    event.actorId ?? (event.eventType === 'task.created' ? text(task.createdById) : null);
  const recipientIds = assigned.filter((userId) => userId !== actorId);
  if (recipientIds.length === 0) {
    return [];
  }
  return [
    {
      type: 'task.assigned',
      organizationId,
      recipientIds,
      taskId,
      taskTitle: text(task.title),
    },
  ];
}

function planWorkLogReviewed(event: DomainEvent, organizationId: string): PlannedNotification[] {
  const payload = record(event.payload);
  const workLog = record(payload?.workLog);
  const workLogId = text(workLog?.id) ?? text(payload?.workLogId);
  if (!payload || !workLogId) {
    return [];
  }
  const to = firstText(payload.to, workLog?.status);
  if (to !== 'approved' && to !== 'rejected') {
    return [];
  }
  // Repeating a decision only corrects the note: a new rejection reason is worth telling the
  // author about, a second approval is not.
  const from = text(payload.from);
  if (from === to && to === 'approved') {
    return [];
  }
  const review = record(workLog?.review);
  const authorId = firstText(payload.authorId, workLog?.authorId);
  const reviewerId = firstText(
    payload.reviewerId,
    payload.reviewedById,
    review?.reviewedById,
    event.actorId,
  );
  if (!authorId || authorId === reviewerId) {
    return [];
  }
  const note = to === 'rejected' ? firstText(payload.note, payload.reviewNote, review?.note) : null;
  return [
    {
      type: to === 'approved' ? 'work_log.approved' : 'work_log.rejected',
      organizationId,
      recipientIds: [authorId],
      workLogId,
      note,
    },
  ];
}

/** The notifications an event should produce (usually none or one plan). */
export function planNotifications(event: DomainEvent): PlannedNotification[] {
  const organizationId = event.organizationId;
  if (!organizationId) {
    return [];
  }
  switch (event.eventType) {
    case 'task.created':
    case 'task.assignees_changed':
      return planTaskAssigned(event, organizationId);
    case 'work_log.status_changed':
      return planWorkLogReviewed(event, organizationId);
    default:
      return [];
  }
}
