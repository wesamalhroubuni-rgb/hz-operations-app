import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { setBackgroundSyncRunner, registerBackgroundSync } from '../offline/background';
import { useOfflineSessionForSync } from '../offline/engineIntegration';
import { logSyncState, logSyncStates, type LogSyncState } from '../logic/sync';
import type { OfflineSession, PhotoStorageUsage, QueueItem, SyncStatus } from '../offline/types';

// The sync state for the screens: the engine's status, the queue's items, the photo storage
// use and "last refreshed", plus the worker's actions on queue items. Screens never touch the
// engine or the queue directly; they use `useSync()`.

export interface SyncContextValue {
  /** False while no offline layer is open: the sync UI stays hidden. */
  available: boolean;
  /** The user whose offline layer is open, or null. */
  userId: string | null;
  status: SyncStatus | null;
  lastRefreshedAt: string | null;
  items: QueueItem[];
  /** Items not yet accepted (sign-out checks it). */
  pendingCount: number;
  logStates: ReadonlyMap<string, LogSyncState>;
  photoUsage: PhotoStorageUsage | null;
  syncing: boolean;
  /** Runs a sync now; resolves with the number of items still on the phone. */
  syncNow: () => Promise<number>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  resubmitAsNew: (id: string) => Promise<void>;
  copyText: (id: string) => Promise<string>;
}

const EMPTY_STATES: ReadonlyMap<string, LogSyncState> = new Map();

const unavailable: SyncContextValue = {
  available: false,
  userId: null,
  status: null,
  lastRefreshedAt: null,
  items: [],
  pendingCount: 0,
  logStates: EMPTY_STATES,
  photoUsage: null,
  syncing: false,
  syncNow: async () => 0,
  retry: async () => undefined,
  discard: async () => undefined,
  resubmitAsNew: async () => undefined,
  copyText: async () => '',
};

const SyncContext = createContext<SyncContextValue>(unavailable);

type SessionParts = Pick<OfflineSession, 'userId' | 'engine' | 'queue' | 'photos' | 'store'>;

/**
 * Provides the sync state of the signed-in user's offline session. `session` defaults to the
 * one of the integration point (`engineIntegration.ts`). Starts the session's engine (starting
 * twice is harmless) and lets the background task run it while mounted; closing the session
 * belongs to its owner.
 */
export function SyncProvider({
  session: given,
  children,
}: Readonly<{ session?: SessionParts | null; children: ReactNode }>) {
  const fromIntegration = useOfflineSessionForSync();
  const session = given === undefined ? fromIntegration : given;
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [items, setItems] = useState<QueueItem[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [photoUsage, setPhotoUsage] = useState<PhotoStorageUsage | null>(null);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const { engine, queue, photos, store } = session;

    const refresh = async () => {
      try {
        const [list, usage, meta] = await Promise.all([
          queue.list(),
          photos.usage(),
          store.getSyncMeta(),
        ]);
        if (!active) return;
        setItems(list);
        setPhotoUsage(usage);
        setLastRefreshedAt(meta.lastRefreshedAt);
      } catch {
        // The database is closing (sign-out): the screen is about to go.
      }
    };

    const stopStatus = engine.subscribe((next) => {
      if (!active) return;
      setStatus(next);
      void refresh();
    });
    const stopQueue = queue.subscribe(() => void refresh());
    engine.start();
    setBackgroundSyncRunner(() => engine.syncNow('background'));
    void registerBackgroundSync();
    void refresh();

    return () => {
      active = false;
      stopStatus();
      stopQueue();
      setBackgroundSyncRunner(null);
    };
  }, [session]);

  const syncNow = useCallback(async (): Promise<number> => {
    if (!session) return 0;
    setSyncing(true);
    try {
      await session.engine.syncNow('manual');
      return await session.queue.pendingCount();
    } finally {
      setSyncing(false);
    }
  }, [session]);

  const value = useMemo<SyncContextValue>(() => {
    if (!session) return unavailable;
    const { engine, queue } = session;
    const kick = () => void engine.syncNow('manual');
    return {
      available: true,
      userId: session.userId,
      status,
      lastRefreshedAt,
      items,
      pendingCount: items.length,
      logStates: logSyncStates(items),
      photoUsage,
      syncing,
      syncNow,
      retry: async (id) => {
        await queue.retry(id, new Date());
        kick();
      },
      discard: (id) => queue.discard(id),
      resubmitAsNew: async (id) => {
        await queue.resubmitAsNew(id, new Date());
        kick();
      },
      copyText: (id) => queue.copyText(id),
    };
  }, [session, status, lastRefreshedAt, items, photoUsage, syncing, syncNow]);

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  return useContext(SyncContext);
}

/** The sync state of one log (by its clientId): pending, failed or synced. */
export function useLogSyncState(clientId: string | null | undefined): LogSyncState {
  const { logStates } = useSync();
  return logSyncState(logStates, clientId);
}
