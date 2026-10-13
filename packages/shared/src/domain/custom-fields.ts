import { z } from 'zod';
import type { ApiErrorDetail } from '../common/errors.js';

/** The kinds of custom field a log type can define. */
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'boolean', 'select', 'date'] as const;
export const customFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const MAX_CUSTOM_FIELDS = 100;
export const MAX_CUSTOM_FIELD_OPTIONS = 100;
export const MAX_CUSTOM_FIELD_TEXT_LENGTH = 2000;

/**
 * Stable identifier of a field inside its log type. Values are stored under this key, so it must
 * not change once logs exist; the label is what people see and may change freely.
 */
export const customFieldKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, {
  error:
    'must be a slug: lowercase letters, digits and underscores, starting with a letter (max 64)',
});

const optionSchema = z.string().trim().min(1).max(200);

/** One custom field of a log type. `options` is required for `select` and forbidden otherwise. */
export const customFieldDefinitionSchema = z
  .strictObject({
    key: customFieldKeySchema,
    label: z.string().trim().min(1).max(200),
    type: customFieldTypeSchema,
    required: z.boolean().default(false),
    options: z.array(optionSchema).max(MAX_CUSTOM_FIELD_OPTIONS).optional(),
    helpText: z.string().trim().max(500).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select') {
      if (!field.options || field.options.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'A select field needs at least one option',
        });
      } else if (new Set(field.options).size !== field.options.length) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'Options must be unique' });
      }
    } else if (field.options !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'Only a select field may have options',
      });
    }
  });
export type CustomFieldDefinition = z.infer<typeof customFieldDefinitionSchema>;
export type CustomFieldDefinitionInput = z.input<typeof customFieldDefinitionSchema>;

/** The ordered field list of a log type. Keys are unique within the list. */
export const customFieldDefinitionsSchema = z
  .array(customFieldDefinitionSchema)
  .max(MAX_CUSTOM_FIELDS)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'key'],
          message: `Duplicate field key "${field.key}"`,
        });
      }
      seen.add(field.key);
    });
  });

/** A stored custom field value. Text, select and date values are strings. */
export const customFieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

/** Custom field values as sent by a client: keyed by field key, checked against the log type. */
export const customFieldValuesInputSchema = z.record(z.string(), z.unknown());

/** Custom field values as stored and returned: only fields that have a value, no nulls. */
export const customFieldValuesSchema = z.record(z.string(), customFieldValueSchema);
export type CustomFieldValues = z.infer<typeof customFieldValuesSchema>;

export type CustomFieldValidationResult =
  { ok: true; values: CustomFieldValues } | { ok: false; issues: ApiErrorDetail[] };

const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the problem with one value, or null when it satisfies the field. */
function problemWith(field: CustomFieldDefinition, value: unknown): string | null {
  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') return 'must be text';
      if (value.length > MAX_CUSTOM_FIELD_TEXT_LENGTH) {
        return `must be at most ${MAX_CUSTOM_FIELD_TEXT_LENGTH} characters`;
      }
      return field.required && value.trim() === '' ? 'is required' : null;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : 'must be a number';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'select':
      return typeof value === 'string' && (field.options ?? []).includes(value)
        ? null
        : `must be one of: ${(field.options ?? []).join(', ')}`;
    case 'date':
      return typeof value === 'string' &&
        (isoDate.safeParse(value).success || isoDateTime.safeParse(value).success)
        ? null
        : 'must be an ISO date (YYYY-MM-DD) or an ISO datetime with an offset';
  }
}

/**
 * Checks custom field values against a log type's field definitions. The API runs it on every
 * work log write; web and mobile can run the same function to validate a form before sending.
 *
 * Rules:
 * - a key that no definition declares is rejected;
 * - a required field must be present and not null (and, for text, not blank);
 * - an optional field may be absent or null, both of which mean "no value";
 * - text is a string of at most {@link MAX_CUSTOM_FIELD_TEXT_LENGTH} characters, number is a
 *   finite number, boolean is a boolean, select is one of the field's options, date is an ISO
 *   date (`2026-10-13`) or an ISO datetime with an offset.
 *
 * On success `values` holds only the fields that have a value (nulls are dropped), ready to
 * store. On failure every problem is listed, with `path` set to `customFields.<key>`.
 */
export function validateCustomFieldValues(
  definitions: readonly CustomFieldDefinition[],
  values: unknown,
): CustomFieldValidationResult {
  const input = values ?? {};
  if (!isPlainObject(input)) {
    return { ok: false, issues: [{ path: 'customFields', message: 'must be an object' }] };
  }

  const issues: ApiErrorDetail[] = [];
  const known = new Set(definitions.map((field) => field.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      issues.push({ path: `customFields.${key}`, message: 'is not a field of this log type' });
    }
  }

  const result: CustomFieldValues = {};
  for (const field of definitions) {
    const value: unknown = Object.hasOwn(input, field.key) ? input[field.key] : undefined;
    if (value === undefined || value === null) {
      if (field.required) {
        issues.push({ path: `customFields.${field.key}`, message: 'is required' });
      }
      continue;
    }
    const problem = problemWith(field, value);
    if (problem) {
      issues.push({ path: `customFields.${field.key}`, message: problem });
    } else {
      result[field.key] = value as CustomFieldValue;
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, values: result };
}
