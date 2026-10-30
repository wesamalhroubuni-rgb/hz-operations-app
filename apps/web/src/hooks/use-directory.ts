'use client';

import type { Directory } from '@ops/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { t } from '@/i18n';
import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';
import { createDirectoryIndex, type DirectoryIndex } from '@/lib/directory';

/**
 * `GET /directory` (ADR-0009): names of the users, sites, teams and log types the caller can
 * see, cached for five minutes. Tables call `names.user(log.authorId)`; filter pickers use
 * `options.users` etc. An id the caller cannot see shows as "Unknown".
 */
export function useDirectory(): DirectoryIndex & { isLoading: boolean; error: unknown } {
  const query = useQuery<Directory>({
    queryKey: queryKeys.directory,
    queryFn: async () => unwrap(await requireApiClient().directory.get()),
    staleTime: 5 * 60_000,
  });
  const index = useMemo(() => createDirectoryIndex(query.data, t('common.unknown')), [query.data]);
  return { ...index, isLoading: query.isLoading, error: query.error };
}
