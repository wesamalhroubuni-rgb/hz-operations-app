import type { ApiErrorDetail } from '../common/errors.js';
import {
  validateCustomFieldValues,
  type CustomFieldDefinition,
  type CustomFieldType,
  type CustomFieldValues,
} from '../domain/custom-fields.js';

// Turns a log type's custom field definitions into a form and back, for the mobile app now and
// the web dashboard later. Framework-free: no React, no React Native, no DOM.
//
// The form keeps what the person typed, not the stored value: a number field holds the text
// "12,5" until it is sent, a boolean field may be unanswered (null), an empty text means "no
// value". `customFieldFormToValues` converts and validates with the same
// `validateCustomFieldValues` the API runs, so the phone refuses exactly what the server would.

/** What one field's input holds while the form is open. */
export type CustomFieldFormValue = string | boolean | null;

/** The form state of all custom fields, keyed by field key. */
export type CustomFieldFormValues = Record<string, CustomFieldFormValue>;

/** Which input a client renders for a field. */
export type CustomFieldInputKind = 'text' | 'number' | 'yesNo' | 'choice' | 'date';

const INPUT_KIND: Record<CustomFieldType, CustomFieldInputKind> = {
  text: 'text',
  number: 'number',
  boolean: 'yesNo',
  select: 'choice',
  date: 'date',
};

/** Everything a client needs to render one custom field. */
export interface CustomFieldDescriptor {
  key: string;
  label: string;
  type: CustomFieldType;
  input: CustomFieldInputKind;
  required: boolean;
  /** The choices of a `select` field, in the order the log type defines; empty otherwise. */
  options: readonly string[];
  helpText: string | null;
}

/**
 * Why a field's value was refused, as a code the client translates. `message` on
 * {@link CustomFieldFieldError} keeps the validator's English sentence as a fallback.
 */
export type CustomFieldErrorCode =
  | 'required'
  | 'number'
  | 'tooLong'
  | 'option'
  | 'date'
  | 'boolean'
  | 'text'
  | 'unknownField'
  | 'invalid';

export interface CustomFieldFieldError {
  code: CustomFieldErrorCode;
  message: string;
}

/** Errors keyed by field key. */
export type CustomFieldErrors = Record<string, CustomFieldFieldError>;

export type CustomFieldFormResult =
  { ok: true; values: CustomFieldValues } | { ok: false; errors: CustomFieldErrors };

/** The descriptors of a log type's fields, in the order the log type defines them. */
export function customFieldDescriptors(
  definitions: readonly CustomFieldDefinition[],
): CustomFieldDescriptor[] {
  return definitions.map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    input: INPUT_KIND[field.type],
    required: field.required,
    options: field.type === 'select' ? [...(field.options ?? [])] : [],
    helpText: field.helpText?.trim() ? field.helpText.trim() : null,
  }));
}

