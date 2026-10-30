'use client';

import type { Paginated, RecordHistory, Task } from '@ops/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';

/** `GET /tasks` with the URL's list query (filters, page, sort). */
export function useTaskList(query: Record<string, string | number>, enabled = true) {
  return useQuery<Paginated<Task>>({
    queryKey: queryKeys.tasks.list(query),
    queryFn: async () => unwrap(await requireApiClient().tasks.list(query)),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/** `GET /tasks/:id`. */
export function useTask(id: string) {
  return useQuery<Task>({
    queryKey: queryKeys.tasks.detail(id),
    queryFn: async () => unwrap(await requireApiClient().tasks.get(id)),
  });
}

/** `GET /tasks/:id/history` (Phase 6): the task's audit trail, oldest first, role-shaped. */
export function useTaskHistory(id: string) {
  return useQuery<RecordHistory>({
    queryKey: queryKeys.tasks.history(id),
    queryFn: async () => unwrap(await requireApiClient().tasks.history(id)),
  });
}

/**
 * After any task write: put the server's answer in the detail cache and refresh the lists,
 * the history and the overview numbers (they count tasks).
 */
export function useTaskSaved() {
  const queryClient = useQueryClient();
  return useCallback(
    async (task: Task | null) => {
      if (task) {
        queryClient.setQueryData(queryKeys.tasks.detail(task.id), task);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
      ]);
    },
    [queryClient],
  );
}
