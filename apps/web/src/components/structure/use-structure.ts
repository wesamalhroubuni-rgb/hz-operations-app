'use client';

import type { LogType, Site, Team } from '@ops/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import { fetchAllPages } from '@/lib/structure';

type All<Item> = { items: Item[]; total: number; complete: boolean };

/** Every site the caller can see (all pages), archived ones when asked. */
export function useAllSites(includeArchived: boolean) {
  const query = { includeArchived: String(includeArchived), all: 'true' };
  return useQuery<All<Site>>({
    queryKey: queryKeys.sites.list(query),
    queryFn: () =>
      fetchAllPages(async (page, pageSize) =>
        unwrap(await requireApiClient().sites.list({ page, pageSize, includeArchived })),
      ),
  });
}

export function useAllTeams(includeArchived: boolean) {
  const query = { includeArchived: String(includeArchived), all: 'true' };
  return useQuery<All<Team>>({
    queryKey: queryKeys.teams.list(query),
    queryFn: () =>
      fetchAllPages(async (page, pageSize) =>
        unwrap(await requireApiClient().teams.list({ page, pageSize, includeArchived })),
      ),
  });
}

export function useAllLogTypes(includeArchived: boolean) {
  const query = { includeArchived: String(includeArchived), all: 'true' };
  return useQuery<All<LogType>>({
    queryKey: queryKeys.logTypes.list(query),
    queryFn: () =>
      fetchAllPages(async (page, pageSize) =>
        unwrap(await requireApiClient().logTypes.list({ page, pageSize, includeArchived })),
      ),
  });
}

/** After a structure write: refresh that resource and the directory (names in every picker). */
export function useStructureChanged() {
  const queryClient = useQueryClient();
  return useCallback(
    async (resource: 'sites' | 'teams' | 'logTypes') => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys[resource].all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.directory }),
      ]);
    },
    [queryClient],
  );
}
