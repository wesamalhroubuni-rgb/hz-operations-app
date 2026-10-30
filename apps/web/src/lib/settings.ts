import {
  DEFAULT_TIME_ZONE,
  isValidTimeZone,
  MAX_OFFLINE_MAX_BACKDATE_DAYS,
  MAX_WORK_LOG_EDIT_WINDOW_HOURS,
  updateOrganizationSchema,
  type OrganizationFull,
  type UpdateOrganization,
} from '@ops/shared';

/**
 * Organization settings screen logic (Phase 6, agent C; admins only). `PATCH /organization`
 * REPLACES the whole `settings` object, so the request always carries every key: the three the
 * screen edits and every other key it read (feature switches), unchanged.
 */

export interface SettingsFormState {
  name: string;
  timeZone: string;
  workLogEditWindowHours: string;
  offlineMaxBackdateDays: string;
}

/** The form from the organization: the values in force (defaults when unset). */
export function settingsFormFrom(organization: OrganizationFull): SettingsFormState {
  return {
    name: organization.name,
    timeZone: organization.timeZone,
    workLogEditWindowHours: String(organization.workLogEditWindowHours),
    offlineMaxBackdateDays: String(organization.offlineMaxBackdateDays),
  };
}

export type SettingsErrorCode = 'required' | 'number' | 'range' | 'wholeNumber' | 'timeZone';

export type SettingsResult =
  | { ok: true; body: UpdateOrganization & { name: string; settings: Record<string, unknown> } }
  | { ok: false; errors: Partial<Record<keyof SettingsFormState, SettingsErrorCode>> };

function parseNumber(value: string): number | null {
  const trimmed = value.trim().replace(',', '.');
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The full `PATCH /organization` body: `name` and `settings` with every stored key kept and the
 * three edited keys set. Validated against the shared schema before it is sent.
 */
export function organizationUpdateBody(
  organization: OrganizationFull,
  form: SettingsFormState,
): SettingsResult {
  const errors: Partial<Record<keyof SettingsFormState, SettingsErrorCode>> = {};
  const name = form.name.trim();
  if (name === '') errors.name = 'required';
  if (!isValidTimeZone(form.timeZone)) errors.timeZone = 'timeZone';

  const hours = parseNumber(form.workLogEditWindowHours);
  if (form.workLogEditWindowHours.trim() === '') errors.workLogEditWindowHours = 'required';
  else if (hours === null) errors.workLogEditWindowHours = 'number';
  else if (hours <= 0 || hours > MAX_WORK_LOG_EDIT_WINDOW_HOURS) {
    errors.workLogEditWindowHours = 'range';
  }

  const days = parseNumber(form.offlineMaxBackdateDays);
  if (form.offlineMaxBackdateDays.trim() === '') errors.offlineMaxBackdateDays = 'required';
  else if (days === null) errors.offlineMaxBackdateDays = 'number';
  else if (!Number.isInteger(days)) errors.offlineMaxBackdateDays = 'wholeNumber';
  else if (days < 1 || days > MAX_OFFLINE_MAX_BACKDATE_DAYS)
    errors.offlineMaxBackdateDays = 'range';

  if (Object.keys(errors).length > 0 || hours === null || days === null) {
    return { ok: false, errors };
  }
  const settings: Record<string, unknown> = {
    ...(organization.settings as Record<string, unknown>),
    workLogEditWindowHours: hours,
    offlineMaxBackdateDays: days,
    timeZone: form.timeZone,
  };
  const body = { name, settings };
  const parsed = updateOrganizationSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, errors: { name: 'required' } };
  }
  return { ok: true, body };
}

/** The keys the settings screen always sends. */
export const EDITED_SETTING_KEYS = [
  'workLogEditWindowHours',
  'offlineMaxBackdateDays',
  'timeZone',
] as const;

const FALLBACK_TIME_ZONES = [
  'UTC',
  'Europe/Istanbul',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'Asia/Dubai',
  'Asia/Riyadh',
  'America/New_York',
];

/**
 * The IANA zones the browser knows (`Intl.supportedValuesOf`), plus UTC, the default, and the
 * current value so the select can always show it. Sorted, no duplicates.
 */
export function timeZoneOptions(current: string): string[] {
  let zones: string[];
  try {
    zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  } catch {
    zones = [];
  }
  if (zones.length === 0) zones = FALLBACK_TIME_ZONES;
  return [...new Set([...zones, 'UTC', DEFAULT_TIME_ZONE, current].filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}
