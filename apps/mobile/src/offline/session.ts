import type { KeyValueStore } from '../storage/keyValueStore';
import { draftKey, EDIT_DRAFT_KEY_PREFIX } from '../storage/draftStore';
import { createSerialRunner, type OfflineDatabase } from './db';
import { droppedReferencesKey } from './engineNotices';
import type { KeptUsersRegister } from './identity';
import { migrateLegacyUploads, uploadQueueKey } from './legacyUploads';
import { createLocalStore, type OfflineLocalStore } from './localStore';
import { createLocalPhotoStore, type PhotoFiles } from './photoStore';
import type {
  LocalPhotoStore,
  OfflineSession,
  OfflineSessionFactory,
  QueueItem,
  SignOutChoice,
  SyncEngine,
  SyncRunResult,
  SyncStatus,
} from './types';
import { createWriteQueue, type OfflineWriteQueue } from './writeQueue';

// Opens and closes the per-user offline layer (ADR-0008 sections 8 and 11): one user's
// database, queue and photo folder at a time. Opening a user releases them from the kept-queue
// register, resets interrupted sends, migrates the Phase 4 upload queue, and deletes photo files
// no queued upload needs. Sign-out cleanup and the start-up sweep delete what is no longer
// anybody's.

/** What the sync engine is built from. */
export interface OfflineSessionParts {
  userId: string;
  store: OfflineLocalStore;
  queue: OfflineWriteQueue;
  photos: LocalPhotoStore;
}

/**
 * Builds the sync engine of an opened session. ENGINE SEAM: the app passes the real engine's
 * factory (`src/offline/runtime.ts`); tests pass {@link createInertSyncEngine}.
 */
export type SyncEngineFactory = (parts: OfflineSessionParts) => SyncEngine;

export interface AppOfflineSession extends OfflineSession {
  readonly store: OfflineLocalStore;
  readonly queue: OfflineWriteQueue;
}

export interface AppOfflineSessionFactory extends OfflineSessionFactory {
  open(userId: string): Promise<AppOfflineSession>;
  /** The open session, if any. */
  current(): AppOfflineSession | null;
  /**
   * How many queued writes a user has on this phone (the sign-in screen's "N items wait" of a
   * user whose sign-in expired). Opens their database briefly when it is not the open one.
   */
  pendingCountFor(userId: string): Promise<number>;
}

export interface OfflineSessionFactoryDeps {
  openDatabase(userId: string): Promise<OfflineDatabase>;
  deleteDatabase(userId: string): Promise<void>;
  photoFiles: PhotoFiles;
  kept: KeptUsersRegister;
  /** Where the Phase 4 upload queue was kept (AsyncStorage). */
  legacy?: KeyValueStore;
  newId: () => string;
  clock: () => Date;
  createEngine: SyncEngineFactory;
  photoLimitBytes?: number;
  formatCopyText?: (item: QueueItem) => string;
}

interface OpenState {
  session: AppOfflineSession;
  db: OfflineDatabase;
  refs: number;
  /** The stable, non-owning handle `current()` returns (its close does nothing). */
  view: AppOfflineSession;
}

