'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';

import {
  applyListChange,
  readListState,
  toApiQuery,
  type ListState,
  type ListStateChange,
} from '@/lib/list-params';

export interface ListParams {
  state: ListState;
  /** Filters, page, page size and sort, ready for the API call (and the query key). */
  apiQuery: Record<string, string | number>;
  /** Changes the URL (replace, so typing in a search box does not fill the history). */
  change(change: ListStateChange): void;
  /** Removes every filter of this list. */
  clearFilters(): void;
}

/**
 * The list state of a table, kept in the page URL (ADR-0009). `filterKeys`: the API filter
 * names the page offers (e.g. `WORK_LOG_FILTER_KEYS`). Page components using it must render
 * inside a `<Suspense>` boundary (the app shell provides one).
 */
export function useListParams(filterKeys: readonly string[], defaultPageSize?: number): ListParams {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const search = searchParams.toString();
  // A string, so an inline array literal does not change the dependencies on every render.
  const keyList = filterKeys.join(',');

  const state = useMemo(
    () => readListState(new URLSearchParams(search), keyList.split(','), defaultPageSize),
    [search, keyList, defaultPageSize],
  );
  const apiQuery = useMemo(() => toApiQuery(state), [state]);

  const change = useCallback(
    (next: ListStateChange) => {
      const query = applyListChange(new URLSearchParams(search), next);
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
    },
    [router, pathname, search],
  );

  const clearFilters = useCallback(() => {
    change({ filters: Object.fromEntries(keyList.split(',').map((key) => [key, null])) });
  }, [change, keyList]);

  return { state, apiQuery, change, clearFilters };
}
