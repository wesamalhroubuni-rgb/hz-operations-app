import {
  EMPTY_UPLOAD_CHECKPOINT,
  uploadRetryDelayMs,
  type AttachmentUploadResult,
  type UploadCheckpoint,
  type UploadFailure,
} from '@ops/shared';
import { z } from 'zod';

import type { KeyValueStore } from '../storage/keyValueStore';
import { localPhotoSchema, type LocalPhoto } from '../storage/localPhoto';

// The photos of saved work logs that still have to reach the server. A log is saved first and
// its photos are uploaded afterwards, one at a time, by this queue: a failed photo never loses
// the log, and the queue survives restarts (it is persisted per user). Retryable failures are
// retried automatically a few times with a growing delay; after that, or for a refusal, the
// photo waits for the worker's "Retry" on the log screen.
//
// Phase 5 extends the same idea to the log itself (a local queue of writes).

/** Why a photo is not uploaded yet, as the screen explains it. */
export type UploadErrorKind =
  /** No connection, a timeout, or the server or storage had trouble: retrying should help. */
  | 'network'
  /** The log can no longer take photos (approved, or the edit window closed). */
  | 'notAllowed'
  /** The log is gone or out of reach. */
  | 'notFound'
  /** The server refused the file (too large, wrong type). */
  | 'rejected'
  | 'unexpected';

export function uploadErrorKind(failure: UploadFailure): UploadErrorKind {
  if (failure.retryable) return 'network';
  const api = failure.api;
  if (api?.kind === 'http') {
    if (api.status === 403) return 'notAllowed';
    if (api.status === 404) return 'notFound';
    if (api.status === 400 || api.status === 413 || api.status === 422) return 'rejected';
    if (api.status === 409) return 'notAllowed';
  }
  if (failure.step === 'put' && failure.putStatus !== null && failure.putStatus >= 400) {
    return 'rejected';
  }
  return 'unexpected';
}

export interface QueuedPhoto {
  workLogId: string;
  photo: LocalPhoto;
  checkpoint: UploadCheckpoint;
  status: 'waiting' | 'uploading' | 'retrying' | 'failed';
  /** 0..1 while uploading. */
  progress: number;
  /** Automatic attempts that failed since the last manual retry. */
  attempts: number;
  error: UploadErrorKind | null;
  /** When the photo was queued (ISO): queued photos are deleted after 14 days (retention.ts). */
  queuedAt: string;
}

export interface UploadQueueState {
  items: readonly QueuedPhoto[];
}

const persistedSchema = z.array(
  z.object({
    workLogId: z.string().min(1),
    photo: localPhotoSchema,
    checkpoint: z.object({ attachmentId: z.string().nullable(), stored: z.boolean() }),
    failed: z.boolean(),
    error: z.string().nullable(),
    // Missing in queues written before the retention rule: stamped on the next load.
    queuedAt: z.string().optional(),
  }),
);

export const UPLOAD_QUEUE_KEY_PREFIX = 'ops.uploads.pending.';

export function uploadQueueKey(userId: string): string {
  return `${UPLOAD_QUEUE_KEY_PREFIX}${userId}`;
}

/**
 * Removes the entries of a stored queue (any user's) queued more than `maxAgeMs` ago. Entries
 * without `queuedAt` (older app versions) are stamped `now`, so they expire 14 days from the
 * first sweep. `value` is the new stored value (null: remove the key), `changed` says whether
 * to write it, `expiredUris` are the local files to delete and `keptUris` those still needed.
 */
export function pruneStaleQueue(
  raw: string | null,
  now: Date,
  maxAgeMs: number,
): { value: string | null; changed: boolean; expiredUris: string[]; keptUris: string[] } {
  if (raw === null) return { value: null, changed: false, expiredUris: [], keptUris: [] };
  let entries: z.infer<typeof persistedSchema>;
  try {
    const result = persistedSchema.safeParse(JSON.parse(raw));
    if (!result.success) return { value: null, changed: true, expiredUris: [], keptUris: [] };
    entries = result.data;
  } catch {
    return { value: null, changed: true, expiredUris: [], keptUris: [] };
  }
  const nowIso = now.toISOString();
  let changed = false;
  const kept: typeof entries = [];
  const expiredUris: string[] = [];
  for (const entry of entries) {
    if (entry.queuedAt === undefined) {
      kept.push({ ...entry, queuedAt: nowIso });
      changed = true;
      continue;
    }
    const queuedAt = Date.parse(entry.queuedAt);
    if (!Number.isFinite(queuedAt) || now.getTime() - queuedAt > maxAgeMs) {
      expiredUris.push(entry.photo.uri);
      changed = true;
      continue;
    }
    kept.push(entry);
  }
  return {
    value: kept.length === 0 ? null : JSON.stringify(kept),
    changed,
    expiredUris,
    keptUris: kept.map((entry) => entry.photo.uri),
  };
}