export function createOfflineSessionFactory(
  deps: OfflineSessionFactoryDeps,
): AppOfflineSessionFactory {
  const run = createSerialRunner();
  let open: OpenState | null = null;

  function partsFor(db: OfflineDatabase, userId: string): OfflineSessionParts {
    const store = createLocalStore(db, userId);
    const photos = createLocalPhotoStore(deps.photoFiles, userId, deps.photoLimitBytes);
    const queue = createWriteQueue({
      db,
      userId,
      newId: deps.newId,
      deletePhoto: (localId) => photos.delete(localId),
      clearPhotos: () => photos.clear(),
      lookupWorkLog: (clientId) => store.getWorkLogByClientId(clientId),
      formatCopyText: deps.formatCopyText,
    });
    return { userId, store, queue, photos };
  }

  async function shutDown(state: OpenState): Promise<void> {
    if (open === state) open = null;
    try {
      await state.session.engine.stop();
    } catch {
      // Stopping must never block closing the database.
    }
    await state.db.close().catch(() => undefined);
  }

  function handleFor(state: OpenState): AppOfflineSession {
    let released = false;
    const { session } = state;
    return {
      userId: session.userId,
      store: session.store,
      queue: session.queue,
      photos: session.photos,
      engine: session.engine,
      close: () =>
        run(async () => {
          if (released) return;
          released = true;
          state.refs -= 1;
          if (state.refs <= 0 && open === state) await shutDown(state);
        }),
    };
  }

  async function openNow(userId: string): Promise<OpenState> {
    if (open && open.session.userId === userId) {
      open.refs += 1;
      return open;
    }
    if (open) await shutDown(open);
    const db = await deps.openDatabase(userId);
    const parts = partsFor(db, userId);
    await deps.kept.release(userId).catch(() => undefined);
    await parts.queue.recoverInterrupted();
    if (deps.legacy) {
      await migrateLegacyUploads({
        kv: deps.legacy,
        userId,
        store: parts.store,
        queue: parts.queue,
        photos: parts.photos,
        newId: deps.newId,
        now: deps.clock(),
      }).catch(() => 0);
    }
    // Photo files no queued upload needs (an upload finished but the app died before deleting).
    await parts.photos.deleteAllExcept(await parts.queue.referencedPhotoIds()).catch(() => 0);
    const engine = deps.createEngine(parts);
    const session: AppOfflineSession = { ...parts, engine, close: async () => undefined };
    const state: OpenState = { db, refs: 1, session, view: session };
    open = state;
    return state;
  }

  /**
   * The user's small key-value leftovers: the Phase 4 upload queue, the new-log and edit drafts,
   * and the sync engine's dropped-link notices.
   */
  async function removeUserKeys(userId: string): Promise<void> {
    const kv = deps.legacy;
    if (!kv) return;
    const keys = [uploadQueueKey(userId), draftKey(userId), droppedReferencesKey(userId)];
    const editPrefix = `${EDIT_DRAFT_KEY_PREFIX}${userId}.`;
    for (const key of (await kv.getAllKeys?.().catch(() => [])) ?? []) {
      if (key.startsWith(editPrefix)) keys.push(key);
    }
    for (const key of keys) await kv.removeItem(key).catch(() => undefined);
  }

  async function deleteEverything(userId: string): Promise<void> {
    const now = deps.clock();
    // Registered first: if the app dies halfway, the next start-up sweep finishes the job.
    await deps.kept.deleteSoon(userId, now).catch(() => undefined);
    await deps.deleteDatabase(userId);
    await deps.photoFiles.removeFolder(userId);
    await removeUserKeys(userId);
    await deps.kept.release(userId).catch(() => undefined);
  }

  return {
    open: (userId) => run(async () => handleFor(await openNow(userId))),

    current: () => open?.view ?? null,

    pendingCountFor: (userId) =>
      run(async () => {
        if (open && open.session.userId === userId) return open.session.queue.pendingCount();
        const db = await deps.openDatabase(userId);
        try {
          return await partsFor(db, userId).queue.pendingCount();
        } finally {
          await db.close().catch(() => undefined);
        }
      }),

    signOutCleanup: (userId, choice: SignOutChoice) =>
      run(async () => {
        if (open && open.session.userId === userId) await shutDown(open);
        const db = await deps.openDatabase(userId);
        let pending: number;
        let store: OfflineLocalStore;
        try {
          const parts = partsFor(db, userId);
          store = parts.store;
          pending = await parts.queue.pendingCount();
          if (pending > 0 && choice !== 'discard') {
            // Kept for the same user's next sign-in; the reads go now.
            await store.clearCache();
          }
        } finally {
          await db.close().catch(() => undefined);
        }
        if (pending === 0 || choice === 'discard') {
          await deleteEverything(userId);
        } else {
          // The worker chose "keep for later" and was told about the 30 days.
          await deps.kept.keep(userId, deps.clock(), { explicit: true });
        }
      }),

    sweepAbandoned: (now) =>
      run(async () => {
        const except = open ? [open.session.userId] : [];
        const due = await deps.kept.due(now, except);
        const swept: string[] = [];
        for (const userId of due) {
          try {
            await deps.deleteDatabase(userId);
            await deps.photoFiles.removeFolder(userId);
            await removeUserKeys(userId);
            await deps.kept.release(userId);
            swept.push(userId);
          } catch {
            // Left for the next start.
          }
        }
        return swept;
      }),
  };
}

const NOTHING_SENT: SyncRunResult = {
  sent: 0,
  failedRetryable: 0,
  failedPermanent: 0,
  pulled: false,
  stoppedBecause: 'stopped',
};

/**
 * An engine that sends nothing: it only reports the queue's counts. Used by tests, and by the
 * app until the real engine is wired in at the seam in `runtime.ts`.
 */
export function createInertSyncEngine(parts: OfflineSessionParts): SyncEngine {
  let status: SyncStatus = { kind: 'synced', lastRefreshedAt: null };
  const listeners = new Set<(status: SyncStatus) => void>();
  async function refresh(): Promise<void> {
    const counts = await parts.queue.counts();
    const meta = await parts.store.getSyncMeta();
    const pending = counts.pending + counts.sending + counts.failed_retryable;
    status =
      counts.failed_permanent > 0
        ? { kind: 'failed', failed: counts.failed_permanent, pending }
        : pending > 0
          ? { kind: 'pending', pending }
          : { kind: 'synced', lastRefreshedAt: meta.lastRefreshedAt };
    for (const listener of [...listeners]) listener(status);
  }
  let unsubscribe: (() => void) | null = null;
  return {
    start() {
      unsubscribe ??= parts.queue.subscribe(() => void refresh().catch(() => undefined));
      void refresh().catch(() => undefined);
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
    syncNow: async () => NOTHING_SENT,
    getStatus: () => status,
    subscribe(listener) {
      listeners.add(listener);
      listener(status);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
