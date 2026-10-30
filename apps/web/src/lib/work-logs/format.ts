import {
  WORK_LOG_HISTORY_FIELDS,
  WORK_LOG_STATUSES,
  type CustomFieldDefinition,
  type CustomFieldValues,
  type RecordHistoryEntry,
  type WorkLog,
  type WorkLogStatus,
} from '@ops/shared';

import { formatNumber, t, type TranslationKey } from '@/i18n';
import type { OrgTime } from '@/lib/time';

/** Display helpers of the work-log pages. Pure, so tested. */

export interface CustomFieldRow {
  key: string;
  label: string;
  value: string;
  help: string | null;
  /** The value's key is not (any more) in the log type's definitions. */
  removed: boolean;
}

function isoDayOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** One custom-field value written out for its field type. */
export function formatCustomFieldValue(
  field: Pick<CustomFieldDefinition, 'type'> | null,
  value: string | number | boolean | undefined,
  orgTime: Pick<OrgTime, 'day' | 'dateTime'>,
): string {
  if (value === undefined || value === '') {
    return t('workLogs.fields.noValue');
  }
  if (typeof value === 'boolean') {
    return value ? t('workLogs.fields.yes') : t('workLogs.fields.no');
  }
  if (typeof value === 'number') {
    return formatNumber(value, 6);
  }
  if (field?.type === 'date') {
    // A calendar date stays that date; a full datetime is shown in the organization's zone.
    if (isoDayOnly(value)) {
      return orgTime.day(value);
    }
    if (!Number.isNaN(Date.parse(value))) {
      return orgTime.dateTime(value);
    }
  }
  return value;
}

/**
 * The rows of the detail's "Details" section: every field the log type defines, in its order
 * (with "No value" when the log has none), then any stored value whose key the current
 * definition no longer has (a field removed after the log was written: ADR-0003 keeps the value).
 * Without definitions (the log type could not be loaded) the raw keys are shown.
 */
export function customFieldRows(
  definitions: readonly CustomFieldDefinition[] | null,
  values: CustomFieldValues,
  orgTime: Pick<OrgTime, 'day' | 'dateTime'>,
): CustomFieldRow[] {
  const rows: CustomFieldRow[] = [];
  const known = new Set<string>();
  for (const field of definitions ?? []) {
    known.add(field.key);
    rows.push({
      key: field.key,
      label: field.label,
      value: formatCustomFieldValue(field, values[field.key], orgTime),
      help: field.helpText ?? null,
      removed: false,
    });
  }
  for (const [key, value] of Object.entries(values)) {
    if (!known.has(key)) {
      rows.push({
        key,
        label: key,
        value: formatCustomFieldValue(null, value, orgTime),
        help: null,
        removed: definitions !== null,
      });
    }
  }
  return rows;
}

/** "3 minutes", "1 hour", "45 seconds": the size of a clock difference, rounded down. */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.abs(Math.trunc(totalSeconds));
  if (seconds < 60) {
    return t('workLogs.sync.seconds', { count: seconds });
  }
  if (seconds < 3600) {
    return t('workLogs.sync.minutes', { count: Math.floor(seconds / 60) });
  }
  return t('workLogs.sync.hours', { count: Math.floor(seconds / 3600) });
}

export interface SyncFacts {
  offline: boolean;
  /** The phone's clock when the log was saved, in the organization's zone, or null. */
  deviceTime: string | null;
  /** "3 minutes ahead compared to the server", or null when unknown. */
  skew: string | null;
  flagged: boolean;
}

/** The offline-sync facts of a log (ADR-0008) for the detail page. */
export function syncFactsOf(
  log: Pick<
    WorkLog,
    'submittedOffline' | 'deviceCreatedAt' | 'clockSkewSeconds' | 'clockSkewFlagged'
  >,
  orgTime: Pick<OrgTime, 'format'>,
): SyncFacts {
  let skew: string | null = null;
  if (log.clockSkewSeconds !== null) {
    const amount = formatDuration(log.clockSkewSeconds);
    skew =
      log.clockSkewSeconds === 0
        ? t('workLogs.sync.skewNone')
        : t('workLogs.sync.skewValue', {
            value:
              log.clockSkewSeconds > 0
                ? t('workLogs.sync.skewAhead', { amount })
                : t('workLogs.sync.skewBehind', { amount }),
          });
  }
  return {
    offline: log.submittedOffline,
    deviceTime: log.deviceCreatedAt ? orgTime.format(log.deviceCreatedAt, 'dateTimeSeconds') : null,
    skew,
    flagged: log.clockSkewFlagged,
  };
}

const ACTION_KEYS: Record<string, TranslationKey> = {
  'work_log.created': 'workLogs.history.actions.workLogCreated',
  'work_log.updated': 'workLogs.history.actions.workLogUpdated',
  'work_log.status_changed': 'workLogs.history.actions.workLogStatusChanged',
  'work_log.archived': 'workLogs.history.actions.workLogArchived',
  'attachment.upload_started': 'workLogs.history.actions.attachmentUploadStarted',
  'attachment.completed': 'workLogs.history.actions.attachmentCompleted',
  'attachment.upload_expired': 'workLogs.history.actions.attachmentUploadExpired',
  'attachment.archived': 'workLogs.history.actions.attachmentArchived',
};

function isWorkLogStatus(value: unknown): value is WorkLogStatus {
  return typeof value === 'string' && (WORK_LOG_STATUSES as readonly string[]).includes(value);
}

function statusLabel(value: unknown): string {
  return isWorkLogStatus(value) ? t(`status.workLog.${value}`) : t('common.none');
}

export interface HistoryLine {
  id: string;
  title: string;
  /** "by Selin", "by the system", "by Someone". */
  actor: string;
  /** "Status: Awaiting approval → Approved", if the status changed. */
  statusChange: string | null;
  /** "Changed: text, details", for the other allowed fields that changed. */
  changed: string | null;
  offline: boolean;
  occurredAt: string;
}

/** A history entry written out (`GET /work-logs/:id/history` is already role-shaped). */
export function historyLineOf(entry: RecordHistoryEntry): HistoryLine {
  const key = ACTION_KEYS[entry.action];
  const title = key
    ? t(key)
    : t('workLogs.history.actions.unknownAction', { action: entry.action });
  const actor =
    entry.actorType === 'system'
      ? t('workLogs.history.system')
      : t('workLogs.history.by', { name: entry.actorName ?? t('common.someone') });

  const changes = entry.changes ?? {};
  const status = changes.status;
  const statusChange = status
    ? t('workLogs.history.statusChange', {
        from: statusLabel(status.from),
        to: statusLabel(status.to),
      })
    : null;
  // Only the allowed fields (the API already limits them), in a stable order; status is above.
  const others = (WORK_LOG_HISTORY_FIELDS as readonly string[]).filter(
    (field) => field !== 'status' && Object.hasOwn(changes, field),
  );
  const changed =
    entry.entityType === 'work_log' && others.length > 0
      ? t('workLogs.history.changed', {
          fields: others
            .map((field) => t(`workLogs.history.fieldNames.${field}` as TranslationKey))
            .join(', '),
        })
      : null;

  return {
    id: entry.id,
    title,
    actor,
    statusChange,
    changed,
    offline: entry.offline,
    occurredAt: entry.occurredAt,
  };
}

/** A log's text shortened for a table cell. */
export function excerptOf(text: string | null, max = 120): string | null {
  if (text === null) {
    return null;
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat === '') {
    return null;
  }
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
