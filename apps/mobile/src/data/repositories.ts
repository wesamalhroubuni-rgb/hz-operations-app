import {
  occurredAtRangeProblem,
  offlineMaxBackdateDaysOf,
  type ApiClient,
  type ChangeTaskStatus,
  type ChangeWorkLogStatus,
  type CreateWorkLogInput,
  type RegisterPushToken,
  type Task,
  type UpdateWorkLog,
  type WorkLog,
} from '@ops/shared';

import { createSerialRunner } from '../offline/db';
import {
  applyEdit,
  findWorkLog,
  viewTasks,
  viewWorkLogs,
  type ViewUser,
} from '../offline/localView';
import type { OfflineLocalStore } from '../offline/localStore';
import type { LocalPhotoStore, QueuedMutation } from '../offline/types';
import type { OfflineWriteQueue } from '../offline/writeQueue';
import type { LocalPhoto } from '../storage/localPhoto';
import { fromApiResult, type WriteError, type WriteResult } from './results';

// The phone's one write path (ADR-0008). Screens and hooks call these repositories; nothing else
// changes data. Every work-log and task write goes into the user's durable write queue FIRST,
// online or offline, and answers at once with the optimistic result; the sync engine sends the
// queue (in order per record, idempotent by clientId / Idempotency-Key). Reads come from the
// local store with the queue applied (src/offline/localView.ts), so a change shows immediately.
//
// Marking notifications read and push registration are not queued: they need the server now and
// lose nothing when they fail (the next pull shows the real state).

/** What a saved new log looks like to a screen. A queued log is `pending` until the sync. */
export type SavedWorkLog =
  | { clientId: string; sync: 'settled'; log: WorkLog }
  | { clientId: string; sync: 'pending'; log: null };

export interface WorkLogsRepository {
  /**
   * Queues the log and its photos (moved into the user's photo store and declared in the create
   * as `attachmentClientIds`). Idempotent by `clientId`: repeating it queues nothing new.
   */
  create(
    body: CreateWorkLogInput,
    photos?: readonly LocalPhoto[],
  ): Promise<WriteResult<SavedWorkLog>>;
  /** `id` is the log's server id or, for a log not sent yet, its clientId. */
  update(id: string, body: UpdateWorkLog): Promise<WriteResult<WorkLog>>;
  changeStatus(id: string, body: ChangeWorkLogStatus): Promise<WriteResult<WorkLog>>;
}

export interface TasksRepository {
  changeStatus(id: string, body: ChangeTaskStatus): Promise<WriteResult<Task>>;
}

export interface AttachmentsRepository {
  /** Queues photos for a log (server id or clientId). They upload after its earlier writes. */
  add(workLogId: string, photos: readonly LocalPhoto[]): Promise<WriteResult<{ queued: number }>>;
}

export interface NotificationsRepository {
  markRead(id: string): Promise<WriteResult<unknown>>;
  markAllRead(): Promise<WriteResult<unknown>>;
  registerPushToken(body: RegisterPushToken): Promise<WriteResult<unknown>>;
  unregisterPushToken(token: string): Promise<WriteResult<unknown>>;
}

export interface Repositories {
  workLogs: WorkLogsRepository;
  tasks: TasksRepository;
  attachments: AttachmentsRepository;
  notifications: NotificationsRepository;
}

/**
 * The `details[].message` of a write refused because the photos do not fit in the phone's
 * offline photo storage (`path: 'photos'`). The screen shows its own sentence for it.
 */
export const PHOTO_STORAGE_FULL = 'photo_storage_full';

type Client = Pick<ApiClient, 'workLogs' | 'tasks' | 'notifications'>;

export interface OfflineRepositoryDeps {
  user: ViewUser;
  store: OfflineLocalStore;
  queue: OfflineWriteQueue;
  photos: LocalPhotoStore;
  /** For records the cache does not hold, and for the writes that are not queued. */
  client: Client;
  newId: () => string;
  clock?: () => Date;
}

function invalid(path: string, message: string): WriteError {
  return { kind: 'invalid', message, details: [{ path, message }] };
}

