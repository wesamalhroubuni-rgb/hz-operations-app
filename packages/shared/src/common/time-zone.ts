import { z } from 'zod';

// Times in the organization's time zone (ADR-0009). The API stores and sends UTC instants; the
// dashboard and the reports show them in `Organization.settings.timeZone`, and a "day" (today's
// logs, a report range, a date filter) is a calendar day in that zone. Pure functions over
// `Intl.DateTimeFormat`, usable in Node, browsers and React Native.

/** The organization's time zone when it has not set one. */
export const DEFAULT_TIME_ZONE = 'Europe/Istanbul';

/** True for a time zone name `Intl` understands, such as `Europe/Istanbul` or `UTC`. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** An IANA time zone name (validated with `Intl`). */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(isValidTimeZone, { error: 'must be an IANA time zone such as Europe/Istanbul' });

/** The time zone stored in an organization's settings, or the default when absent or unusable. */
export function timeZoneOf(settings: unknown): string {
  const value =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).timeZone
      : undefined;
  return isValidTimeZone(value) ? value : DEFAULT_TIME_ZONE;
}

function isRealDay(key: string): boolean {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** A calendar day, `YYYY-MM-DD`, in some time zone. */
export const dayKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'must be a day as YYYY-MM-DD' })
  .refine(isRealDay, { error: 'must be a real calendar day' });
/** A calendar day, `YYYY-MM-DD`. */
export type DayKey = string;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function toDate(value: string | number | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** The wall-clock date and time of an instant in a time zone. */
export function zonedParts(value: string | number | Date, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of partsFormatter(timeZone).formatToParts(toDate(value))) {
    if (part.type !== 'literal') {
      parts[part.type] = Number(part.value);
    }
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    // Some engines write midnight as 24 even with h23.
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
export function timeZoneOffsetMs(value: string | number | Date, timeZone: string): number {
  const date = toDate(value);
  const p = zonedParts(date, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - (date.getTime() - date.getUTCMilliseconds());
}

/**
 * The instant at which the zone's wall clock shows the given time. For a wall time skipped by a
 * daylight-saving change, an instant just after the gap; for a repeated one, the first.
 */
export function zonedTimeToInstant(parts: ZonedParts, timeZone: string): Date {
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const before = timeZoneOffsetMs(wall - 24 * 60 * 60 * 1000, timeZone);
  const after = timeZoneOffsetMs(wall + 24 * 60 * 60 * 1000, timeZone);
  // Try the earlier offset first (the first of a repeated hour), then the later one.
  for (const offset of before >= after ? [before, after] : [after, before]) {
    const candidate = wall - offset;
    if (timeZoneOffsetMs(candidate, timeZone) === offset) {
      return new Date(candidate);
    }
  }
  // A skipped wall time: none matches. Use the offset before the change.
  return new Date(wall - before);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/** The calendar day of an instant in a time zone, `YYYY-MM-DD`. */
export function zonedDayKey(value: string | number | Date, timeZone: string): DayKey {
  const p = zonedParts(value, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** The day `days` after (or before, when negative) a day. */
export function addDays(day: DayKey, days: number): DayKey {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, date + days));
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The instant a day starts (local midnight) in a time zone. */
export function zonedDayStart(day: DayKey, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return zonedTimeToInstant({ year, month, day: date, hour: 0, minute: 0, second: 0 }, timeZone);
}

export interface InstantRange {
  /** Inclusive lower bound, ISO 8601 UTC. */
  from: string;
  /** Exclusive upper bound, ISO 8601 UTC. */
  to: string;
}

/**
 * The instants covering the days `firstDay` to `lastDay`, both included, in a time zone: the
 * inclusive-lower, exclusive-upper range every API date filter takes (`occurredFrom` /
 * `occurredTo`). One day: pass the same day twice.
 */
export function zonedDaysRange(firstDay: DayKey, lastDay: DayKey, timeZone: string): InstantRange {
  return {
    from: zonedDayStart(firstDay, timeZone).toISOString(),
    to: zonedDayStart(addDays(lastDay, 1), timeZone).toISOString(),
  };
}

/** How a time is written. Every preset uses the locale's own order and separators. */
export type DateTimeStyle = 'dateTime' | 'dateTimeSeconds' | 'date' | 'weekdayDate' | 'time';

const STYLE_OPTIONS: Record<DateTimeStyle, Intl.DateTimeFormatOptions> = {
  dateTime: { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  dateTimeSeconds: {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  },
  date: { year: 'numeric', month: 'short', day: 'numeric' },
  weekdayDate: { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' },
  time: { hour: '2-digit', minute: '2-digit' },
};

export interface FormatInTimeZoneOptions {
  timeZone: string;
  /** BCP 47 tag; defaults to `en`. */
  locale?: string;
  style?: DateTimeStyle;
}

/**
 * An instant written in a time zone, e.g. "28 Oct 2026, 14:05". Never throws: an unknown locale
 * falls back to English; a missing or unusable instant gives an empty string.
 */
export function formatInTimeZone(
  value: string | number | Date | null | undefined,
  { timeZone, locale = 'en', style = 'dateTime' }: FormatInTimeZoneOptions,
): string {
  if (value === null || value === undefined) {
    return '';
  }
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const options = { ...STYLE_OPTIONS[style], timeZone };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    try {
      return new Intl.DateTimeFormat('en', options).format(date);
    } catch {
      return date.toISOString();
    }
  }
}

/**
 * A calendar day written in the locale ("Wed, 28 Oct 2026"). The day is taken as it is, so it
 * never shifts by one whatever the viewer's zone.
 */
export function formatDayKey(
  day: DayKey,
  locale = 'en',
  style: 'date' | 'weekdayDate' = 'date',
): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return formatInTimeZone(new Date(Date.UTC(year, month - 1, date, 12)), {
    timeZone: 'UTC',
    locale,
    style,
  });
}

/**
 * An instant as `YYYY-MM-DD HH:mm` wall-clock time in a time zone: the fixed, sortable form used
 * in CSV exports and printable reports.
 */
export function formatSortableInTimeZone(
  value: string | number | Date | null | undefined,
  timeZone: string,
): string {
  if (value === null || value === undefined) {
    return '';
  }
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const p = zonedParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}
