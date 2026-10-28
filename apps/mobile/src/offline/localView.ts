import type {
  CreateWorkLogInput,
  Task,
  UpdateWorkLog,
  WorkLog,
  WorkLogLocationInput,
} from '@ops/shared';

import type { QueueItem } from './types';
import { taskRecordKey, workLogRecordKey } from './writeQueue';

// The optimistic view: what the worker sees is the cache (the server's last word) with the
// writes still in the queue applied on top, so a change shows at once, offline or online.
// Pure functions; the read hooks in src/data/queries.ts call them.
//
// - A queued create that the cache does not know yet appears as a log whose `id` is its
//   `clientId` (screens open it by that id; the store finds it by clientId after the sync).
//   It stays visible even when the server refused it: it must never seem lost.
// - Queued edits and status changes are applied unless the server refused them for good
//   (`failed_permanent`): then the cache shows the server's version, and the refused change is
//   in the sync list, where the worker can resubmit, copy, or discard it.

export interface ViewUser {
  id: string;
  organizationId: string;
}

function locationOf(input: WorkLogLocationInput | null | undefined): WorkLog['location'] {
  if (!input) return null;
  return { latitude: input.latitude, longitude: input.longitude, accuracy: input.accuracy ?? null };
}

/** The log a queued create will become, as far as the phone knows it. */
export function workLogFromCreate(
  body: CreateWorkLogInput,
  user: ViewUser,
  queuedAt: string,
  updatedAt: string = queuedAt,
): WorkLog {
  return {
    id: body.clientId,
    organizationId: user.organizationId,
    clientId: body.clientId,
    authorId: user.id,
    occurredAt: body.occurredAt,
    taskId: body.taskId ?? null,
    siteId: body.siteId ?? null,
    teamId: body.teamId ?? null,
    logTypeId: body.logTypeId ?? null,
    logTypeVersion: null,
    text: body.text ?? null,
    customFields: (body.customFields ?? {}) as WorkLog['customFields'],
    location: locationOf(body.location),
    status: body.status ?? 'submitted',
    review: null,
    source: body.source ?? 'manual',
    aiMetadata: null,
    version: 1,
    submittedOffline: true,
    deviceCreatedAt: body.deviceCreatedAt ?? queuedAt,
    clockSkewSeconds: null,
    clockSkewFlagged: false,
    declaredAttachmentClientIds: [...(body.attachmentClientIds ?? [])],
    createdAt: queuedAt,
    updatedAt,
    archivedAt: null,
  };
}

/** A log with a queued edit applied. */
export function applyEdit(log: WorkLog, edit: UpdateWorkLog): WorkLog {
  const next: WorkLog = { ...log };
  if (edit.occurredAt !== undefined) next.occurredAt = edit.occurredAt;
  if (edit.taskId !== undefined) next.taskId = edit.taskId;
  if (edit.siteId !== undefined) next.siteId = edit.siteId;
  if (edit.teamId !== undefined) next.teamId = edit.teamId;
  if (edit.logTypeId !== undefined) next.logTypeId = edit.logTypeId;
  if (edit.text !== undefined) next.text = edit.text;
  if (edit.customFields !== undefined) {
    next.customFields = edit.customFields as WorkLog['customFields'];
  }
  if (edit.location !== undefined) next.location = locationOf(edit.location);
  return next;
}

function shows(item: QueueItem): boolean {
  return item.state !== 'failed_permanent';
}

function applyQueued(log: WorkLog, items: readonly QueueItem[]): WorkLog {
  let view = log;
  for (const item of items) {
    if (!shows(item)) continue;
    const mutation = item.mutation;
    if (mutation.kind === 'updateWorkLog') {
      view = { ...applyEdit(view, mutation.body), updatedAt: item.updatedAt };
    } else if (mutation.kind === 'changeWorkLogStatus') {
      view = { ...view, status: mutation.body.status, updatedAt: item.updatedAt };
    }
  }
  return view;
}

function byRecord(queue: readonly QueueItem[]): Map<string, QueueItem[]> {
  const records = new Map<string, QueueItem[]>();
  for (const item of [...queue].sort((a, b) => a.seq - b.seq)) {
    const list = records.get(item.recordKey) ?? [];
    list.push(item);
    records.set(item.recordKey, list);
  }
  return records;
}

/** The worker's logs: cached ones with their queued changes, plus queued new ones. */
export function viewWorkLogs(
  cached: readonly WorkLog[],
  queue: readonly QueueItem[],
  user: ViewUser,
): WorkLog[] {
  const records = byRecord(queue);
  const known = new Set(cached.map((log) => log.clientId));
  const view = cached.map((log) =>
    applyQueued(log, records.get(workLogRecordKey(log.clientId)) ?? []),
  );
  for (const items of records.values()) {
    const create = items.find((item) => item.mutation.kind === 'createWorkLog');
    if (!create || create.mutation.kind !== 'createWorkLog') continue;
    if (known.has(create.mutation.body.clientId)) continue;
    const base = workLogFromCreate(create.mutation.body, user, create.createdAt, create.updatedAt);
    view.push(
      applyQueued(
        base,
        items.filter((item) => item.seq > create.seq),
      ),
    );
  }
  return view;
}

/** My tasks with their queued status changes. */
export function viewTasks(cached: readonly Task[], queue: readonly QueueItem[]): Task[] {
  const records = byRecord(queue);
  return cached.map((task) => {
    let view = task;
    for (const item of records.get(taskRecordKey(task.id)) ?? []) {
      if (!shows(item) || item.mutation.kind !== 'changeTaskStatus') continue;
      const { status, reason } = item.mutation.body;
      view = {
        ...view,
        status,
        statusReason: reason ?? null,
        completedAt: status === 'done' ? (view.completedAt ?? item.createdAt) : null,
        updatedAt: item.updatedAt,
      };
    }
    return view;
  });
}

/** A log by its server id or by its clientId (logs created offline are known by clientId). */
export function findWorkLog(logs: readonly WorkLog[], idOrClientId: string): WorkLog | null {
  return (
    logs.find((log) => log.id === idOrClientId) ??
    logs.find((log) => log.clientId === idOrClientId) ??
    null
  );
}

/** The record keys with at least one queued write (for "waiting to send" marks). */
export function pendingRecordKeys(queue: readonly QueueItem[]): Set<string> {
  return new Set(queue.map((item) => item.recordKey));
}
