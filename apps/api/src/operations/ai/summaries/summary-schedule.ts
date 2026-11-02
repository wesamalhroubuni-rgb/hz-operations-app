import { zonedDayKey, zonedParts } from '@ops/shared';

/**
 * The org-local day whose summaries are due at `now`, or null (Phase 7, ADR-0011 section 1):
 * the day of `now` in the organization's time zone, once its wall clock has reached
 * `summaryTime` (`HH:MM`). Only that day: a run missed earlier in the same local day is caught up
 * at the next wake-up, and past days are never generated automatically.
 *
 * Wall-clock comparison keeps daylight-saving changes simple: a summary time inside a skipped
 * hour becomes due at the first wall time after the gap; one inside a repeated hour is due the
 * first time it is reached (later wake-ups find the summaries already written).
 */
export function dueSummaryDay(now: Date, timeZone: string, summaryTime: string): string | null {
  const [hour = 0, minute = 0] = summaryTime.split(':').map(Number);
  const local = zonedParts(now, timeZone);
  return local.hour * 60 + local.minute >= hour * 60 + minute ? zonedDayKey(now, timeZone) : null;
}
