import {
  MAX_DECLARED_ATTACHMENTS,
  type CreateWorkLogInput,
  type UpdateWorkLog,
  type WorkLog,
} from '@ops/shared';

import type { OfflineDatabase, OfflineTableAccess } from './db';
import type {
  EnqueueResult,
  QueuedMutation,
  QueueItem,
  QueueItemError,
  QueueItemState,
  WriteQueue,
} from './types';

// The durable write queue of one user (ADR-0008 section 9), in the `queue` table of their
// database. Every write a worker makes lands here first, online or offline; the sync engine
// sends it. Rules:
//
// - Per-record ordering: items of one record (`workLog:<clientId>`, `task:<id>`) are sent in
//   `seq` order, one at a time; a failed item blocks the later items of its record.
// - Idempotency: the `idempotencyKey` (and a create's `clientId`) is fixed at enqueue time and
//   never regenerated, so a resend after a crash or a lost answer is harmless.
// - Crash safety: every change is one transaction; an item found `sending` at start goes back to
//   `pending` (`recoverInterrupted`).
// - Nothing is dropped silently: an item leaves the queue only when accepted (`markDone`) or
//   discarded by the worker (`discard`, `clear`).
// - Coalescing never touches an item that was ever handed to the network: the server may have
//   applied it already, and a changed body would then be lost on the replay.

/** The record a mutation is about. */
export function recordKeyOf(mutation: QueuedMutation): string {
  switch (mutation.kind) {
    case 'createWorkLog':
      return workLogRecordKey(mutation.body.clientId);
    case 'updateWorkLog':
    case 'changeWorkLogStatus':
    case 'uploadAttachment':
      return workLogRecordKey(mutation.workLogClientId);
    case 'changeTaskStatus':
      return taskRecordKey(mutation.taskId);
  }
}

export const workLogRecordKey = (clientId: string) => `workLog:${clientId}`;
export const taskRecordKey = (taskId: string) => `task:${taskId}`;

/** What the queue stores: the public item plus whether it ever left the phone. */
interface StoredItem extends QueueItem {
  everSent: boolean;
}

function toPublic(item: StoredItem): QueueItem {
  const { everSent: _everSent, ...rest } = item;
  return rest;
}

const SEQ_KEY = 'queue.nextSeq';
/** `queue.*` meta keys survive `clearCache` (the read cache), unlike every other meta key. */
const SERVER_ID_PREFIX = 'queue.serverId.';
const serverIdKey = (workLogClientId: string) => `${SERVER_ID_PREFIX}${workLogClientId}`;
const WORK_LOG_PREFIX = 'workLog:';

/** The queue with the extras the app's data layer and the sync engine may use. */
export interface OfflineWriteQueue extends WriteQueue {
  /**
   * Holds several writes in ONE transaction (a log's create and its photos): after a crash
   * either all of them are queued or none.
   */
  enqueueAll(mutations: readonly QueuedMutation[], now: Date): Promise<EnqueueResult[]>;
  /** Clears `nextAttemptAt` of every retryable item: the network came back, try now. */
  wakeRetries(): Promise<void>;
  /** Upload progress of a `sending` photo (0..1), in memory only. */
  setProgress(id: string, fraction: number | null): void;
  progressOf(id: string): number | null;
  /** Called on every progress change (kept apart from `subscribe`: nothing is stored). */
  subscribeProgress(listener: () => void): () => void;
  /** The local ids of every photo a queued upload still needs. */
  referencedPhotoIds(): Promise<string[]>;
}

export interface WriteQueueDeps {
  db: OfflineDatabase;
  userId: string;
  /** A new UUID (item ids, idempotency keys, clientIds of resubmitted logs and photos). */
  newId: () => string;
  /** Deletes a photo of the photo store (discarded upload). */
  deletePhoto?: (localId: string) => Promise<void>;
  /** Deletes every photo of the user (`clear`). */
  clearPhotos?: () => Promise<void>;
  /** The cached server copy of a log by clientId (for `resubmitAsNew` of a refused edit). */
  lookupWorkLog?: (clientId: string) => Promise<WorkLog | null>;
  /** Formats `copyText`; the default writes the content without labels. */
  formatCopyText?: (item: QueueItem) => string;
}

