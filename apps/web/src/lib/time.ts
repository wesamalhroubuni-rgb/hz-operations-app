import {
  addDays,
  DEFAULT_TIME_ZONE,
  formatDayKey,
  formatInTimeZone,
  formatSortableInTimeZone,
  zonedDayKey,
  zonedDaysRange,
  type DateTimeStyle,
  type DayKey,
  type InstantRange,
} from '@ops/shared';

import { LOCALE_TAG } from '@/i18n';

/**
 * Times in the ORGANIZATION's time zone (ADR-0009), never the browser's: a manager in another
 * country sees the same "14:05" and the same "today" as the site. `useOrgTime()`
 * (src/hooks/use-org-time.ts) builds one from `GET /organization` (`timeZone`). Pure, so tested.
 */
export interface OrgTime {
  timeZone: string;
  /** "28 Oct 2026, 14:05" (or another style). Empty for null. */
  format(value: string | Date | null | undefined, style?: DateTimeStyle): string;
  dateTime(value: string | Date | null | undefined): string;
  date(value: string | Date | null | undefined): string;
  time(value: string | Date | null | undefined): string;
  /** "2026-10-28 14:05". */
  sortable(value: string | Date | null | undefined): string;
  /** A day key written out ("28 Oct 2026"). */
  day(day: DayKey): string;
  /** Today in the organization's zone. */
  today(now?: Date): DayKey;
  /** The calendar day of an instant in the organization's zone. */
  dayOf(value: string | Date): DayKey;
  /** The API range (`occurredFrom` inclusive, `occurredTo` exclusive) of whole local days. */
  range(firstDay: DayKey, lastDay: DayKey): InstantRange;
}

export function createOrgTime(
  timeZone: string = DEFAULT_TIME_ZONE,
  locale: string = LOCALE_TAG,
): OrgTime {
  const format = (value: string | Date | null | undefined, style: DateTimeStyle = 'dateTime') =>
    formatInTimeZone(value, { timeZone, locale, style });
  return {
    timeZone,
    format,
    dateTime: (value) => format(value, 'dateTime'),
    date: (value) => format(value, 'date'),
    time: (value) => format(value, 'time'),
    sortable: (value) => formatSortableInTimeZone(value, timeZone),
    day: (day) => formatDayKey(day, locale),
    today: (now = new Date()) => zonedDayKey(now, timeZone),
    dayOf: (value) => zonedDayKey(value, timeZone),
    range: (firstDay, lastDay) => zonedDaysRange(firstDay, lastDay, timeZone),
  };
}

export type DatePreset = 'today' | 'yesterday' | 'last7Days' | 'last30Days' | 'thisMonth';

/** The first and last day (both included) of a preset, in the organization's zone. */
export function presetDays(preset: DatePreset, today: DayKey): { from: DayKey; to: DayKey } {
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case 'last7Days':
      return { from: addDays(today, -6), to: today };
    case 'last30Days':
      return { from: addDays(today, -29), to: today };
    case 'thisMonth':
      return { from: `${today.slice(0, 8)}01`, to: today };
  }
}

/**
 * The days a range of API instants covers, for showing the URL's `occurredFrom` / `occurredTo`
 * back in a date picker: the day of `from`, and the day before `to` (it is exclusive).
 */
export function daysOfRange(
  range: { from?: string | null; to?: string | null },
  timeZone: string,
): { from: DayKey | null; to: DayKey | null } {
  const valid = (value?: string | null) =>
    value && !Number.isNaN(Date.parse(value)) ? value : null;
  const from = valid(range.from);
  const to = valid(range.to);
  return {
    from: from ? zonedDayKey(from, timeZone) : null,
    to: to ? zonedDayKey(new Date(Date.parse(to) - 1), timeZone) : null,
  };
}

export type OrgTimeGate = 'ready' | 'loading' | 'error';

/**
 * Whether pages may show times and offer date presets yet. Until `GET /organization` has given
 * the organization's time zone, `createOrgTime()` would fall back to Europe/Istanbul, so a
 * page could show wrong times or a preset could write a range in the wrong zone. The app shell
 * therefore renders pages only when this is `ready`, a loading state while the organization
 * loads, and an error state (with retry) when it failed and nothing is cached. A cached
 * organization stays usable during a failed background refresh.
 */
export function orgTimeGate(query: { data: unknown; isError: boolean }): OrgTimeGate {
  if (query.data !== undefined && query.data !== null) {
    return 'ready';
  }
  return query.isError ? 'error' : 'loading';
}