/** Turns a stored value back into what the form shows (for editing an existing log). */
function toFormValue(field: CustomFieldDefinition, value: unknown): CustomFieldFormValue {
  if (value === undefined || value === null) {
    return field.type === 'boolean' ? null : '';
  }
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? value : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
    case 'date':
      // A date field may hold a full datetime; the form edits the calendar date.
      return typeof value === 'string' ? value.slice(0, 10) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

/**
 * The starting form state: every field of the log type, empty (a boolean unanswered), or filled
 * from `existing` when editing a log. Keys in `existing` that the log type no longer declares are
 * dropped, so saving does not send a field the server would refuse.
 */
export function initialCustomFieldValues(
  definitions: readonly CustomFieldDefinition[],
  existing: Readonly<Record<string, unknown>> = {},
): CustomFieldFormValues {
  const form: CustomFieldFormValues = {};
  for (const field of definitions) {
    form[field.key] = toFormValue(field, existing[field.key]);
  }
  return form;
}

/**
 * Keeps a form's values for the fields that still exist and adds the new ones empty. Used when a
 * restored draft meets a log type whose fields changed meanwhile.
 */
export function reconcileCustomFieldValues(
  definitions: readonly CustomFieldDefinition[],
  form: Readonly<Record<string, unknown>>,
): CustomFieldFormValues {
  const result = initialCustomFieldValues(definitions);
  for (const field of definitions) {
    const value = form[field.key];
    if (field.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string') {
      result[field.key] = value as CustomFieldFormValue;
    }
  }
  return result;
}

/**
 * Reads a number the way people type it on a phone: surrounding spaces ignored, a comma accepted
 * as the decimal separator ("12,5"). Returns null for anything that is not one finite number.
 */
export function parseFormNumber(text: string): number | null {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (trimmed === '') {
    return null;
  }
  const normalised =
    trimmed.includes(',') && !trimmed.includes('.') ? trimmed.replace(',', '.') : trimmed;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(normalised)) {
    return null;
  }
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/** Maps a validator (or API) message about a custom field to a code a client can translate. */
export function customFieldErrorCode(message: string): CustomFieldErrorCode {
  if (message === 'is required') return 'required';
  if (message === 'must be a number') return 'number';
  if (message.startsWith('must be at most')) return 'tooLong';
  if (message.startsWith('must be one of')) return 'option';
  if (message.startsWith('must be an ISO date')) return 'date';
  if (message === 'must be true or false') return 'boolean';
  if (message === 'must be text') return 'text';
  if (message === 'is not a field of this log type') return 'unknownField';
  return 'invalid';
}

const CUSTOM_FIELDS_PREFIX = 'customFields.';

/**
 * Splits error details (from the validator or from an API 400/422) into the custom-field errors,
 * keyed by field key, and the rest, keyed by path. The first problem per field wins.
 */
export function splitErrorDetails(details: readonly ApiErrorDetail[]): {
  customFields: CustomFieldErrors;
  other: Record<string, string>;
} {
  const customFields: CustomFieldErrors = {};
  const other: Record<string, string> = {};
  for (const detail of details) {
    if (detail.path.startsWith(CUSTOM_FIELDS_PREFIX)) {
      const key = detail.path.slice(CUSTOM_FIELDS_PREFIX.length);
      customFields[key] ??= { code: customFieldErrorCode(detail.message), message: detail.message };
    } else {
      other[detail.path] ??= detail.message;
    }
  }
  return { customFields, other };
}

/**
 * Converts the form into the `customFields` of a work log and validates it against the log type.
 * Empty inputs become "no value" (left out); a number that cannot be read is refused here with
 * the `number` code instead of being sent as text.
 */
export function customFieldFormToValues(
  definitions: readonly CustomFieldDefinition[],
  form: Readonly<CustomFieldFormValues>,
): CustomFieldFormResult {
  const errors: CustomFieldErrors = {};
  const candidate: Record<string, unknown> = {};

  for (const field of definitions) {
    const raw = form[field.key];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (field.type === 'boolean') {
      if (typeof raw === 'boolean') candidate[field.key] = raw;
      continue;
    }
    if (typeof raw !== 'string') {
      continue;
    }
    if (field.type === 'number') {
      if (raw.trim() === '') continue;
      const number = parseFormNumber(raw);
      if (number === null) {
        errors[field.key] = { code: 'number', message: 'must be a number' };
      } else {
        candidate[field.key] = number;
      }
      continue;
    }
    // Text keeps inner spaces; an all-blank text is "no value". Select and date are exact.
    if (raw.trim() === '') continue;
    candidate[field.key] = field.type === 'text' ? raw : raw.trim();
  }

  const validated = validateCustomFieldValues(definitions, candidate);
  if (!validated.ok) {
    for (const [key, error] of Object.entries(splitErrorDetails(validated.issues).customFields)) {
      errors[key] ??= error;
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return validated.ok ? { ok: true, values: validated.values } : { ok: false, errors };
}
