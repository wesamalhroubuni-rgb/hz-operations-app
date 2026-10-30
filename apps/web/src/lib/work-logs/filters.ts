import {
  WORK_LOG_FILTER_KEYS,
  WORK_LOG_MAP_DEFAULT_LIMIT,
  WORK_LOG_SORT_FIELDS,
  type DayKey,
} from '@ops/shared';

import { formatSort, hrefWithFilter, type ListState } from '@/lib/list-params';
import { daysOfRange, type OrgTime } from '@/lib/time';

/**
 * The work-log list's URL state (ADR-0009): the parameter names are the API's
 * (`workLogFilterShape`), so the list, the map, the CSV export, the report link and the
 * overview's `filter` objects all speak the same language. Pure, so tested.
 */
export const WORK_LOG_LIST_FILTER_KEYS: readonly string[] = WORK_LOG_FILTER_KEYS;
export const WORK_LOG_SORTABLE: readonly string[] = WORK_LOG_SORT_FIELDS;

export const WORK_LOGS_PATH = '/work-logs';
export const WORK_LOG_REPORT_PATH = '/work-logs/report';
export const MAP_PATH = '/map';

export function workLogHref(id: string): string {
  return `${WORK_LOGS_PATH}/${encodeURIComponent(id)}`;
}

/** The days a date picker shows for the URL's `occurredFrom` / `occurredTo`. */
export function dayRangeOf(
  filters: Readonly<Record<string, string>>,
  timeZone: string,
): { from: DayKey | null; to: DayKey | null } {
  return daysOfRange({ from: filters.occurredFrom, to: filters.occurredTo }, timeZone);
}

/**
 * The URL filters of a day range picked in the ORGANIZATION's time zone: `occurredFrom` is the
 * start of the first day (inclusive), `occurredTo` the start of the day after the last one
 * (exclusive). A missing side clears that bound. Null for an inverted range (the picker shows the
 * error; nothing is applied).
 */
export function dayRangeFilters(
  range: { from: DayKey | null; to: DayKey | null },
  orgTime: Pick<OrgTime, 'range'>,
): { occurredFrom: string | null; occurredTo: string | null } | null {
  if (range.from !== null && range.to !== null && range.to < range.from) {
    return null;
  }
  return {
    occurredFrom: range.from === null ? null : orgTime.range(range.from, range.from).from,
    occurredTo: range.to === null ? null : orgTime.range(range.to, range.to).to,
  };
}

/** The CSV export's query for the current list: the same filters and sort, no page. */
export function exportQueryOf(state: Pick<ListState, 'filters' | 'sort'>): Record<string, string> {
  const query: Record<string, string> = { ...state.filters };
  const sort = formatSort(state.sort);
  if (sort !== null) {
    query.sort = sort;
  }
  return query;
}

/** The map's query: the list filters (no page or sort) and the point cap. */
export function mapQueryOf(
  filters: Readonly<Record<string, string>>,
  limit = WORK_LOG_MAP_DEFAULT_LIMIT,
): Record<string, string | number> {
  return { ...filters, limit };
}

/** Filters the report understands (`workLogReportQuerySchema`), besides the range. */
export const REPORT_FILTER_KEYS = ['siteId', 'teamId', 'authorId', 'logTypeId', 'status'] as const;

/** Link to the printable report for the list's filters (unsupported ones are dropped). */
export function reportHrefOf(filters: Readonly<Record<string, string>>): string {
  const kept: Record<string, string> = {};
  for (const key of ['occurredFrom', 'occurredTo', ...REPORT_FILTER_KEYS]) {
    const value = filters[key];
    if (value) {
      kept[key] = value;
    }
  }
  return hrefWithFilter(WORK_LOG_REPORT_PATH, kept);
}

/** Link to the map with the list's filters (page, size and sort are not map parameters). */
export function mapHrefOf(filters: Readonly<Record<string, string>>): string {
  return hrefWithFilter(MAP_PATH, { ...filters });
}
