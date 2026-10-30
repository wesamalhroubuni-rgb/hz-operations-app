'use client';

import type {
  Attachment,
  BulkWorkLogStatusInput,
  BulkWorkLogStatusResult,
  ChangeWorkLogStatus,
  LogType,
  Paginated,
  RecordHistory,
  WorkLog,
  WorkLogMap,
} from '@ops/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';

/**
 * Queries and mutations of the work-log pages (agent B, ADR-0009). Reviews wait for the
 * server's answer (no optimistic update: a refusal must not surprise), then invalidate the work-log
 * lists and the overview numbers.
 */

export function useWorkLogList(query: Record<string, string | number>) {
  return useQuery<Paginated<WorkLog>>({
    queryKey: queryKeys.workLogs.list(query),
    queryFn: async () => unwrap(await requireApiClient().workLogs.list(query)),
    placeholderData: keepPreviousData,
  });
}

export function useWorkLog(id: string) {
  return useQuery<WorkLog>({
    queryKey: queryKeys.workLogs.detail(id),
    queryFn: async () => unwrap(await requireApiClient().workLogs.get(id)),
  });
}

export function useWorkLogHistory(id: string, enabled: boolean) {
  return useQuery<RecordHistory>({
    queryKey: queryKeys.workLogs.history(id),
    queryFn: async () => unwrap(await requireApiClient().workLogs.history(id)),
    enabled,
  });
}

/**
 * The log's ready photos with signed URLs. The URLs expire (`urlsExpireAt`, a few minutes), so
 * the data goes stale after one minute and the gallery refetches when an image fails to load.
 */
export function useWorkLogPhotos(id: string, enabled: boolean) {
  return useQuery<Paginated<Attachment>>({
    queryKey: queryKeys.workLogs.attachments(id),
    queryFn: async () =>
      unwrap(await requireApiClient().attachments.listForWorkLog(id, { pageSize: 100 })),
    enabled,
    staleTime: 60_000,
  });
}

/** The log type's field definitions (current version), for the custom-field labels. */
export function useLogType(id: string | null) {
  return useQuery<LogType>({
    queryKey: queryKeys.logTypes.detail(id ?? ''),
    queryFn: async () => unwrap(await requireApiClient().logTypes.get(id ?? '')),
    enabled: id !== null,
    staleTime: 5 * 60_000,
  });
}

export function useWorkLogMap(query: Record<string, string | number>) {
  return useQuery<WorkLogMap>({
    queryKey: queryKeys.workLogs.map(query),
    queryFn: async () => unwrap(await requireApiClient().workLogs.map(query)),
    placeholderData: keepPreviousData,
  });
}

function useInvalidateReviews() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.workLogs.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
    ]);
}

/** Approve or reject one log (`PATCH /work-logs/:id/status`, with its version). */
export function useReviewWorkLog(id: string) {
  const invalidate = useInvalidateReviews();
  const queryClient = useQueryClient();
  return useMutation<WorkLog, Error, ChangeWorkLogStatus>({
    mutationFn: async (body) => unwrap(await requireApiClient().workLogs.changeStatus(id, body)),
    onSuccess: async (log) => {
      queryClient.setQueryData(queryKeys.workLogs.detail(id), (old: WorkLog | undefined) => ({
        ...log,
        attachmentCount: log.attachmentCount ?? old?.attachmentCount,
      }));
      await invalidate();
    },
  });
}

/** `POST /work-logs/bulk-status`: per-item results, always 200 once the body is valid. */
export function useBulkReview() {
  const invalidate = useInvalidateReviews();
  return useMutation<BulkWorkLogStatusResult, Error, BulkWorkLogStatusInput>({
    mutationFn: async (body) => unwrap(await requireApiClient().workLogs.bulkChangeStatus(body)),
    onSettled: async () => {
      await invalidate();
    },
  });
}