function parseItem(raw: string): StoredItem | null {
  try {
    return JSON.parse(raw) as StoredItem;
  } catch {
    return null;
  }
}

async function readItems(tx: OfflineTableAccess): Promise<StoredItem[]> {
  const items: StoredItem[] = [];
  for (const row of await tx.all('queue')) {
    const item = parseItem(row.value);
    if (item) items.push(item);
  }
  return items.sort((a, b) => a.seq - b.seq);
}

async function writeItem(tx: OfflineTableAccess, item: StoredItem): Promise<void> {
  await tx.put('queue', item.id, JSON.stringify(item));
}

function isUnsent(item: StoredItem): boolean {
  return item.state === 'pending' && !item.everSent;
}

function withoutVersion<Body extends { expectedVersion?: number }>(
  body: Body,
): Omit<Body, 'expectedVersion'> {
  const { expectedVersion: _expectedVersion, ...rest } = body;
  return rest;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A create body with an edit applied on top (later fields win). */
export function mergeIntoCreate(
  create: CreateWorkLogInput,
  edit: UpdateWorkLog,
): CreateWorkLogInput {
  const fields = withoutVersion(edit);
  const merged: Record<string, unknown> = { ...create };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as CreateWorkLogInput;
}

/** Two edits of one log as one (later fields win; the earlier `expectedVersion` stays). */
export function mergeEdits(earlier: UpdateWorkLog, later: UpdateWorkLog): UpdateWorkLog {
  const merged: Record<string, unknown> = { ...earlier };
  for (const [key, value] of Object.entries(withoutVersion(later))) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as UpdateWorkLog;
}

/** A create body carrying the content of a log (for "resubmit as a new log"). */
export function createBodyFromLog(log: WorkLog, clientId: string, now: Date): CreateWorkLogInput {
  return {
    clientId,
    occurredAt: log.occurredAt,
    attachmentClientIds: [],
    deviceCreatedAt: now.toISOString(),
    taskId: log.taskId,
    siteId: log.siteId,
    teamId: log.teamId,
    logTypeId: log.logTypeId,
    text: log.text,
    customFields: log.customFields,
    location: log.location,
    status: log.status === 'draft' ? 'draft' : 'submitted',
    source: log.source,
  };
}

/** The content of an item as plain text, without labels (the screen may pass its own format). */
export function defaultCopyText(item: QueueItem): string {
  const lines: string[] = [];
  const mutation = item.mutation;
  const addContent = (body: Partial<CreateWorkLogInput> | UpdateWorkLog) => {
    if (body.occurredAt) lines.push(body.occurredAt);
    if (body.text) lines.push(body.text);
    for (const [key, value] of Object.entries(body.customFields ?? {})) {
      if (value !== null && value !== undefined && value !== '')
        lines.push(`${key}: ${String(value)}`);
    }
    if (body.location) lines.push(`${body.location.latitude}, ${body.location.longitude}`);
  };
  switch (mutation.kind) {
    case 'createWorkLog':
    case 'updateWorkLog':
      addContent(mutation.body);
      break;
    case 'changeWorkLogStatus':
      lines.push(mutation.body.status);
      if (mutation.body.note) lines.push(mutation.body.note);
      break;
    case 'changeTaskStatus':
      lines.push(mutation.body.status);
      if (mutation.body.reason) lines.push(mutation.body.reason);
      break;
    case 'uploadAttachment':
      lines.push(mutation.photo.fileName);
      break;
  }
  return lines.join('\n');
}

const STATES: readonly QueueItemState[] = [
  'pending',
  'sending',
  'failed_retryable',
  'failed_permanent',
  'done',
];

export function createWriteQueue(deps: WriteQueueDeps): OfflineWriteQueue {
  const { db, userId, newId } = deps;
  const listeners = new Set<() => void>();
  const progress = new Map<string, number>();
  const progressListeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure must not break the queue.
      }
    }
  }

  async function nextSeq(tx: OfflineTableAccess): Promise<number> {
    const raw = await tx.get('meta', SEQ_KEY);
    const stored = raw === null ? 0 : Number(raw);
    // Never below an existing item's seq (a damaged counter must not reorder the queue).
    const highest = (await readItems(tx)).reduce((max, item) => Math.max(max, item.seq), 0);
    const seq = Math.max(Number.isFinite(stored) ? stored : 0, highest) + 1;
    await tx.put('meta', SEQ_KEY, String(seq));
    return seq;
  }

  async function newItem(
    tx: OfflineTableAccess,
    mutation: QueuedMutation,
    now: Date,
  ): Promise<StoredItem> {
    const iso = now.toISOString();
    return {
      id: newId(),
      seq: await nextSeq(tx),
      recordKey: recordKeyOf(mutation),
      mutation,
      state: 'pending',
      idempotencyKey: newId(),
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      createdAt: iso,
      updatedAt: iso,
      everSent: false,
    };
  }

  /** One enqueue inside a transaction. */
  async function enqueueIn(
    tx: OfflineTableAccess,
    mutation: QueuedMutation,
    now: Date,
  ): Promise<EnqueueResult> {
    const items = await readItems(tx);
    const recordKey = recordKeyOf(mutation);
    const record = items.filter((item) => item.recordKey === recordKey);
    const unsentCreate = record.find(
      (item) => item.mutation.kind === 'createWorkLog' && isUnsent(item),
    );
    const last = record.at(-1);
    const touch = async (item: StoredItem): Promise<EnqueueResult> => {
      const updated = { ...item, updatedAt: now.toISOString() };
      await writeItem(tx, updated);
      return { item: toPublic(updated), coalesced: true };
    };

    switch (mutation.kind) {
      case 'createWorkLog': {
        // A double tap, or a save repeated after a crash: the log is queued once.
        const existing = record.find((item) => item.mutation.kind === 'createWorkLog');
        if (existing) return { item: toPublic(existing), coalesced: true };
        break;
      }
      case 'uploadAttachment': {
        const existing = record.find(
          (item) =>
            item.mutation.kind === 'uploadAttachment' &&
            (item.mutation.attachmentClientId === mutation.attachmentClientId ||
              item.mutation.photo.localId === mutation.photo.localId),
        );
        if (existing) return { item: toPublic(existing), coalesced: true };
        // A photo added before the log was sent becomes part of its original submission.
        if (unsentCreate && unsentCreate.mutation.kind === 'createWorkLog') {
          const declared = unsentCreate.mutation.body.attachmentClientIds ?? [];
          if (
            !declared.includes(mutation.attachmentClientId) &&
            declared.length < MAX_DECLARED_ATTACHMENTS
          ) {
            await writeItem(tx, {
              ...unsentCreate,
              mutation: {
                kind: 'createWorkLog',
                body: {
                  ...unsentCreate.mutation.body,
                  attachmentClientIds: [...declared, mutation.attachmentClientId],
                },
              },
              updatedAt: now.toISOString(),
            });
          }
        }
        break;
      }
      case 'updateWorkLog': {
        if (unsentCreate && unsentCreate.mutation.kind === 'createWorkLog') {
          return touch({
            ...unsentCreate,
            mutation: {
              kind: 'createWorkLog',
              body: mergeIntoCreate(unsentCreate.mutation.body, mutation.body),
            },
          });
        }
        if (last && last.mutation.kind === 'updateWorkLog' && isUnsent(last)) {
          return touch({
            ...last,
            mutation: { ...last.mutation, body: mergeEdits(last.mutation.body, mutation.body) },
          });
        }
        break;
      }
      case 'changeWorkLogStatus': {
        if (
          unsentCreate &&
          unsentCreate.mutation.kind === 'createWorkLog' &&
          last === unsentCreate &&
          mutation.body.status === 'submitted' &&
          mutation.body.note === undefined
        ) {
          // Submitting a draft that never left the phone: send it as submitted.
          return touch({
            ...unsentCreate,
            mutation: {
              kind: 'createWorkLog',
              body: { ...unsentCreate.mutation.body, status: 'submitted' },
            },
          });
        }
        if (
          last &&
          last.mutation.kind === 'changeWorkLogStatus' &&
          isUnsent(last) &&
          sameJson(withoutVersion(last.mutation.body), withoutVersion(mutation.body))
        ) {
          return { item: toPublic(last), coalesced: true };
        }
        break;
      }
      case 'changeTaskStatus': {
        if (
          last &&
          last.mutation.kind === 'changeTaskStatus' &&
          isUnsent(last) &&
          sameJson(withoutVersion(last.mutation.body), withoutVersion(mutation.body))
        ) {
          return { item: toPublic(last), coalesced: true };
        }
        break;
      }
    }

    const item = await newItem(tx, mutation, now);
    await writeItem(tx, item);
    return { item: toPublic(item), coalesced: false };
  }

  async function update(
    id: string,
    change: (item: StoredItem) => StoredItem | null,
  ): Promise<StoredItem | null> {
    const result = await db.transaction(async (tx) => {
      const raw = await tx.get('queue', id);
      const item = raw === null ? null : parseItem(raw);
      if (!item) return null;
      const next = change(item);
      if (next) await writeItem(tx, next);
      return next;
    });
    notify();
    return result;
  }

  /** Drops a log's remembered server id once none of its items is queued any more. */
  async function forgetLinkIfDone(tx: OfflineTableAccess, recordKey: string): Promise<void> {
    if (!recordKey.startsWith(WORK_LOG_PREFIX)) return;
    const left = (await readItems(tx)).some((item) => item.recordKey === recordKey);
    if (!left) await tx.remove('meta', serverIdKey(recordKey.slice(WORK_LOG_PREFIX.length)));
  }

  async function getStored(id: string): Promise<StoredItem | null> {
    const raw = await db.get('queue', id);
    return raw === null ? null : parseItem(raw);
  }

  async function deletePhotos(localIds: readonly string[]): Promise<void> {
    for (const localId of localIds) {
      await deps.deletePhoto?.(localId).catch(() => undefined);
    }
  }

  return {
    userId,

    async enqueue(mutation, now) {
      const result = await db.transaction((tx) => enqueueIn(tx, mutation, now));
      notify();
      return result;
    },

    async enqueueAll(mutations, now) {
      const results = await db.transaction(async (tx) => {
        const done: EnqueueResult[] = [];
        for (const mutation of mutations) done.push(await enqueueIn(tx, mutation, now));
        return done;
      });
      notify();
      return results;
    },

    async list() {
      return (await readItems(db)).map(toPublic);
    },

    async nextBatch(now) {
      const items = await readItems(db);
      const seen = new Set<string>();
      const batch: QueueItem[] = [];
      for (const item of items) {
        if (seen.has(item.recordKey)) continue;
        seen.add(item.recordKey);
        if (item.state === 'sending' || item.state === 'failed_permanent') continue;
        if (item.nextAttemptAt !== null && Date.parse(item.nextAttemptAt) > now.getTime()) {
          continue;
        }
        batch.push(toPublic(item));
      }
      return batch;
    },

    async get(id) {
      const item = await getStored(id);
      return item ? toPublic(item) : null;
    },

    async counts() {
      const counts = Object.fromEntries(STATES.map((state) => [state, 0])) as Record<
        QueueItemState,
        number
      >;
      for (const item of await readItems(db)) counts[item.state] += 1;
      return counts;
    },

    async markSending(id, now) {
      // Re-read inside the transaction: the copy the engine listed may be stale (an edit, a
      // draft submit or a declared photo merged into it since), or discarded meanwhile.
      const claimed = await db.transaction(async (tx) => {
        const raw = await tx.get('queue', id);
        const item = raw === null ? null : parseItem(raw);
        if (!item || (item.state !== 'pending' && item.state !== 'failed_retryable')) return null;
        const next: StoredItem = {
          ...item,
          state: 'sending',
          everSent: true,
          updatedAt: now.toISOString(),
        };
        await writeItem(tx, next);
        return next;
      });
      notify();
      return claimed ? toPublic(claimed) : null;
    },

    async markDone(id) {
      progress.delete(id);
      await db.transaction(async (tx) => {
        const raw = await tx.get('queue', id);
        const item = raw === null ? null : parseItem(raw);
        // Only the copy that was sent: an item is never merged into once `sending`.
        if (!item || item.state !== 'sending') return;
        await tx.remove('queue', id);
        await forgetLinkIfDone(tx, item.recordKey);
      });
      notify();
    },

    async linkServerId(workLogClientId, serverId) {
      await db.put('meta', serverIdKey(workLogClientId), serverId);
    },

    async serverIdOf(workLogClientId) {
      return db.get('meta', serverIdKey(workLogClientId));
    },

    async markFailed(id, error: QueueItemError, permanent, nextAttemptAt, now) {
      progress.delete(id);
      await update(id, (item) => ({
        ...item,
        state: permanent ? 'failed_permanent' : 'failed_retryable',
        attempts: item.attempts + 1,
        lastError: error,
        nextAttemptAt: permanent || nextAttemptAt === null ? null : nextAttemptAt.toISOString(),
        updatedAt: now.toISOString(),
      }));
    },

    async saveCheckpoint(id, checkpoint) {
      await update(id, (item) =>
        item.mutation.kind === 'uploadAttachment'
          ? { ...item, mutation: { ...item.mutation, checkpoint: { ...checkpoint } } }
          : item,
      );
    },

    async rebaseVersion(recordKey, version) {
      await db.transaction(async (tx) => {
        for (const item of await readItems(tx)) {
          if (item.recordKey !== recordKey || item.state === 'sending') continue;
          const mutation = item.mutation;
          if (
            mutation.kind === 'updateWorkLog' ||
            mutation.kind === 'changeWorkLogStatus' ||
            mutation.kind === 'changeTaskStatus'
          ) {
            const body = { ...mutation.body, expectedVersion: version };
            await writeItem(tx, { ...item, mutation: { ...mutation, body } as QueuedMutation });
          }
        }
      });
      notify();
    },

    async recoverInterrupted() {
      const count = await db.transaction(async (tx) => {
        let reset = 0;
        for (const item of await readItems(tx)) {
          if (item.state === 'sending') {
            await writeItem(tx, { ...item, state: 'pending' });
            reset += 1;
          }
        }
        return reset;
      });
      progress.clear();
      if (count > 0) notify();
      return count;
    },

    async wakeRetries() {
      await db.transaction(async (tx) => {
        for (const item of await readItems(tx)) {
          if (item.nextAttemptAt !== null && item.state !== 'failed_permanent') {
            await writeItem(tx, { ...item, nextAttemptAt: null });
          }
        }
      });
      notify();
    },

    async retry(id, now) {
      await update(id, (item) =>
        item.state === 'sending'
          ? item
          : {
              ...item,
              state: 'pending',
              attempts: 0,
              nextAttemptAt: null,
              lastError: null,
              updatedAt: now.toISOString(),
            },
      );
    },

    async discard(id) {
      const photos = await db.transaction(async (tx) => {
        const items = await readItems(tx);
        const item = items.find((candidate) => candidate.id === id);
        if (!item) return [];
        const doomed =
          item.mutation.kind === 'createWorkLog'
            ? items.filter((other) => other.recordKey === item.recordKey)
            : [item];
        // An item already on its way to the server may be applied there: never discard it (or a
        // create whose photo is uploading) from a stale list. The worker can discard it after the
        // send has finished or failed.
        if (doomed.some((other) => other.state === 'sending')) return [];
        for (const other of doomed) await tx.remove('queue', other.id);
        await forgetLinkIfDone(tx, item.recordKey);
        return doomed.flatMap((other) =>
          other.mutation.kind === 'uploadAttachment' ? [other.mutation.photo.localId] : [],
        );
      });
      progress.delete(id);
      await deletePhotos(photos);
      notify();
    },

    async resubmitAsNew(id, now) {
      const original = await getStored(id);
      if (!original) throw new Error('The queued item no longer exists');
      const mutation = original.mutation;
      let base: WorkLog | null = null;
      if (mutation.kind === 'updateWorkLog') {
        base = (await deps.lookupWorkLog?.(mutation.workLogClientId)) ?? null;
        if (!base) throw new Error('The log of this edit is not on the phone any more');
      } else if (mutation.kind !== 'createWorkLog') {
        throw new Error('Only a log create or edit can be resubmitted as a new log');
      }
      const created = await db.transaction(async (tx) => {
        const items = await readItems(tx);
        const record = items.filter((item) => item.recordKey === original.recordKey);
        const clientId = newId();
        let body: CreateWorkLogInput;
        const uploads: QueuedMutation[] = [];
        if (mutation.kind === 'createWorkLog') {
          body = { ...mutation.body, clientId, deviceCreatedAt: now.toISOString() };
          for (const item of record) {
            if (item.seq > original.seq && item.mutation.kind === 'updateWorkLog') {
              body = mergeIntoCreate(body, item.mutation.body);
            }
          }
          const declared: string[] = [];
          for (const item of record) {
            if (item.mutation.kind !== 'uploadAttachment') continue;
            const attachmentClientId = newId();
            declared.push(attachmentClientId);
            uploads.push({
              kind: 'uploadAttachment',
              workLogClientId: clientId,
              workLogId: null,
              attachmentClientId,
              photo: item.mutation.photo,
              checkpoint: { attachmentId: null, stored: false },
            });
          }
          body = { ...body, attachmentClientIds: declared.slice(0, MAX_DECLARED_ATTACHMENTS) };
          // The old record goes; its photo files move to the new one (not deleted).
          for (const item of record) await tx.remove('queue', item.id);
        } else {
          const edit = mutation.kind === 'updateWorkLog' ? mutation.body : {};
          body = mergeIntoCreate(createBodyFromLog(base as WorkLog, clientId, now), edit);
          await tx.remove('queue', original.id);
        }
        const createItem = await enqueueIn(tx, { kind: 'createWorkLog', body }, now);
        for (const upload of uploads) await enqueueIn(tx, upload, now);
        return createItem.item;
      });
      notify();
      return created;
    },

    async copyText(id) {
      const item = await getStored(id);
      if (!item) return '';
      const publicItem = toPublic(item);
      return (deps.formatCopyText ?? defaultCopyText)(publicItem);
    },

    async pendingCount() {
      return (await readItems(db)).length;
    },

    async clear() {
      await db.transaction(async (tx) => {
        await tx.removeAll('queue');
        for (const row of await tx.all('meta')) {
          if (row.key.startsWith(SERVER_ID_PREFIX)) await tx.remove('meta', row.key);
        }
      });
      progress.clear();
      await deps.clearPhotos?.().catch(() => undefined);
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    setProgress(id, fraction) {
      if (fraction === null) progress.delete(id);
      else progress.set(id, Math.min(1, Math.max(0, fraction)));
      for (const listener of [...progressListeners]) listener();
    },

    progressOf: (id) => progress.get(id) ?? null,

    subscribeProgress(listener) {
      progressListeners.add(listener);
      return () => {
        progressListeners.delete(listener);
      };
    },

    async referencedPhotoIds() {
      return (await readItems(db)).flatMap((item) =>
        item.mutation.kind === 'uploadAttachment' ? [item.mutation.photo.localId] : [],
      );
    },
  };
}

// Narrow helpers for the data layer.
export type QueuedCreate = Extract<QueuedMutation, { kind: 'createWorkLog' }>;
export type QueuedUpload = Extract<QueuedMutation, { kind: 'uploadAttachment' }>;
