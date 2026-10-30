import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@ops/shared';

/**
 * List state in the URL (ADR-0009): filters, sort and page of every table are query parameters
 * of the page, named exactly like the API's list query (`listWorkLogsQuerySchema`,
 * `listTasksQuerySchema`, ...). A filtered view is therefore a shareable link, the back button
 * restores it, the overview's `filter` objects open it unchanged, and the same parameters feed
 * the API call and the CSV export.
 *
 * Pure functions over `URLSearchParams`; `useListParams` (src/hooks) connects them to the router.
 */

export const PAGE_PARAM = 'page';
export const PAGE_SIZE_PARAM = 'pageSize';
export const SORT_PARAM = 'sort';
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

export interface SortState {
  field: string;
  direction: 'asc' | 'desc';
}

export interface ListState {
  page: number;
  pageSize: number;
  /** Null: the API's default sort. */
  sort: SortState | null;
  /** Every other parameter, as given (only non-empty values). */
  filters: Record<string, string>;
}

function positiveInt(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER) {
  const parsed = value === null ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : fallback;
}

export function parseSort(value: string | null | undefined): SortState | null {
  if (!value) {
    return null;
  }
  const [field, direction = 'asc'] = value.split(':');
  if (!field || (direction !== 'asc' && direction !== 'desc')) {
    return null;
  }
  return { field, direction };
}

export function formatSort(sort: SortState | null): string | null {
  return sort === null ? null : `${sort.field}:${sort.direction}`;
}

/**
 * Reads the list state. `filterKeys`: the parameters this list understands (for example
 * `WORK_LOG_FILTER_KEYS`); others are ignored so a stray parameter never reaches the API.
 */
export function readListState(
  params: URLSearchParams,
  filterKeys: readonly string[],
  defaultPageSize = DEFAULT_PAGE_SIZE,
): ListState {
  const filters: Record<string, string> = {};
  for (const key of filterKeys) {
    const value = params.get(key);
    if (value !== null && value.trim() !== '') {
      filters[key] = value;
    }
  }
  return {
    page: positiveInt(params.get(PAGE_PARAM), 1),
    pageSize: positiveInt(params.get(PAGE_SIZE_PARAM), defaultPageSize, MAX_PAGE_SIZE),
    sort: parseSort(params.get(SORT_PARAM)),
    filters,
  };
}

export interface ListStateChange {
  page?: number;
  pageSize?: number;
  sort?: SortState | null;
  /** `null` or `''` removes a filter. */
  filters?: Record<string, string | null | undefined>;
}

/**
 * The query string after a change. Changing filters, sort or page size goes back to page 1, so
 * the user never lands on an empty page past the end. Parameters this list does not know are
 * kept as they are (another component of the page may own them).
 */
export function applyListChange(current: URLSearchParams, change: ListStateChange): string {
  const next = new URLSearchParams(current);
  let resetPage = false;
  for (const [key, value] of Object.entries(change.filters ?? {})) {
    if (value === null || value === undefined || value === '') {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    resetPage = true;
  }
  if (change.sort !== undefined) {
    const sort = formatSort(change.sort);
    if (sort === null) {
      next.delete(SORT_PARAM);
    } else {
      next.set(SORT_PARAM, sort);
    }
    resetPage = true;
  }
  if (change.pageSize !== undefined) {
    next.set(PAGE_SIZE_PARAM, String(change.pageSize));
    resetPage = true;
  }
  if (change.page !== undefined) {
    next.set(PAGE_PARAM, String(change.page));
  } else if (resetPage) {
    next.delete(PAGE_PARAM);
  }
  if (next.get(PAGE_PARAM) === '1') {
    next.delete(PAGE_PARAM);
  }
  return next.toString();
}

/** The API query of a list state: filters plus page, page size and sort. */
export function toApiQuery(state: ListState): Record<string, string | number> {
  const query: Record<string, string | number> = {
    ...state.filters,
    page: state.page,
    pageSize: state.pageSize,
  };
  const sort = formatSort(state.sort);
  if (sort !== null) {
    query.sort = sort;
  }
  return query;
}

/** A page link with filters (the overview's `filter` objects): `/work-logs?status=submitted`. */
export function hrefWithFilter(path: string, filter: Record<string, string>): string {
  const search = new URLSearchParams(filter).toString();
  return search === '' ? path : `${path}?${search}`;
}

/** The number of active filters, for the "2 filters" badge. */
export function activeFilterCount(state: ListState, ignore: readonly string[] = []): number {
  return Object.keys(state.filters).filter((key) => !ignore.includes(key)).length;
}
