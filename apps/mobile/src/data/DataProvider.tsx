import type { ApiClient, AuthUser } from '@ops/shared';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { deleteLocalFile } from '../device/files';
import { putFileFromUri } from '../device/upload';
import { deviceStore } from '../storage/deviceStore';
import { createDraftStore, type DraftStore } from '../storage/draftStore';
import { purgeStaleLocalDataOnce } from '../storage/retention';
import { queryKeys } from './queryKeys';
import { ReadError } from './results';
import { createRemoteRepositories, type CacheSync, type Repositories } from './repositories';
import { createUploadQueue, type UploadQueue } from './uploadQueue';

// Everything a signed-in screen needs to read and write data, for one user. The provider is
// mounted with the user's id as its key, so signing in as someone else starts from an empty
// cache and their own drafts and upload queue.

export interface DataContextValue {
  user: AuthUser;
  /** For the read hooks in `queries.ts` only. Screens never call the API client. */
  client: ApiClient;
  repositories: Repositories;
  uploads: UploadQueue;
  drafts: DraftStore;
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

function cacheSyncFor(queryClient: QueryClient): CacheSync {
  return {
    workLogChanged(log) {
      queryClient.setQueryData(queryKeys.log(log.id), log);
      void queryClient.invalidateQueries({ queryKey: queryKeys.myLogs });
    },
    taskChanged(task) {
      queryClient.setQueryData(queryKeys.task(task.id), task);
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTasks });
    },
    attachmentsChanged(workLogId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.attachments(workLogId) });
    },
    notificationsChanged() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    },
  };
}

export function DataProvider({
  user,
  client,
  children,
}: Readonly<{ user: AuthUser; client: ApiClient; children: ReactNode }>) {
  const [queryClient] = useState(createQueryClient);

  const value = useMemo<DataContextValue>(() => {
    const repositories = createRemoteRepositories(
      client,
      cacheSyncFor(queryClient),
      putFileFromUri,
    );
    const uploads = createUploadQueue({
      store: deviceStore,
      upload: (item, onProgress) => repositories.attachments.upload(item, onProgress),
      deleteLocalFile,
    });
    return { user, client, repositories, uploads, drafts: createDraftStore(deviceStore) };
  }, [client, queryClient, user]);

  useEffect(() => {
    let active = true;
    // The retention sweep of the app start runs first, so the queue never loads (and re-saves)
    // entries the sweep is deleting. It never rejects.
    void purgeStaleLocalDataOnce({ store: deviceStore, deleteLocalFile }).then(() => {
      if (active) void value.uploads.start(user.id);
    });
    return () => {
      active = false;
      value.uploads.stop();
      queryClient.clear();
    };
  }, [value, queryClient, user.id]);

  useEffect(() => {
    // Refetch stale data when the app comes back to the foreground.
    const subscription = AppState.addEventListener('change', (status) => {
      focusManager.setFocused(status === 'active');
    });
    return () => subscription.remove();
  }, []);

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
