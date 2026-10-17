import {
  customFieldFormToValues,
  initialCustomFieldValues,
  reconcileCustomFieldValues,
  splitErrorDetails,
  WORK_LOG_MAX_FUTURE_MS,
  type ApiErrorDetail,
  type CreateWorkLogInput,
  type CustomFieldErrors,
  type CustomFieldFormValues,
  type LogType,
  type UpdateWorkLog,
  type WorkLog,
  type WorkLogLocationInput,
} from '@ops/shared';

import { parseIso } from './dates';

// The state of the work log form (new and edit) and its conversion into API bodies. Pure, so the
// rules are unit-tested and the screen only renders. The state is plain JSON: it is what the
// draft store keeps on the phone.

export const LOG_TEXT_MAX_LENGTH = 10_000;

export interface LogFormValues {
  /** Generated on the phone when the form opens; makes "save" idempotent. */
  clientId: string;
  logTypeId: string | null;
  customFields: CustomFieldFormValues;
  text: string;
  taskId: string | null;
  siteId: string | null;
  teamId: string | null;
  /** When the work happened, as ISO. Null: "now", taken at the moment of saving. */
  occurredAt: string | null;
  location: WorkLogLocationInput | null;
}

/** What is wrong with the form, field by field. Codes; the screen translates them. */
export interface LogFormErrors {
  customFields: CustomFieldErrors;
  /** The log has no content: no log type, no text and no photo. */
  empty?: true;
  text?: 'tooLong';
  occurredAt?: 'future' | 'invalid';
  /** API messages for other fields (`siteId`, `taskId`, ...), as sent. */
  other: Record<string, string>;
}

export function emptyLogFormErrors(): LogFormErrors {
  return { customFields: {}, other: {} };
}

export function hasLogFormErrors(errors: LogFormErrors): boolean {
  return (
    Object.keys(errors.customFields).length > 0 ||
    errors.empty === true ||
    errors.text !== undefined ||
    errors.occurredAt !== undefined ||
    Object.keys(errors.other).length > 0
  );
}

export function newLogFormValues(
  clientId: string,
  prefill: Partial<Pick<LogFormValues, 'taskId' | 'siteId' | 'teamId' | 'logTypeId'>> = {},
): LogFormValues {
  return {
    clientId,
    logTypeId: prefill.logTypeId ?? null,
    customFields: {},
    text: '',
    taskId: prefill.taskId ?? null,
    siteId: prefill.siteId ?? null,
    teamId: prefill.teamId ?? null,
    occurredAt: null,
    location: null,
  };
}

/** The form of an existing log, for editing it. */
export function logFormValuesFromLog(log: WorkLog, logType: LogType | null): LogFormValues {
  return {
    clientId: log.clientId,
    logTypeId: log.logTypeId,
    customFields: logType ? initialCustomFieldValues(logType.fields, log.customFields) : {},
    text: log.text ?? '',
    taskId: log.taskId,
    siteId: log.siteId,
    teamId: log.teamId,
    occurredAt: log.occurredAt,
    location: log.location
      ? {
          latitude: log.location.latitude,
          longitude: log.location.longitude,
          accuracy: log.location.accuracy,
        }
      : null,
  };
}

/**
 * Switching the log type keeps what was typed into fields the new type also has (same key and a
 * compatible value) and starts the others empty.
 */
export function withLogType(values: LogFormValues, logType: LogType | null): LogFormValues {
  return {
    ...values,
    logTypeId: logType?.id ?? null,
    customFields: logType ? reconcileCustomFieldValues(logType.fields, values.customFields) : {},
  };
}

function trimmedText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

type Checked =
  | { ok: true; customFields: Record<string, string | number | boolean>; occurredAt: string }
  | { ok: false; errors: LogFormErrors };