export interface UploadQueueDeps {
  store: KeyValueStore;
  /** One attempt for one photo (the attachments repository). Must not throw. */
  upload: (
    item: Pick<QueuedPhoto, 'workLogId' | 'photo' | 'checkpoint'>,
    onProgress: (fraction: number) => void,
  ) => Promise<AttachmentUploadResult>;
  /** Removes the local copy once the photo is on the server (or discarded). */
  deleteLocalFile: (uri: string) => Promise<void>;
  /** A photo of this log became ready: refresh what shows the log's photos. */
  onUploaded?: (workLogId: string) => void;
  /** The clock that stamps `queuedAt` (tests). */
  now?: () => Date;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  retryDelayMs?: (attempt: number) => number | null;
}

export interface UploadQueue {
  getState(): UploadQueueState;
  subscribe(listener: () => void): () => void;
  /** Loads the user's queue from the phone and starts working through it. */
  start(userId: string): Promise<void>;
  /** Stops working (sign-out). The queue stays on the phone for the same user's next sign-in. */
  stop(): void;
  enqueue(workLogId: string, photos: readonly LocalPhoto[]): Promise<void>;
  /** Tries the failed photos of a log (or all) again now. */
  retry(workLogId?: string): void;
  /** Gives up on one photo: removes it from the queue and deletes the local copy. */
  discard(localId: string): Promise<void>;
  /** Resolves when nothing is uploading or waiting (tests, and the check script). */
  whenIdle(): Promise<void>;
}

