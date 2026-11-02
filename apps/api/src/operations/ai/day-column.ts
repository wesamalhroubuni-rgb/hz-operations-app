import { ApiException } from '../../platform/http';

/**
 * `DailySummary.day` and `AnomalyFlag.day` are `@db.Date` columns holding an org-local calendar
 * day. Prisma reads and writes them as a `Date` at UTC midnight; these helpers convert to and from
 * the `YYYY-MM-DD` key every contract uses.
 */
export function dayColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

export function dayKeyOfColumn(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (0 for the same day; negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayColumn(to).getTime() - dayColumn(from).getTime()) / 86_400_000);
}

/**
 * An inclusive day range of a list query: `to` defaults to `defaultTo`, `from` to `to`. Refused
 * (400) when `from` is after `to` or the range is longer than `maxDays`.
 */
export function inclusiveDayRange(
  query: { from?: string | undefined; to?: string | undefined },
  defaultTo: string,
  maxDays: number,
): { from: string; to: string } {
  const to = query.to ?? defaultTo;
  const from = query.from ?? to;
  if (from > to) {
    throw ApiException.validation([{ path: 'from', message: 'from must not be after to' }]);
  }
  if (daysBetween(from, to) + 1 > maxDays) {
    throw ApiException.validation([
      { path: 'to', message: `The range must not be longer than ${maxDays} days` },
    ]);
  }
  return { from, to };
}
