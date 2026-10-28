import {
  workLogEditWindowHoursOf,
  type ApiResult,
  type AppNotification,
  type Attachment,
  type LogType,
  type NotificationList,
  type Organization,
  type Paginated,
  type ResolvedScope,
  type Site,
  type Task,
  type Team,
  type WorkLog,
} from '@ops/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { findWorkLog, viewTasks, viewWorkLogs } from '../offline/localView';
import type { AppOfflineSession } from '../offline/session';
import type { PhotoStorageUsage, QueueItem, QueueItemState, SyncMeta } from '../offline/types';
import { useData } from './DataProvider';
import { queryKeys } from './queryKeys';
import { ReadError, toWriteError, type WriteError } from './results';

export { ReadError };

// The read side of the data layer: one hook per thing a screen shows. Since Phase 5 (ADR-0008)
// the reads come from the user's local store (what the last `GET /sync/pull` returned) with the
// queued writes applied on top (`src/offline/localView.ts`), so the app works offline and a
// change shows at once. The query cache is invalidated by the data provider whenever the store
// or the queue changes. Only the photos (signed URLs) and the scope still need the server.

async function unwrap<Data>(call: Promise<ApiResult<Data>>): Promise<Data> {
  const result = await call;
  if (!result.ok) {
    throw new ReadError(toWriteError(result.failure));
  }
  return result.data;
}

const NETWORK_ERROR: WriteError = {
  kind: 'network',
  message: 'No data on the phone yet and the server cannot be reached',
  details: [],
};

/**
 * Before the first pull the cache is empty, which is not the same as "nothing to do": ask the
 * engine for a sync and, when that cannot happen, report a network problem for an empty list.
 */
async function primed<Item>(
  session: AppOfflineSession,
  read: () => Promise<Item[]>,
): Promise<Item[]> {
  const meta = await session.store.getSyncMeta();
  if (meta.lastRefreshedAt === null) {
    await session.engine.syncNow('start').catch(() => undefined);
    const items = await read();
    if (items.length === 0 && (await session.store.getSyncMeta()).lastRefreshedAt === null) {
      throw new ReadError(NETWORK_ERROR);
    }
    return items;
  }
  return read();
}

export const LOG_PAGE_SIZE = 25;
/** How many of the worker's latest logs decide the "most used" order of log types. */
export const RECENT_LOGS_FOR_ORDERING = 50;
const NOTIFICATIONS_SHOWN = 50;

function onePage<Item>(items: Item[]): Paginated<Item> {
  return { items, page: 1, pageSize: Math.max(1, items.length), total: items.length };
}

function byName<Item extends { name: string }>(items: Item[]): Item[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name));
}

function time(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

async function myLogsView(session: AppOfflineSession, userId: string, organizationId: string) {
  const logs = viewWorkLogs(await session.store.list('workLogs'), await session.queue.list(), {
    id: userId,
    organizationId,
  });
  return logs.filter((log) => log.authorId === userId && log.archivedAt === null);
}

/** Every task assigned to me, open and closed; the screens filter locally. */
export function useMyTasks() {
  const { offline, user } = useData();
  return useQuery({
    queryKey: queryKeys.myTasks,
    queryFn: () =>
      primed(offline, async () =>
        viewTasks(await offline.store.list('tasks'), await offline.queue.list())
          .filter((task) => task.assigneeIds.includes(user.id) && task.archivedAt === null)
          .sort((a, b) => time(a.dueAt) - time(b.dueAt)),
      ),
  });
}

/** One task: from the phone, else (not cached) from the server. */
export function useTask(taskId: string | undefined) {
  const { offline, client } = useData();
  return useQuery<Task>({
    queryKey: queryKeys.task(taskId ?? ''),
    queryFn: async () => {
      const id = taskId ?? '';
      const cached = await offline.store.get('tasks', id);
      if (cached) {
        const [view] = viewTasks([cached], await offline.queue.list());
        if (view) return view;
      }
      return unwrap(client.tasks.get(id));
    },
    enabled: taskId !== undefined,
  });
}

/** My logs, newest first (those on the phone: the last 30 days and everything not sent yet). */
export function useMyLogs() {
  const { offline, user } = useData();
  return useInfiniteQuery({
    queryKey: queryKeys.myLogs,
    initialPageParam: 1,
    queryFn: async () =>
      onePage(
        (await primed(offline, () => myLogsView(offline, user.id, user.organizationId))).sort(
          (a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt),
        ),
      ),
    getNextPageParam: () => undefined,
  });
}

/** My latest logs by creation, for the "most used first" order of log types. */
export function useRecentLogTypeUse() {
  const { offline, user } = useData();
  return useQuery({
    queryKey: queryKeys.recentLogTypeUse,
    queryFn: async () =>
      (await myLogsView(offline, user.id, user.organizationId))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, RECENT_LOGS_FOR_ORDERING),
  });
}

/** One log by server id or clientId: from the phone, else from the server. */
export function useWorkLog(logId: string | undefined) {
  const { offline, client, user } = useData();
  return useQuery<WorkLog>({
    queryKey: queryKeys.log(logId ?? ''),
    queryFn: async () => {
      const id = logId ?? '';
      const view = viewWorkLogs(await offline.store.list('workLogs'), await offline.queue.list(), {
        id: user.id,
        organizationId: user.organizationId,
      });
      return findWorkLog(view, id) ?? unwrap(client.workLogs.get(id));
    },
    enabled: logId !== undefined,
  });
}

