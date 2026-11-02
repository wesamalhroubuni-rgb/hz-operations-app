import {
  AI_SUMMARY_RECIPIENT_ROLES,
  aiSettingsOf,
  MAX_AI_DAILY_COST_LIMIT_USD,
  MAX_AI_DAILY_REQUEST_LIMIT,
  updateOrganizationSchema,
  type AiSummaryRecipientRole,
  type AnomalyFlag,
  type AnomalySeverity,
  type DailySummary,
  type DailySummaryStats,
  type DayKey,
  type OrganizationFull,
  type UpdateOrganization,
} from '@ops/shared';

import type { BadgeTone } from '@/components/ui/status-badge';
import { formatNumber, t, type TranslationKey } from '@/i18n';

/**
 * Daily summaries, unusual-item flags, AI settings and usage on the dashboard (Phase 7,
 * ADR-0011). Pure, so tested. Every sentence comes from the `ai` catalogue; a flag's reason is
 * written here from its stored numbers (`params`), in the reader's language, never by the AI.
 */

export const SUMMARY_HISTORY_PATH = '/summaries';
export const AI_USAGE_PATH = '/ai-usage';
/** The URL (and API) parameters of the day ranges: inclusive org-local days. */
export const DAY_RANGE_KEYS = ['from', 'to'] as const;
/** Days the anomaly panel shows by default, ending with the overview's day. */
export const ANOMALY_PANEL_DEFAULT_DAYS = 7;
/** At most this many flags in the overview panel (one page of the API). */
export const ANOMALY_PANEL_PAGE_SIZE = 100;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDayKey(value: string | null | undefined): value is DayKey {
  return typeof value === 'string' && DAY_KEY.test(value);
}

