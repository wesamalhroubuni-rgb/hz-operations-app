import {
  workLogEditWindowHoursOf,
  type ApiClient,
  type ApiResult,
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

import { useData } from './DataProvider';
import { queryKeys } from './queryKeys';
import { ReadError, toWriteError, type WriteError } from './results';

export { ReadError };

// The read side of the data layer: one hook per thing a screen shows, over the query cache.
// Screens use these hooks and never the API client. Phase 5 can point the query functions at a
// local store without touching the screens.

async function unwrap<Data>(call: Promise<ApiResult<Data>>): Promise<Data> {
  const result = await call;
  if (!result.ok) {
    throw new ReadError(toWriteError(result.failure));
  }
  return result.data;
}

/** Collects every page of a list endpoint (reference lists are small: sites, teams, types). */
async function allPages<Item>(
  load: (page: number) => Promise<ApiResult<Paginated<Item>>>,
  maxPages = 10,
): Promise<Item[]> {
  const items: Item[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await unwrap(load(page));
    items.push(...data.items);
    if (items.length >= data.total || data.items.length === 0) break;
  }
  return items;
}

const REFERENCE_STALE_MS = 10 * 60 * 1000;
export const LOG_PAGE_SIZE = 25;
/** How many of the worker's latest logs decide the "most used" order of log types. */
export const RECENT_LOGS_FOR_ORDERING = 50;

function useClient(): ApiClient {
  return useData().client;
}

/** Every task assigned to me (up to 100), open and closed; the screens filter locally. */
export function useMyTasks() {
  const client = useClient();
  const { user } = useData();
  return useQuery({
    queryKey: queryKeys.myTasks,
    queryFn: () =>
      unwrap(client.tasks.list({ assigneeId: user.id, pageSize: 100, sort: 'dueAt:asc' })).then(
        (page) => page.items,
      ),
  });
}

export function useTask(taskId: string | undefined) {
  const client = useClient();
  return useQuery<Task>({
    queryKey: queryKeys.task(taskId ?? ''),
    queryFn: () => unwrap(client.tasks.get(taskId ?? '')),
    enabled: taskId !== undefined,
  });
}

/** My logs, newest first, page by page. */
export function useMyLogs() {
  const client = useClient();
  const { user } = useData();
  return useInfiniteQuery({
    queryKey: queryKeys.myLogs,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      unwrap(
        client.workLogs.list({
          authorId: user.id,
          sort: 'occurredAt:desc',
          page: pageParam,
          pageSize: LOG_PAGE_SIZE,
        }),
      ),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
  });
}

/** My latest logs by creation, for the "most used first" order of log types. */
export function useRecentLogTypeUse() {
  const client = useClient();
  const { user } = useData();
  return useQuery({
    queryKey: queryKeys.recentLogTypeUse,
    queryFn: () =>
      unwrap(
        client.workLogs.list({
          authorId: user.id,
          sort: 'createdAt:desc',
          pageSize: RECENT_LOGS_FOR_ORDERING,
        }),
      ).then((page) => page.items),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useWorkLog(logId: string | undefined) {
  const client = useClient();
  return useQuery<WorkLog>({
    queryKey: queryKeys.log(logId ?? ''),
    queryFn: () => unwrap(client.workLogs.get(logId ?? '')),
    enabled: logId !== undefined,
  });
}

/**
 * The photos of a log. Their signed URLs expire (`urlsExpireAt`), so the list is refetched a
 * little before that.
 */
export function useAttachments(logId: string | undefined) {
  const client = useClient();
  return useQuery<Attachment[]>({
    queryKey: queryKeys.attachments(logId ?? ''),
    queryFn: () =>
      unwrap(client.attachments.listForWorkLog(logId ?? '', { pageSize: 100 })).then(
        (page) => page.items,
      ),
    enabled: logId !== undefined,
    staleTime: 60 * 1000,
    refetchInterval: (query) => {
      const items = query.state.data;
      if (!items) return false;
      const expiries = items
        .map((item) => (item.urlsExpireAt ? Date.parse(item.urlsExpireAt) : Number.NaN))
        .filter((time) => Number.isFinite(time));
      if (expiries.length === 0) return false;
      return Math.max(30_000, Math.min(...expiries) - Date.now() - 30_000);
    },
  });
}

export function useLogTypes() {
  const client = useClient();
  return useQuery<LogType[]>({
    queryKey: queryKeys.logTypes,
    queryFn: () => allPages((page) => client.logTypes.list({ page, pageSize: 100 })),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useSites() {
  const client = useClient();
  return useQuery<Site[]>({
    queryKey: queryKeys.sites,
    queryFn: () => allPages((page) => client.sites.list({ page, pageSize: 100 })),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useTeams() {
  const client = useClient();
  return useQuery<Team[]>({
    queryKey: queryKeys.teams,
    queryFn: () => allPages((page) => client.teams.list({ page, pageSize: 100 })),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useMyScope() {
  const client = useClient();
  return useQuery<ResolvedScope>({
    queryKey: queryKeys.scope,
    queryFn: () => unwrap(client.scope.me()),
    staleTime: REFERENCE_STALE_MS,
  });
}

export function useOrganization() {
  const client = useClient();
  return useQuery<Organization>({
    queryKey: queryKeys.organization,
    queryFn: () => unwrap(client.organization.get()),
    staleTime: REFERENCE_STALE_MS,
  });
}

/** The organization's edit window in hours (the default until the organization has loaded). */
export function useEditWindowHours(): number {
  const organization = useOrganization();
  return organization.data?.workLogEditWindowHours ?? workLogEditWindowHoursOf(undefined);
}

export function useNotifications() {
  const client = useClient();
  return useQuery<NotificationList>({
    queryKey: queryKeys.notifications,
    queryFn: () => unwrap(client.notifications.list({ pageSize: 50 })),
    // The badge should notice new notifications without push (Expo Go): poll gently while the
    // app is in the foreground.
    refetchInterval: 60 * 1000,
  });
}

/** The error of a failed read as the screen explains it. */
export function readErrorKind(error: unknown): WriteError['kind'] {
  return error instanceof ReadError ? error.error.kind : 'server';
}
