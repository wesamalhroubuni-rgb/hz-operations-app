import type { UploadCheckpoint } from '@ops/shared';

import type { OfflineLocalStore } from '../offline/localStore';
import type { QueueItem, QueueItemError } from '../offline/types';
import type { OfflineWriteQueue } from '../offline/writeQueue';
import type { LocalPhoto } from '../storage/localPhoto';

// The photos still on their way to the server, as the log screens show them. Since Phase 5 they
// are `uploadAttachment` items of the user's write queue (ADR-0008): this module is a read-only
// view over the queue in the Phase 4 shape (`QueuedPhoto`), plus "retry" and "remove" actions
// that act on the queue. The Phase 4 AsyncStorage queue is migrated by
// `src/offline/legacyUploads.ts`.

/** Why a photo is not uploaded yet, as the screen explains it. */
export type UploadErrorKind =
  /** No connection, a timeout, or the server or storage had trouble: retrying should help. */
  | 'network'
  /** The log can no longer take photos (approved, archived, or the edit window closed). */
  | 'notAllowed'
  /** The log is gone or out of reach. */
  | 'notFound'
  /** The server refused the file (too large, wrong type). */
  | 'rejected'
  | 'unexpected';

export function uploadErrorKindOf(error: QueueItemError): UploadErrorKind {
  switch (error.code) {
    case 'network':
    case 'timeout':
    case 'rate_limited':
    case 'service_unavailable':
    case 'internal_error':
    case 'request_in_progress':
    case 'unauthenticated':
      return 'network';
    case 'forbidden':
    case 'edit_window_closed':
    case 'attachment_not_declared':
    case 'already_reviewed':
    case 'record_archived':
    case 'conflict':
      return 'notAllowed';
    case 'not_found':
      return 'notFound';
    case 'validation_failed':
    case 'unprocessable':
      return 'rejected';
    default:
      return 'unexpected';
  }
}

export interface QueuedPhoto {
  /** The queue item. */
  itemId: string;
  /** The log's server id when known, else its clientId (a log not sent yet). */
  workLogId: string;
  workLogClientId: string;
  photo: LocalPhoto;
  checkpoint: UploadCheckpoint;
  status: 'waiting' | 'uploading' | 'retrying' | 'failed';
  /** 0..1 while uploading. */
  progress: number;
  /** Automatic attempts that failed since the last manual retry. */
  attempts: number;
  error: UploadErrorKind | null;
  /** When the photo was queued (ISO). */
  queuedAt: string;
}

export interface UploadQueueState {
  items: readonly QueuedPhoto[];
}

/** One queue item as a queued photo; null for other kinds. */
export function queuedPhotoOf(
  item: QueueItem,
  serverIdByClientId: ReadonlyMap<string, string>,
  progress: number | null,
): QueuedPhoto | null {
  const mutation = item.mutation;
  if (mutation.kind !== 'uploadAttachment') return null;
  const status: QueuedPhoto['status'] =
    item.state === 'sending'
      ? 'uploading'
      : item.state === 'failed_permanent'
        ? 'failed'
        : item.state === 'failed_retryable' || item.lastError !== null
          ? 'retrying'
          : 'waiting';
  return {
    itemId: item.id,
    workLogId:
      mutation.workLogId ??
      serverIdByClientId.get(mutation.workLogClientId) ??
      mutation.workLogClientId,
    workLogClientId: mutation.workLogClientId,
    photo: mutation.photo,
    checkpoint: mutation.checkpoint,
    status,
    progress: status === 'uploading' ? (progress ?? 0) : 0,
    attempts: item.attempts,
    error: item.lastError ? uploadErrorKindOf(item.lastError) : null,
    queuedAt: item.createdAt,
  };
}

/** Whether a queued photo belongs to the log a screen shows (by server id or clientId). */
export function isPhotoOfLog(item: QueuedPhoto, logId: string): boolean {
  return item.workLogId === logId || item.workLogClientId === logId;
}

export interface UploadQueue {
  getState(): UploadQueueState;
  subscribe(listener: () => void): () => void;
  /** Tries the failed photos of a log (or all) again now. */
  retry(workLogId?: string): void;
  /** Gives up on one photo: removes it from the queue and deletes the local copy. */
  discard(localId: string): Promise<void>;
  /** Re-reads the queue (after a change the view was not told about). */
  refresh(): Promise<void>;
  /** Stops listening to the queue. */
  dispose(): void;
}

export interface UploadsViewDeps {
  queue: OfflineWriteQueue;
  store: Pick<OfflineLocalStore, 'list'>;
  /** Asks the sync engine to run now (after a manual retry). */
  kick?: () => void;
  now?: () => Date;
}

export function createUploadsView(deps: UploadsViewDeps): UploadQueue {
  const clock = deps.now ?? (() => new Date());
  let state: UploadQueueState = { items: [] };
  let items: QueueItem[] = [];
  let serverIds = new Map<string, string>();
  const listeners = new Set<() => void>();
  let disposed = false;

  function rebuild(): void {
    state = {
      items: items
        .map((item) => queuedPhotoOf(item, serverIds, deps.queue.progressOf(item.id)))
        .filter((item): item is QueuedPhoto => item !== null),
    };
    for (const listener of [...listeners]) listener();
  }

  async function refresh(): Promise<void> {
    try {
      const [queued, logs] = await Promise.all([deps.queue.list(), deps.store.list('workLogs')]);
      if (disposed) return;
      items = queued;
      serverIds = new Map(logs.map((log) => [log.clientId, log.id]));
      rebuild();
    } catch {
      // The database closed (sign-out); the view is going away.
    }
  }

  const unsubscribe = deps.queue.subscribe(() => void refresh());
  const unsubscribeProgress = deps.queue.subscribeProgress(rebuild);
  void refresh();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retry(workLogId) {
      const targets = state.items.filter(
        (item) =>
          (item.status === 'failed' || item.status === 'retrying') &&
          (workLogId === undefined || isPhotoOfLog(item, workLogId)),
      );
      void (async () => {
        for (const item of targets) await deps.queue.retry(item.itemId, clock());
        deps.kick?.();
      })();
    },
    async discard(localId) {
      const item = state.items.find((candidate) => candidate.photo.localId === localId);
      if (!item || item.status === 'uploading') return;
      await deps.queue.discard(item.itemId);
    },
    refresh,
    dispose() {
      disposed = true;
      unsubscribe();
      unsubscribeProgress();
      listeners.clear();
    },
  };
}