function check(
  values: LogFormValues,
  logType: LogType | null,
  photoCount: number,
  now: Date,
): Checked {
  const errors = emptyLogFormErrors();
  let customFields: Record<string, string | number | boolean> = {};
  if (logType) {
    const converted = customFieldFormToValues(logType.fields, values.customFields);
    if (converted.ok) {
      customFields = converted.values;
    } else {
      errors.customFields = converted.errors;
    }
  }
  const text = trimmedText(values.text);
  if (text !== null && text.length > LOG_TEXT_MAX_LENGTH) {
    errors.text = 'tooLong';
  }
  if (!logType && text === null && photoCount === 0) {
    errors.empty = true;
  }
  let occurredAt = now.toISOString();
  if (values.occurredAt !== null) {
    const parsed = parseIso(values.occurredAt);
    if (parsed === null) {
      errors.occurredAt = 'invalid';
    } else if (parsed.getTime() > now.getTime() + WORK_LOG_MAX_FUTURE_MS) {
      errors.occurredAt = 'future';
    } else {
      occurredAt = parsed.toISOString();
    }
  }
  return hasLogFormErrors(errors) ? { ok: false, errors } : { ok: true, customFields, occurredAt };
}

export type BuildResult<Body> = { ok: true; body: Body } | { ok: false; errors: LogFormErrors };

/** The body of `POST /work-logs`, or the problems to show. */
export function buildCreateBody(
  values: LogFormValues,
  logType: LogType | null,
  photoCount: number,
  now: Date,
): BuildResult<CreateWorkLogInput> {
  const checked = check(values, logType, photoCount, now);
  if (!checked.ok) return checked;
  return {
    ok: true,
    body: {
      clientId: values.clientId,
      occurredAt: checked.occurredAt,
      logTypeId: values.logTypeId,
      customFields: checked.customFields,
      text: trimmedText(values.text),
      taskId: values.taskId,
      siteId: values.siteId,
      teamId: values.teamId,
      location: values.location,
      status: 'submitted',
      source: 'manual',
    },
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The body of `PATCH /work-logs/:id`: only what changed. `null` when nothing changed (the API
 * refuses an empty update). Custom fields are sent whole whenever they or the type changed.
 */
export function buildUpdateBody(
  values: LogFormValues,
  original: WorkLog,
  logType: LogType | null,
  photoCount: number,
  now: Date,
): BuildResult<UpdateWorkLog | null> {
  const checked = check(values, logType, photoCount, now);
  if (!checked.ok) return checked;
  const body: UpdateWorkLog = {};
  if (
    values.occurredAt !== null &&
    parseIso(values.occurredAt)?.getTime() !== parseIso(original.occurredAt)?.getTime()
  ) {
    body.occurredAt = checked.occurredAt;
  }
  if (values.logTypeId !== original.logTypeId) body.logTypeId = values.logTypeId;
  // When the log's type could not be loaded (archived since, or not visible), the form never
  // showed its custom fields: leave them as stored instead of sending an empty set.
  const fieldsUnknown = logType === null && values.logTypeId !== null;
  if (
    !fieldsUnknown &&
    (body.logTypeId !== undefined || !sameJson(checked.customFields, original.customFields))
  ) {
    body.customFields = checked.customFields;
  }
  const text = trimmedText(values.text);
  if (text !== original.text) body.text = text;
  if (values.taskId !== original.taskId) body.taskId = values.taskId;
  if (values.siteId !== original.siteId) body.siteId = values.siteId;
  if (values.teamId !== original.teamId) body.teamId = values.teamId;
  return { ok: true, body: Object.keys(body).length === 0 ? null : body };
}

/** Puts the API's 400/422 details next to the right fields of the form. */
export function errorsFromApiDetails(details: readonly ApiErrorDetail[]): LogFormErrors {
  const { customFields, other } = splitErrorDetails(details);
  const errors: LogFormErrors = { customFields, other: {} };
  for (const [path, message] of Object.entries(other)) {
    if (path === 'occurredAt') {
      errors.occurredAt = message.includes('future') ? 'future' : 'invalid';
    } else if (path === 'text') {
      errors.text = 'tooLong';
    } else {
      errors.other[path] = message;
    }
  }
  return errors;
}