const notFound: WriteError = { kind: 'notFound', message: 'Not found', details: [] };

export function createOfflineRepositories(deps: OfflineRepositoryDeps): Repositories {
  const { store, queue, photos, client, user } = deps;
  const clock = deps.clock ?? (() => new Date());
  const photoRun = createSerialRunner();

  async function occurredAtProblem(occurredAt: string, now: Date): Promise<WriteError | null> {
    const meta = await store.getSyncMeta();
    const days = meta.organization?.offlineMaxBackdateDays ?? offlineMaxBackdateDaysOf(undefined);
    const problem = occurredAtRangeProblem(occurredAt, now, days);
    if (problem === null) return null;
    return invalid(
      'occurredAt',
      problem === 'in_future'
        ? 'occurredAt must not be in the future'
        : `occurredAt must be within the last ${days} days`,
    );
  }

  /** The log as the worker sees it, its cached server copy, or why it cannot be found. */
  async function resolveLog(
    idOrClientId: string,
  ): Promise<
    { ok: true; log: WorkLog; server: WorkLog | null } | { ok: false; error: WriteError }
  > {
    const cached = await store.list('workLogs');
    const view = findWorkLog(viewWorkLogs(cached, await queue.list(), user), idOrClientId);
    if (view) {
      return {
        ok: true,
        log: view,
        server: cached.find((log) => log.clientId === view.clientId) ?? null,
      };
    }
    // Older than the cache window (opened from a notification): ask the server once.
    const fetched = fromApiResult(await client.workLogs.get(idOrClientId));
    if (!fetched.ok) return fetched;
    await store.upsert('workLogs', [fetched.data]);
    return { ok: true, log: fetched.data, server: fetched.data };
  }

  /**
   * Moves photos into the photo store, or refuses when they do not fit: all or nothing. The
   * check and the moves run one batch at a time (`photoRun`), so two saves cannot both pass the
   * check and then overfill the store; a refusal past the check still answers the storage-full
   * error, never a silent partial save. (Moved files are not deleted on that refusal: `save`
   * moves them, so deleting would lose the worker's photos; the next open sweeps unused ones.)
   */
  async function keepPhotos(
    list: readonly LocalPhoto[],
  ): Promise<{ ok: true; photos: LocalPhoto[] } | { ok: false; error: WriteError }> {
    if (list.length === 0) return { ok: true, photos: [] };
    return photoRun(async () => {
      const total = list.reduce((sum, photo) => sum + photo.sizeBytes, 0);
      if (!(await photos.canAdd(total))) {
        return { ok: false as const, error: invalid('photos', PHOTO_STORAGE_FULL) };
      }
      const kept: LocalPhoto[] = [];
      for (const photo of list) {
        const saved = await photos.save(photo);
        if (!saved.ok) return { ok: false as const, error: invalid('photos', PHOTO_STORAGE_FULL) };
        kept.push(saved.photo);
      }
      return { ok: true as const, photos: kept };
    });
  }

  function uploadsFor(
    workLogClientId: string,
    workLogId: string | null,
    list: readonly LocalPhoto[],
    clientIds: readonly string[],
  ): QueuedMutation[] {
    return list.map((photo, index) => ({
      kind: 'uploadAttachment',
      workLogClientId,
      workLogId,
      attachmentClientId: clientIds[index] ?? deps.newId(),
      photo,
      checkpoint: { attachmentId: null, stored: false },
    }));
  }

  const workLogs: WorkLogsRepository = {
    async create(body, list = []) {
      const now = clock();
      const known = await store.getWorkLogByClientId(body.clientId);
      if (known)
        return { ok: true, data: { clientId: body.clientId, sync: 'settled', log: known } };
      const queued = (await queue.list()).some(
        (item) =>
          item.mutation.kind === 'createWorkLog' && item.mutation.body.clientId === body.clientId,
      );
      if (queued)
        return { ok: true, data: { clientId: body.clientId, sync: 'pending', log: null } };

      const problem = await occurredAtProblem(body.occurredAt, now);
      if (problem) return { ok: false, error: problem };
      const kept = await keepPhotos(list);
      if (!kept.ok) return kept;

      const attachmentClientIds = kept.photos.map(() => deps.newId());
      const create: QueuedMutation = {
        kind: 'createWorkLog',
        body: {
          ...body,
          attachmentClientIds: [...(body.attachmentClientIds ?? []), ...attachmentClientIds],
          deviceCreatedAt: body.deviceCreatedAt ?? now.toISOString(),
        },
      };
      await queue.enqueueAll(
        [create, ...uploadsFor(body.clientId, null, kept.photos, attachmentClientIds)],
        now,
      );
      return { ok: true, data: { clientId: body.clientId, sync: 'pending', log: null } };
    },

    async update(id, body) {
      const now = clock();
      const resolved = await resolveLog(id);
      if (!resolved.ok) return resolved;
      if (body.occurredAt !== undefined) {
        const problem = await occurredAtProblem(body.occurredAt, now);
        if (problem) return { ok: false, error: problem };
      }
      const expectedVersion = resolved.server?.version;
      await queue.enqueue(
        {
          kind: 'updateWorkLog',
          workLogClientId: resolved.log.clientId,
          body: expectedVersion === undefined ? body : { ...body, expectedVersion },
        },
        now,
      );
      return { ok: true, data: applyEdit(resolved.log, body) };
    },

    async changeStatus(id, body) {
      const resolved = await resolveLog(id);
      if (!resolved.ok) return resolved;
      const expectedVersion = resolved.server?.version;
      await queue.enqueue(
        {
          kind: 'changeWorkLogStatus',
          workLogClientId: resolved.log.clientId,
          body: expectedVersion === undefined ? body : { ...body, expectedVersion },
        },
        clock(),
      );
      return { ok: true, data: { ...resolved.log, status: body.status } };
    },
  };

  // Creates run one at a time: a double tap must find the first save already queued (one log),
  // not race it to move the same photo files (the second move would throw).
  const serial = createSerialRunner();
  const createOnce = workLogs.create;
  workLogs.create = (body, list) => serial(() => createOnce(body, list));

  const tasks: TasksRepository = {
    async changeStatus(id, body) {
      let task = await store.get('tasks', id);
      if (!task) {
        const fetched = fromApiResult(await client.tasks.get(id));
        if (!fetched.ok) return fetched;
        task = fetched.data;
        await store.upsert('tasks', [task]);
      }
      await queue.enqueue(
        { kind: 'changeTaskStatus', taskId: id, body: { ...body, expectedVersion: task.version } },
        clock(),
      );
      const [view] = viewTasks([task], await queue.list());
      return view ? { ok: true, data: view } : { ok: false, error: notFound };
    },
  };

  const attachments: AttachmentsRepository = {
    async add(workLogId, list) {
      if (list.length === 0) return { ok: true, data: { queued: 0 } };
      const resolved = await resolveLog(workLogId);
      if (!resolved.ok) return resolved;
      const kept = await keepPhotos(list);
      if (!kept.ok) return kept;
      const ids = kept.photos.map(() => deps.newId());
      await queue.enqueueAll(
        uploadsFor(resolved.log.clientId, resolved.server?.id ?? null, kept.photos, ids),
        clock(),
      );
      return { ok: true, data: { queued: kept.photos.length } };
    },
  };

  const notifications: NotificationsRepository = {
    async markRead(id) {
      const written = fromApiResult(await client.notifications.markRead(id));
      if (written.ok) await store.upsert('notifications', [written.data]);
      return written;
    },
    async markAllRead() {
      const written = fromApiResult(await client.notifications.markAllRead());
      if (written.ok) {
        const readAt = clock().toISOString();
        const unread = (await store.list('notifications')).filter((item) => item.readAt === null);
        await store.upsert(
          'notifications',
          unread.map((item) => ({ ...item, readAt })),
        );
      }
      return written;
    },
    async registerPushToken(body) {
      return fromApiResult(await client.notifications.registerPushToken(body));
    },
    async unregisterPushToken(token) {
      return fromApiResult(await client.notifications.unregisterPushToken(token));
    },
  };

  return { workLogs, tasks, attachments, notifications };
}
