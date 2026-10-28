import type { ApiClient, AuthUser } from '@ops/shared';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { ErrorState } from '../components/StateViews';
import { deleteLocalFile } from '../device/files';
import { newOfflineId, offlineSessions, setOfflineApiClient } from '../offline/runtime';
import type { AppOfflineSession } from '../offline/session';
import { LoadingScreen } from '../screens/LoadingScreen';
import { deviceStore } from '../storage/deviceStore';
import { createDraftStore, type DraftStore } from '../storage/draftStore';
import { purgeStaleLocalDataOnce } from '../storage/retention';
import { queryKeys } from './queryKeys';
import { createOfflineRepositories, type Repositories } from './repositories';
import { ReadError } from './results';
import { createUploadsView, type UploadQueue } from './uploadQueue';

// Everything a signed-in screen needs to read and write data, for one user. The provider is
// mounted with the user's id as its key; it opens THAT user's offline layer (their own SQLite
// database, queue and photo folder, ADR-0008) and renders the screens once it is open. Another
// user gets their own; nothing of the previous user is read or sent.
//
// SYNC SEAM: the session's `engine` (built by `src/offline/runtime.ts`) is started here when the
// session opens and stopped when it closes. The sync UI reaches it with `useData().offline`.

export interface DataContextValue {
  user: AuthUser;
  /** For the read hooks in `queries.ts` only. Screens never call the API client. */
  client: ApiClient;
  repositories: Repositories;
  uploads: UploadQueue;
  drafts: DraftStore;
  /** The user's open offline layer: store, queue, photo store, sync engine. */
  offline: AppOfflineSession;
}

const DataContext = createContext<DataContextValue | null>(null);

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        // One quiet retry for a dropped connection; refusals (403, 404) are final.
        retry: (failureCount, error) =>
          failureCount < 1 &&
          (!(error instanceof ReadError) ||
            error.error.kind === 'network' ||
            error.error.kind === 'server'),
      },
      mutations: { retry: false },
    },
  });
}

/** Re-reads the local queries whenever the store or the queue changes (debounced). */
function invalidateOnChange(session: AppOfflineSession, queryClient: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let uploadsSeen = new Set<string>();
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void queryClient.invalidateQueries({
        // The scope and the photos' signed URLs come from the server: not on every change.
        predicate: (query) =>
          query.queryKey[0] !== queryKeys.scope[0] && query.queryKey[2] !== 'attachments',
      });
      // A photo finished (its upload item left the queue): its log's photos changed.
      void session.queue
        .list()
        .then((items) => {
          const now = new Set(
            items.flatMap((item) =>
              item.mutation.kind === 'uploadAttachment'
                ? [`${item.mutation.workLogId ?? ''}|${item.mutation.workLogClientId}`]
                : [],
            ),
          );
          for (const key of uploadsSeen) {
            if (now.has(key)) continue;
            for (const id of key.split('|')) {
              if (id) void queryClient.invalidateQueries({ queryKey: queryKeys.attachments(id) });
            }
          }
          uploadsSeen = now;
        })
        .catch(() => undefined);
    }, 50);
  };
  const unsubscribeStore = session.store.subscribe(schedule);
  const unsubscribeQueue = session.queue.subscribe(schedule);
  return () => {
    if (timer !== null) clearTimeout(timer);
    unsubscribeStore();
    unsubscribeQueue();
  };
}

export function DataProvider({
  user,
  client,
  children,
}: Readonly<{ user: AuthUser; client: ApiClient; children: ReactNode }>) {
  const [queryClient] = useState(createQueryClient);
  const [session, setSession] = useState<AppOfflineSession | null>(null);
  const [openFailed, setOpenFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let opened: AppOfflineSession | null = null;
    setOfflineApiClient(client);
    void (async () => {
      // The draft retention sweep of the app start runs first (it never rejects).
      await purgeStaleLocalDataOnce({ store: deviceStore, deleteLocalFile });
      try {
        opened = await offlineSessions.open(user.id);
      } catch {
        if (active) setOpenFailed(true);
        return;
      }
      if (!active) {
        void opened.close();
        return;
      }
      opened.engine.start();
      setSession(opened);
      // Users who signed out with "keep for later" more than 30 days ago (never this one).
      void offlineSessions.sweepAbandoned(new Date()).catch(() => []);
    })();
    return () => {
      active = false;
      setSession(null);
      if (opened) void opened.close();
      queryClient.clear();
    };
  }, [client, queryClient, user.id, attempt]);

  useEffect(
    () => (session ? invalidateOnChange(session, queryClient) : undefined),
    [session, queryClient],
  );

  const value = useMemo<DataContextValue | null>(() => {
    if (!session) return null;
    const repositories = createOfflineRepositories({
      user,
      store: session.store,
      queue: session.queue,
      photos: session.photos,
      client,
      newId: newOfflineId,
    });
    const uploads = createUploadsView({
      queue: session.queue,
      store: session.store,
      kick: () => void session.engine.syncNow('manual').catch(() => undefined),
    });
    return {
      user,
      client,
      repositories,
      uploads,
      drafts: createDraftStore(deviceStore),
      offline: session,
    };
  }, [client, session, user]);

  useEffect(() => () => value?.uploads.dispose(), [value]);

  useEffect(() => {
    // Refetch stale data when the app comes back to the foreground.
    const subscription = AppState.addEventListener('change', (status) => {
      focusManager.setFocused(status === 'active');
    });
    return () => subscription.remove();
  }, []);

  if (value === null) {
    return openFailed ? (
      <ErrorState
        onRetry={() => {
          setOpenFailed(false);
          setAttempt((count) => count + 1);
        }}
      />
    ) : (
      <LoadingScreen />
    );
  }

  return (
    <QueryClientProvider client={queryClient}>
      <DataContext.Provider value={value}>{children}</DataContext.Provider>
    </QueryClientProvider>
  );
}

export function useData(): DataContextValue {
  const value = useContext(DataContext);
  if (value === null) {
    throw new Error('useData must be used inside <DataProvider>');
  }
  return value;
}

/** The repositories: the one way screens and hooks change data. */
export function useRepositories(): Repositories {
  return useData().repositories;
}

/** The signed-in user's offline layer (store, queue, photos, engine), for the sync UI. */
export function useOfflineSession(): AppOfflineSession {
  return useData().offline;
}