/** Whole days from `from` to `to` (two day keys). */
export function daysBetween(from: DayKey, to: DayKey): number {
  const utc = (day: DayKey) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    return Date.UTC(year, month - 1, date);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export interface KeyNumber {
  key: string;
  label: string;
  value: number;
  /** Draws attention when above zero (overdue, blocked, unusual items, awaiting review). */
  attention: boolean;
}

/** The numbers shown next to a narrative, all from `stats` (computed by the API in code). */
export function summaryKeyNumbers(stats: DailySummaryStats): KeyNumber[] {
  const rows: Array<[string, number, boolean]> = [
    ['logs', stats.logs.total, false],
    ['awaiting', stats.awaitingApproval, true],
    ['open', stats.tasks.open, false],
    ['overdue', stats.tasks.overdue, true],
    ['blocked', stats.tasks.blocked, true],
    ['completed', stats.tasks.completed, false],
    ['idle', stats.workers.idle, false],
    ['flags', stats.anomalies.total, true],
  ];
  return rows.map(([key, value, attention]) => ({
    key,
    label: t(`ai.summary.numbers.${key}` as TranslationKey),
    value,
    attention: attention && value > 0,
  }));
}

/** "Covers the whole organization." / "Covers your scope: 2 sites and 1 team." */
export function summaryScopeText(summary: Pick<DailySummary, 'scope'>): string {
  const { scope } = summary;
  if (scope.orgWide) {
    return t('ai.summary.scopeOrgWide');
  }
  return t('ai.summary.scopeLimited', {
    sites: t('ai.summary.sites', { count: scope.siteIds.length }),
    teams: t('ai.summary.teams', { count: scope.teamIds.length }),
  });
}

const SEVERITY_TONES: Record<AnomalySeverity, BadgeTone> = {
  low: 'info',
  medium: 'warning',
  high: 'danger',
};

export function severityTone(severity: AnomalySeverity): BadgeTone {
  return SEVERITY_TONES[severity];
}

export function severityLabel(severity: AnomalySeverity): string {
  return t(`ai.anomalies.severity.${severity}` as TranslationKey);
}

export function anomalyKindLabel(kind: AnomalyFlag['kind']): string {
  return t(`ai.anomalies.kinds.${kind}` as TranslationKey);
}

/** Names the reader may see (the directory); an empty answer means "not visible". */
export interface ReasonNames {
  site(id: string | null): string;
  user(id: string | null): string;
  /** The org-local day of an instant. */
  dayOf(value: string): DayKey;
}

/** "5 hours" below two days, else "3 days" (rounded). */
export function durationText(hours: number): string {
  if (hours < 48) {
    return t('ai.reasons.hours', { count: Math.max(0, Math.round(hours)) });
  }
  return t('ai.reasons.days', { count: Math.round(hours / 24) });
}

/** The reason of a flag, in the reader's language, from its stored numbers. */
export function anomalyReason(flag: AnomalyFlag, names: ReasonNames): string {
  const site = names.site(flag.siteId) || t('ai.reasons.unknownSite');
  switch (flag.kind) {
    case 'no_activity_site': {
      const { lastLogAt, openTasks, lookbackDays } = flag.params;
      const lastLog = lastLogAt
        ? t('ai.reasons.lastLogDaysBefore', {
            count: Math.max(1, daysBetween(names.dayOf(lastLogAt), flag.day)),
          })
        : t('ai.reasons.noLogInDays', { days: formatNumber(lookbackDays) });
      return t('ai.reasons.noActivitySite', {
        site,
        openTasks: t('ai.reasons.openTasks', { count: openTasks }),
        lastLog,
      });
    }
    case 'slow_task':
      return t('ai.reasons.slowTask', {
        site,
        age: durationText(flag.params.ageHours),
        factor: formatNumber(flag.params.factor, 1),
        median: durationText(flag.params.medianHours),
        sample: formatNumber(flag.params.sampleSize),
      });
    case 'repeated_rejections':
      return t('ai.reasons.repeatedRejections', {
        person: names.user(flag.userId) || t('ai.reasons.unknownPerson'),
        rejections: t('ai.reasons.rejections', { count: flag.params.rejections }),
        days: formatNumber(flag.params.windowDays),
      });
    case 'far_location':
      return t('ai.reasons.farLocation', {
        site,
        distance: formatNumber(flag.params.distanceKm, 1),
        threshold: formatNumber(flag.params.thresholdKm, 1),
        reference:
          flag.params.reference === 'site_coordinates'
            ? t('ai.reasons.referenceSite')
            : t('ai.reasons.referenceLogs'),
      });
  }
}

/** The record a flag points at: its task or its work log, or none. */
export function anomalyLink(flag: AnomalyFlag): { href: string; label: string } | null {
  if (flag.taskId) {
    return { href: `/tasks/${flag.taskId}`, label: t('ai.anomalies.openTask') };
  }
  if (flag.workLogId) {
    return { href: `/work-logs/${flag.workLogId}`, label: t('ai.anomalies.openLog') };
  }
  return null;
}

/**
 * The day range of a panel or list from the URL: both days when valid and in order, else the
 * `defaultDays` days ending `lastDay`.
 */
export function dayRangeFrom(
  filters: Record<string, string>,
  lastDay: DayKey,
  defaultDays: number,
): { from: DayKey; to: DayKey } {
  const from = filters.from;
  const to = filters.to;
  if (isDayKey(from) && isDayKey(to) && from <= to) {
    return { from, to };
  }
  const end = isDayKey(to) ? to : lastDay;
  const [year, month, date] = end.split('-').map(Number) as [number, number, number];
  const start = new Date(Date.UTC(year, month - 1, date - (defaultDays - 1)));
  return { from: start.toISOString().slice(0, 10), to: end };
}

/** US dollars with cents (estimates). */
export function formatUsd(value: number): string {
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// AI settings (admins)
// ---------------------------------------------------------------------------------------------

export interface AiSettingsFormState {
  smartCaptureEnabled: boolean;
  dailySummaryEnabled: boolean;
  summaryTime: string;
  summaryRecipientRoles: AiSummaryRecipientRole[];
  /** Empty: no organization limit (the server's ceiling applies). */
  dailyRequestLimit: string;
  dailyCostLimitUsd: string;
}

export type AiSettingsErrorCode = 'time' | 'wholeNumber' | 'number' | 'range';

export type AiSettingsResult =
  | { ok: true; body: UpdateOrganization & { settings: Record<string, unknown> } }
  | { ok: false; errors: Partial<Record<keyof AiSettingsFormState, AiSettingsErrorCode>> };

/** The form from the organization: the AI settings in force (defaults when unset). */
export function aiSettingsFormFrom(organization: OrganizationFull): AiSettingsFormState {
  const current = aiSettingsOf(organization.settings);
  return {
    smartCaptureEnabled: current.smartCaptureEnabled,
    dailySummaryEnabled: current.dailySummaryEnabled,
    summaryTime: current.summaryTime,
    summaryRecipientRoles: [...current.summaryRecipientRoles],
    dailyRequestLimit: current.dailyRequestLimit === null ? '' : String(current.dailyRequestLimit),
    dailyCostLimitUsd: current.dailyCostLimitUsd === null ? '' : String(current.dailyCostLimitUsd),
  };
}

/** Adds or removes a recipient role, keeping the roles in their canonical order. */
export function toggleRecipientRole(
  roles: readonly AiSummaryRecipientRole[],
  role: AiSummaryRecipientRole,
  on: boolean,
): AiSummaryRecipientRole[] {
  const set = new Set(roles);
  if (on) {
    set.add(role);
  } else {
    set.delete(role);
  }
  return AI_SUMMARY_RECIPIENT_ROLES.filter((candidate) => set.has(candidate));
}

function parseNumber(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * The `PATCH /organization` body that changes only `settings.ai`: the request REPLACES the whole
 * settings object, so every other stored key is sent back unchanged (Phase 6 rule), and `ai` is
 * replaced as a whole (an empty limit is left out: the server's ceiling applies).
 */
export function aiSettingsUpdateBody(
  organization: OrganizationFull,
  form: AiSettingsFormState,
): AiSettingsResult {
  const errors: Partial<Record<keyof AiSettingsFormState, AiSettingsErrorCode>> = {};
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.summaryTime)) errors.summaryTime = 'time';

  const requests = parseNumber(form.dailyRequestLimit);
  if (requests !== null) {
    if (Number.isNaN(requests)) errors.dailyRequestLimit = 'number';
    else if (!Number.isInteger(requests)) errors.dailyRequestLimit = 'wholeNumber';
    else if (requests < 0 || requests > MAX_AI_DAILY_REQUEST_LIMIT) {
      errors.dailyRequestLimit = 'range';
    }
  }
  const cost = parseNumber(form.dailyCostLimitUsd);
  if (cost !== null) {
    if (Number.isNaN(cost)) errors.dailyCostLimitUsd = 'number';
    else if (cost < 0 || cost > MAX_AI_DAILY_COST_LIMIT_USD) errors.dailyCostLimitUsd = 'range';
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  const ai: Record<string, unknown> = {
    smartCaptureEnabled: form.smartCaptureEnabled,
    dailySummaryEnabled: form.dailySummaryEnabled,
    summaryTime: form.summaryTime,
    summaryRecipientRoles: AI_SUMMARY_RECIPIENT_ROLES.filter((role) =>
      form.summaryRecipientRoles.includes(role),
    ),
    ...(requests === null ? {} : { dailyRequestLimit: requests }),
    ...(cost === null ? {} : { dailyCostLimitUsd: cost }),
  };
  const settings: Record<string, unknown> = {
    ...(organization.settings as Record<string, unknown>),
    ai,
  };
  const body = { settings };
  if (!updateOrganizationSchema.safeParse(body).success) {
    return { ok: false, errors: { summaryTime: 'time' } };
  }
  return { ok: true, body };
}
