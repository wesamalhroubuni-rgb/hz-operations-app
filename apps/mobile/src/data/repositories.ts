import {
  uploadAttachment,
  type ApiClient,
  type AttachmentUploadResult,
  type ChangeTaskStatus,
  type ChangeWorkLogStatus,
  type CreateWorkLogInput,
  type RegisterPushToken,
  type Task,
  type UpdateWorkLog,
  type UploadCheckpoint,
  type UploadPut,
  type WorkLog,
} from '@ops/shared';

import type { LocalPhoto } from '../storage/localPhoto';
import { fromApiResult, type WriteResult } from './results';

// The phone's one write path. Screens and hooks call these repositories; nothing else calls the
// API to change data. Each write resolves to a typed `WriteResult` and tells the cache what
// changed, so lists refresh without the screen knowing which.
//
// Phase 5 (offline) implements the same interfaces with a local queue: `create` will store the
// log on the phone, answer `{ sync: 'pending', log: null }` at once, and send it later with the
// same `clientId`. Screens already handle both answers.

/** What a saved new log looks like to a screen. */
export type SavedWorkLog =
  | { clientId: string; sync: 'settled'; log: WorkLog }
  | { clientId: string; sync: 'pending'; log: null };

export interface WorkLogsRepository {
  /** Creates the log. Idempotent by `clientId`: repeating it returns the same log. */
  create(body: CreateWorkLogInput): Promise<WriteResult<SavedWorkLog>>;
  update(id: string, body: UpdateWorkLog): Promise<WriteResult<WorkLog>>;
  changeStatus(id: string, body: ChangeWorkLogStatus): Promise<WriteResult<WorkLog>>;
}

export interface TasksRepository {
  changeStatus(id: string, body: ChangeTaskStatus): Promise<WriteResult<Task>>;
}

export interface UploadItem {
  workLogId: string;
  photo: LocalPhoto;
  checkpoint: UploadCheckpoint;
}

export interface AttachmentsRepository {
  /** One attempt (or the resumption of one) to attach a prepared photo to a saved log. */
  upload(item: UploadItem, onProgress: (fraction: number) => void): Promise<AttachmentUploadResult>;
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

/** How a repository tells the read cache what changed. Implemented over TanStack Query. */
export interface CacheSync {
  workLogChanged(log: WorkLog): void;
  taskChanged(task: Task): void;
  attachmentsChanged(workLogId: string): void;
  notificationsChanged(): void;
}

export const NO_CACHE: CacheSync = {
  workLogChanged: () => undefined,
  taskChanged: () => undefined,
  attachmentsChanged: () => undefined,
  notificationsChanged: () => undefined,
};

type Client = Pick<ApiClient, 'workLogs' | 'tasks' | 'attachments' | 'notifications'>;

/** Sends the bytes of a local file with the platform's uploader (`src/device/upload.ts`). */
export type PutFile = (uri: string) => UploadPut;

export function createRemoteRepositories(
  client: Client,
  cache: CacheSync,
  putFile: PutFile,
): Repositories {
  const workLogs: WorkLogsRepository = {
    async create(body) {
      let result = await client.workLogs.create(body);
      // The clientId makes a repeat harmless: one immediate retry covers a dropped answer.
      if (!result.ok && (result.failure.kind === 'network' || result.failure.kind === 'timeout')) {
        result = await client.workLogs.create(body);
      }
      const written = fromApiResult(result);
      if (!written.ok) return written;
      cache.workLogChanged(written.data);
      return { ok: true, data: { clientId: body.clientId, sync: 'settled', log: written.data } };
    },
    async update(id, body) {
      const written = fromApiResult(await client.workLogs.update(id, body));
      if (written.ok) cache.workLogChanged(written.data);
      return written;
    },
    async changeStatus(id, body) {
      const written = fromApiResult(await client.workLogs.changeStatus(id, body));
      if (written.ok) cache.workLogChanged(written.data);
      return written;
    },
  };

  const tasks: TasksRepository = {
    async changeStatus(id, body) {
      const written = fromApiResult(await client.tasks.changeStatus(id, body));
      if (written.ok) cache.taskChanged(written.data);
      return written;
    },
  };

  const attachments: AttachmentsRepository = {
    async upload(item, onProgress) {
      const result = await uploadAttachment(client.attachments, {
        workLogId: item.workLogId,
        file: {
          fileName: item.photo.fileName,
          mimeType: item.photo.mimeType,
          sizeBytes: item.photo.sizeBytes,
        },
        put: putFile(item.photo.uri),
        onProgress,
        checkpoint: item.checkpoint,
      });
      if (result.ok) cache.attachmentsChanged(item.workLogId);
      return result;
    },
  };

  const notifications: NotificationsRepository = {
    async markRead(id) {
      const written = fromApiResult(await client.notifications.markRead(id));
      if (written.ok) cache.notificationsChanged();
      return written;
    },
    async markAllRead() {
      const written = fromApiResult(await client.notifications.markAllRead());
      if (written.ok) cache.notificationsChanged();
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