export function createUploadQueue(deps: UploadQueueDeps): UploadQueue {
  const schedule = deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel =
    deps.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const delayFor = deps.retryDelayMs ?? ((attempt: number) => uploadRetryDelayMs(attempt));
  const clock = deps.now ?? (() => new Date());

  let state: UploadQueueState = { items: [] };
  let userId: string | null = null;
  let running = false;
  let generation = 0;
  const timers = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  let idleWaiters: (() => void)[] = [];

  function setItems(items: QueuedPhoto[]): void {
    state = { items };
    listeners.forEach((listener) => listener());
  }

  function update(localId: string, change: Partial<QueuedPhoto>): void {
    setItems(
      state.items.map((item) => (item.photo.localId === localId ? { ...item, ...change } : item)),
    );
  }

  async function persist(): Promise<void> {
    if (userId === null) return;
    const value = state.items.map((item) => ({
      workLogId: item.workLogId,
      photo: item.photo,
      checkpoint: item.checkpoint,
      failed: item.status === 'failed',
      error: item.error,
      queuedAt: item.queuedAt,
    }));
    await deps.store.setItem(uploadQueueKey(userId), JSON.stringify(value)).catch(() => undefined);
  }

  function isIdle(): boolean {
    return (
      !running &&
      !state.items.some((item) => item.status === 'waiting' || item.status === 'uploading')
    );
  }

  function notifyIdle(): void {
    if (isIdle() && timers.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  async function pump(): Promise<void> {
    if (running || userId === null) return;
    running = true;
    const myGeneration = generation;
    try {
      for (;;) {
        if (myGeneration !== generation) return;
        const next = state.items.find((item) => item.status === 'waiting');
        if (!next) return;
        const localId = next.photo.localId;
        update(localId, { status: 'uploading', progress: 0, error: null });
        const result = await deps.upload(next, (fraction) => {
          if (myGeneration === generation) update(localId, { progress: fraction });
        });
        if (myGeneration !== generation) return;
        if (result.ok) {
          setItems(state.items.filter((item) => item.photo.localId !== localId));
          await persist();
          await deps.deleteLocalFile(next.photo.uri).catch(() => undefined);
          deps.onUploaded?.(next.workLogId);
          continue;
        }
        const attempts = next.attempts + 1;
        const kind = uploadErrorKind(result.failure);
        const delay = result.failure.retryable ? delayFor(attempts) : null;
        if (delay === null) {
          update(localId, {
            status: 'failed',
            checkpoint: result.checkpoint,
            attempts,
            error: kind,
            progress: 0,
          });
        } else {
          update(localId, {
            status: 'retrying',
            checkpoint: result.checkpoint,
            attempts,
            error: kind,
            progress: 0,
          });
          const handle = schedule(() => {
            timers.delete(localId);
            const current = state.items.find((item) => item.photo.localId === localId);
            if (current?.status === 'retrying' && myGeneration === generation) {
              update(localId, { status: 'waiting' });
              void pump();
            }
            notifyIdle();
          }, delay);
          timers.set(localId, handle);
        }
        await persist();
      }
    } finally {
      running = false;
      notifyIdle();
    }
  }

  function clearTimers(): void {
    timers.forEach((handle) => cancel(handle));
    timers.clear();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async start(id) {
      if (userId === id) return;
      generation += 1;
      clearTimers();
      userId = id;
      let raw: string | null;
      try {
        raw = await deps.store.getItem(uploadQueueKey(id));
      } catch {
        raw = null;
      }
      let parsed: z.infer<typeof persistedSchema>;
      try {
        const result = persistedSchema.safeParse(raw === null ? [] : JSON.parse(raw));
        parsed = result.success ? result.data : [];
      } catch {
        parsed = [];
      }
      if (userId !== id) return;
      setItems(
        parsed.map((item) => ({
          workLogId: item.workLogId,
          photo: item.photo,
          checkpoint: item.checkpoint,
          // After a restart, photos that were not given up on are tried again once.
          status: item.failed ? 'failed' : 'waiting',
          progress: 0,
          attempts: 0,
          error: item.failed ? ((item.error as UploadErrorKind | null) ?? 'unexpected') : null,
          queuedAt: item.queuedAt ?? clock().toISOString(),
        })),
      );
      void pump();
    },
    stop() {
      generation += 1;
      clearTimers();
      userId = null;
      running = false;
      setItems([]);
      notifyIdle();
    },
    async enqueue(workLogId, photos) {
      if (userId === null || photos.length === 0) return;
      const known = new Set(state.items.map((item) => item.photo.localId));
      const added: QueuedPhoto[] = photos
        .filter((photo) => !known.has(photo.localId))
        .map((photo) => ({
          workLogId,
          photo,
          checkpoint: { ...EMPTY_UPLOAD_CHECKPOINT },
          status: 'waiting',
          progress: 0,
          attempts: 0,
          error: null,
          queuedAt: clock().toISOString(),
        }));
      setItems([...state.items, ...added]);
      await persist();
      void pump();
    },
    retry(workLogId) {
      const ids: string[] = [];
      setItems(
        state.items.map((item) => {
          if (
            (item.status === 'failed' || item.status === 'retrying') &&
            (workLogId === undefined || item.workLogId === workLogId)
          ) {
            ids.push(item.photo.localId);
            return { ...item, status: 'waiting', attempts: 0, error: null };
          }
          return item;
        }),
      );
      for (const id of ids) {
        const handle = timers.get(id);
        if (handle !== undefined) {
          cancel(handle);
          timers.delete(id);
        }
      }
      void persist();
      void pump();
    },
    async discard(localId) {
      const item = state.items.find((candidate) => candidate.photo.localId === localId);
      if (!item || item.status === 'uploading') return;
      const handle = timers.get(localId);
      if (handle !== undefined) {
        cancel(handle);
        timers.delete(localId);
      }
      setItems(state.items.filter((candidate) => candidate.photo.localId !== localId));
      await persist();
      await deps.deleteLocalFile(item.photo.uri).catch(() => undefined);
      notifyIdle();
    },
    whenIdle() {
      if (isIdle() && timers.size === 0) return Promise.resolve();
      return new Promise((resolve) => idleWaiters.push(resolve));
    },
  };
}