/**
 * The photos of a log that reached the server (signed URLs: online only). A log not sent yet
 * has none; its photos are in the upload queue. The signed URLs expire (`urlsExpireAt`), so the
 * list is refetched a little before that.
 */
export function useAttachments(logId: string | undefined) {
  const { offline, client } = useData();
  return useQuery<Attachment[]>({
    queryKey: queryKeys.attachments(logId ?? ''),
    queryFn: async () => {
      const id = logId ?? '';
      const cached = await offline.store.list('workLogs');
      const server =
        cached.find((log) => log.id === id) ?? cached.find((log) => log.clientId === id);
      if (!server) {
        const queuedCreate = (await offline.queue.list()).some(
          (item) => item.mutation.kind === 'createWorkLog' && item.mutation.body.clientId === id,
        );
        if (queuedCreate) return [];
      }
      return unwrap(client.attachments.listForWorkLog(server?.id ?? id, { pageSize: 100 })).then(
        (page) => page.items,
      );
    },
    enabled: logId !== undefined,
    staleTime: 60 * 1000,
    refetchInterval: (query) => {
      const items = query.state.data;
      if (!items) return false;
      const expiries = items
        .map((item) => (item.urlsExpireAt ? Date.parse(item.urlsExpireAt) : Number.NaN))
        .filter((value) => Number.isFinite(value));
      if (expiries.length === 0) return false;
      return Math.max(30_000, Math.min(...expiries) - Date.now() - 30_000);
    },
  });
}

export function useLogTypes() {
  const { offline } = useData();
  return useQuery<LogType[]>({
    queryKey: queryKeys.logTypes,
    queryFn: () => primed(offline, async () => byName(await offline.store.list('logTypes'))),
  });
}

export function useSites() {
  const { offline } = useData();
  return useQuery<Site[]>({
    queryKey: queryKeys.sites,
    queryFn: async () => byName(await offline.store.list('sites')),
  });
}

export function useTeams() {
  const { offline } = useData();
  return useQuery<Team[]>({
    queryKey: queryKeys.teams,
    queryFn: async () => byName(await offline.store.list('teams')),
  });
}

const SCOPE_KEY = 'scope';

/** My memberships: from the server, else the last copy kept on the phone. */
export function useMyScope() {
  const { offline, client } = useData();
  return useQuery<ResolvedScope>({
    queryKey: queryKeys.scope,
    queryFn: async () => {
      const result = await client.scope.me();
      if (result.ok) {
        await offline.store.setValue(SCOPE_KEY, result.data).catch(() => undefined);
        return result.data;
      }
      const kept = await offline.store.getValue<ResolvedScope>(SCOPE_KEY);
      if (kept) return kept;
      throw new ReadError(toWriteError(result.failure));
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** The organization summary of the last pull, else from the server. */
export function useOrganization() {
  const { offline, client } = useData();
  return useQuery<Organization>({
    queryKey: queryKeys.organization,
    queryFn: async () =>
      (await offline.store.getSyncMeta()).organization ?? unwrap(client.organization.get()),
  });
}

/** The organization's edit window in hours (the default until the organization has loaded). */
export function useEditWindowHours(): number {
  const organization = useOrganization();
  return organization.data?.workLogEditWindowHours ?? workLogEditWindowHoursOf(undefined);
}

export function useNotifications() {
  const { offline } = useData();
  return useQuery<NotificationList>({
    queryKey: queryKeys.notifications,
    queryFn: async () => {
      const all: AppNotification[] = (await offline.store.list('notifications')).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
      const items = all.slice(0, NOTIFICATIONS_SHOWN);
      return {
        ...onePage(items),
        total: all.length,
        unreadCount: all.filter((item) => item.readAt === null).length,
      };
    },
  });
}

/** The error of a failed read as the screen explains it. */
export function readErrorKind(error: unknown): WriteError['kind'] {
  return error instanceof ReadError ? error.error.kind : 'server';
}

// ---------------------------------------------------------------------------------------------
// Offline state for the sync UI
// ---------------------------------------------------------------------------------------------

/** Every queued write, in send order, live (the sync list). */
export function useQueueItems() {
  const { offline } = useData();
  return useQuery<QueueItem[]>({
    queryKey: queryKeys.queue,
    queryFn: () => offline.queue.list(),
  });
}

/** Queued writes by state, live. */
export function useQueueCounts() {
  const { offline } = useData();
  return useQuery<Record<QueueItemState, number>>({
    queryKey: queryKeys.queueCounts,
    queryFn: () => offline.queue.counts(),
  });
}

/** "Last refreshed" and the rest of the sync meta, live. */
export function useSyncMeta() {
  const { offline } = useData();
  return useQuery<SyncMeta>({
    queryKey: queryKeys.syncMeta,
    queryFn: () => offline.store.getSyncMeta(),
  });
}

/** How full the offline photo storage is (warning at 80 %, refused at the limit). */
export function usePhotoStorageUsage() {
  const { offline } = useData();
  return useQuery<PhotoStorageUsage>({
    queryKey: queryKeys.photoStorage,
    queryFn: () => offline.photos.usage(),
  });
}

/** Upload progress of a queued photo item (0..1), live; null when not uploading. */
export function useUploadProgress(itemId: string): number | null {
  const { offline } = useData();
  return useSyncExternalStore(offline.queue.subscribeProgress, () =>
    offline.queue.progressOf(itemId),
  );
}
