import { REPORT_MAX_DAYS, type DayKey, type WorkLogReportParams } from '@ops/shared';

import { t } from '@/i18n';

import { REPORT_FILTER_KEYS } from './work-logs/filters';
import { daysOfRange, presetDays, type OrgTime } from './time';

/**
 * The printable report's URL state: `occurredFrom` / `occurredTo` (the same instants as the
 * work-log list, so "Printable report" on the list keeps its range) plus the report's filters.
 * Without a range the report covers the last 7 days in the organization's zone. Pure, so tested.
 */
export type ReportParams =
  | { ok: true; query: WorkLogReportParams; days: { from: DayKey; to: DayKey } }
  | { ok: false; message: string; days: { from: DayKey | null; to: DayKey | null } };

/** Whole days from `from` to `to`, both included. */
export function dayCount(from: DayKey, to: DayKey): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
}

export function readReportParams(
  params: URLSearchParams,
  orgTime: Pick<OrgTime, 'timeZone' | 'today' | 'range'>,
  now: Date = new Date(),
): ReportParams {
  const hasRange = params.has('occurredFrom') || params.has('occurredTo');
  const picked = hasRange
    ? daysOfRange(
        { from: params.get('occurredFrom'), to: params.get('occurredTo') },
        orgTime.timeZone,
      )
    : presetDays('last7Days', orgTime.today(now));
  if (picked.from === null || picked.to === null) {
    return { ok: false, message: t('report.needRange'), days: picked };
  }
  if (picked.to < picked.from || dayCount(picked.from, picked.to) > REPORT_MAX_DAYS) {
    return { ok: false, message: t('report.tooLong', { days: REPORT_MAX_DAYS }), days: picked };
  }
  const range = orgTime.range(picked.from, picked.to);
  const query: WorkLogReportParams = { occurredFrom: range.from, occurredTo: range.to };
  for (const key of REPORT_FILTER_KEYS) {
    const value = params.get(key);
    if (value) {
      query[key] = value;
    }
  }
  return { ok: true, query, days: { from: picked.from, to: picked.to } };
}

/** Share of the largest value, 0–100, for the bars of the report. */
export function barPercent(value: number, max: number): number {
  return max <= 0 ? 0 : Math.round((value / max) * 100);
}
