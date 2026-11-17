import { z } from 'zod';
import {
  aiConfidenceLevelSchema,
  type AiConfidenceLevel,
  type SmartCaptureConfidence,
  type SmartCaptureProposal,
} from './ai-capture.js';
import {
  validateCustomFieldValues,
  type CustomFieldDefinition,
  type CustomFieldValue,
  type CustomFieldValues,
} from './custom-fields.js';

// The structured output of the smart-capture model call (Phase 7, ADR-0010), built from the log
// types' custom-field definitions so the model can only answer with fields, options and
// references that exist. Pure: the API builds the schema per capture, the LLM provider turns it
// into the provider's JSON-schema format (`toStructuredOutputJsonSchema`), and the answer is
// validated with the same Zod schema before it is used (one retry, then `output_invalid`).
//
// The model never sees database ids: tasks and sites are offered as short references (`T1`,
// `S1`, ...) that the API maps back, so a made-up id cannot pass. Log types are offered by key.
// Every property is present in the answer (`null` = "not said"), because structured outputs
// require every property to be listed as required.

/** A log type offered to the model: its key and its current field definitions. */
export interface CaptureOutputLogType {
  key: string;
  fields: readonly CustomFieldDefinition[];
}

export interface CaptureOutputOptions {
  /** At most `AI_CAPTURE_MAX_LOG_TYPES`; may be empty. */
  logTypes: readonly CaptureOutputLogType[];
  /** References of the tasks offered (`T1`, ...); at most `AI_CAPTURE_MAX_TASKS`. */
  taskRefs: readonly string[];
  /** References of the sites offered (`S1`, ...); at most `AI_CAPTURE_MAX_SITES`. */
  siteRefs: readonly string[];
}

/** One custom-field value the model filled: `field` is `<logTypeKey>.<fieldKey>`. */
export interface CaptureModelField {
  field: string;
  value: CustomFieldValue;
  confidence: AiConfidenceLevel;
}

/**
 * The model's answer, as validated by the schema of {@link buildCaptureOutputSchema}.
 *
 * Shaped for Anthropic's structured-output limit of 16 union-typed (nullable or `anyOf`)
 * parameters per schema (found with the first real call, 2026-11-17): the schema has at most six,
 * however many log types and fields are offered. Field values are a list (a value not said is
 * simply absent), and confidences are never null (the code ignores the confidence of a value
 * left null).
 */
export interface CaptureModelOutput {
  /** A key of the offered log types, or null when none fits. */
  logTypeKey: string | null;
  logTypeConfidence: AiConfidenceLevel;
  /** The values the input states, for fields of the chosen log type. */
  fields: CaptureModelField[];
  taskRef: string | null;
  taskConfidence: AiConfidenceLevel;
  siteRef: string | null;
  siteConfidence: AiConfidenceLevel;
  /** The log's free text, in the worker's language, cleaned of filler words. */
  text: string | null;
  textConfidence: AiConfidenceLevel;
  /** When the work happened, if the input says so (ISO date-time with offset). */
  occurredAt: string | null;
}

/** The `field` name of a log type's custom field in the model's answer. */
export function captureFieldName(logTypeKey: string, fieldKey: string): string {
  return `${logTypeKey}.${fieldKey}`;
}

/** Longest free text kept from the model (the work log's own limit). */
const MAX_PROPOSED_TEXT_LENGTH = 10_000;

function fieldValueSchema(field: CustomFieldDefinition): z.ZodType {
  switch (field.type) {
    case 'text':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'select': {
      const [first, ...rest] = field.options ?? [];
      return first === undefined ? z.never() : z.enum([first, ...rest]);
    }
    case 'date':
      return z.iso.date();
  }
}

function referenceSchema(refs: readonly string[]): z.ZodType {
  const [first, ...rest] = refs;
  return first === undefined ? z.null() : z.enum([first, ...rest]).nullable();
}

/** One list entry per offered field: its name as a constant, its typed value, a confidence. */
function fieldEntrySchemas(logTypes: readonly CaptureOutputLogType[]): z.ZodType[] {
  return logTypes.flatMap((logType) =>
    logType.fields
      .filter((field) => field.type !== 'select' || (field.options ?? []).length > 0)
      .map((field) =>
        z.strictObject({
          field: z.literal(captureFieldName(logType.key, field.key)),
          value: fieldValueSchema(field),
          confidence: aiConfidenceLevelSchema,
        }),
      ),
  );
}

/**
 * The Zod schema of the model's answer for one capture: the offered log type keys, a list of
 * field values (one entry shape per offered field, select options as enums, dates as ISO dates),
 * and the offered task and site references. At most six union-typed parameters whatever is
 * offered (see {@link CaptureModelOutput}). Throws when two log types share a key.
 */
export function buildCaptureOutputSchema(
  options: CaptureOutputOptions,
): z.ZodType<CaptureModelOutput> {
  const keys = new Set<string>();
  for (const logType of options.logTypes) {
    if (keys.has(logType.key)) {
      throw new Error(`Duplicate log type key "${logType.key}"`);
    }
    keys.add(logType.key);
  }
  const entries = fieldEntrySchemas(options.logTypes);
  const [firstEntry, ...otherEntries] = entries;
  const fields =
    firstEntry === undefined
      ? z.array(z.string()).max(0)
      : z.array(otherEntries.length === 0 ? firstEntry : z.union([firstEntry, ...otherEntries]));
  return z.strictObject({
    logTypeKey: referenceSchema([...keys]),
    logTypeConfidence: aiConfidenceLevelSchema,
    fields,
    taskRef: referenceSchema(options.taskRefs),
    taskConfidence: aiConfidenceLevelSchema,
    siteRef: referenceSchema(options.siteRefs),
    siteConfidence: aiConfidenceLevelSchema,
    text: z.string().nullable(),
    textConfidence: aiConfidenceLevelSchema,
    occurredAt: z.iso.datetime({ offset: true }).nullable(),
  }) as unknown as z.ZodType<CaptureModelOutput>;
}

/** Keywords of JSON Schema that structured outputs do not accept; the Zod schema checks them. */
const UNSUPPORTED_KEYWORDS = new Set([
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  '$schema',
]);

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripUnsupported);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!UNSUPPORTED_KEYWORDS.has(key)) {
      result[key] = stripUnsupported(value);
    }
  }
  if (result.type === 'object') {
    result.additionalProperties = false;
  }
  return result;
}

/**
 * A Zod schema as the JSON Schema subset that LLM structured outputs accept: every object closed
 * (`additionalProperties: false`), no numeric, length, pattern or array-size constraints (the
 * answer is validated with the Zod schema afterwards, which still checks them). Provider-neutral;
 * the LLM adapter sends it as the response format.
 */
export function toStructuredOutputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return stripUnsupported(z.toJSONSchema(schema, { io: 'output' })) as Record<string, unknown>;
}

/** A log type offered to the model, with the id the API maps its key back to. */
export interface CaptureRefLogType extends CaptureOutputLogType {
  id: string;
}

export interface CaptureRefs {
  logTypes: readonly CaptureRefLogType[];
  /** Task reference (`T1`) to task id. */
  tasks: ReadonlyMap<string, string>;
  /** Site reference (`S1`) to site id. */
  sites: ReadonlyMap<string, string>;
}

export interface InterpretedCapture {
  proposal: SmartCaptureProposal;
  confidence: SmartCaptureConfidence;
  /** `customFields.<key>` of values dropped because they failed the field's rule. */
  droppedFields: string[];
}

/**
 * Turns a validated model answer into the proposal the phone shows: references mapped back to
 * ids (an unknown reference becomes null), custom-field values checked one by one against their
 * definitions (a failing one is dropped and listed; a missing required field is left for the
 * worker), the text trimmed and capped, `occurredAt` defaulting to `fallbackOccurredAt`.
 */
export function interpretCaptureOutput(
  output: CaptureModelOutput,
  refs: CaptureRefs,
  fallbackOccurredAt: string,
): InterpretedCapture {
  const logType =
    output.logTypeKey === null
      ? undefined
      : refs.logTypes.find((candidate) => candidate.key === output.logTypeKey);
  // The first entry per field name wins; entries of other log types are ignored.
  const entries = new Map<string, CaptureModelField>();
  for (const entry of output.fields) {
    if (!entries.has(entry.field)) {
      entries.set(entry.field, entry);
    }
  }
  const taskId = output.taskRef === null ? null : (refs.tasks.get(output.taskRef) ?? null);
  const siteId = output.siteRef === null ? null : (refs.sites.get(output.siteRef) ?? null);

  const customFields: CustomFieldValues = {};
  const fieldConfidence: Record<string, AiConfidenceLevel> = {};
  const droppedFields: string[] = [];
  for (const field of logType?.fields ?? []) {
    const entry = logType ? entries.get(captureFieldName(logType.key, field.key)) : undefined;
    const value = entry?.value;
    if (value === null || value === undefined) {
      continue;
    }
    const checked = validateCustomFieldValues([{ ...field, required: false }], {
      [field.key]: value,
    });
    if (checked.ok && checked.values[field.key] !== undefined) {
      customFields[field.key] = checked.values[field.key] as CustomFieldValue;
      if (entry?.confidence) {
        fieldConfidence[field.key] = entry.confidence;
      }
    } else {
      droppedFields.push(`customFields.${field.key}`);
    }
  }

  const trimmed = output.text?.trim() ?? '';
  const text = trimmed === '' ? null : trimmed.slice(0, MAX_PROPOSED_TEXT_LENGTH);

  return {
    proposal: {
      logTypeId: logType?.id ?? null,
      taskId,
      siteId,
      text,
      customFields,
      occurredAt: output.occurredAt ?? fallbackOccurredAt,
    },
    confidence: {
      logType: logType ? output.logTypeConfidence : null,
      task: taskId ? output.taskConfidence : null,
      site: siteId ? output.siteConfidence : null,
      text: text ? output.textConfidence : null,
      customFields: fieldConfidence,
    },
    droppedFields,
  };
}

/**
 * The names of the proposal's fields the worker kept, changed or added when creating the log
 * (for `aiMetadata`). Names: `logTypeId`, `taskId`, `siteId`, `text`, `occurredAt`,
 * `customFields.<key>`. Values are compared as JSON.
 */
export function compareWithProposal(
  proposal: SmartCaptureProposal,
  submitted: {
    logTypeId?: string | null;
    taskId?: string | null;
    siteId?: string | null;
    text?: string | null;
    occurredAt?: string | null;
    customFields?: Record<string, unknown>;
  },
): { keptFields: string[]; changedFields: string[]; addedFields: string[] } {
  const keptFields: string[] = [];
  const changedFields: string[] = [];
  const addedFields: string[] = [];
  const compare = (name: string, proposed: unknown, actual: unknown) => {
    const hasProposed = proposed !== null && proposed !== undefined;
    const hasActual = actual !== null && actual !== undefined;
    if (!hasProposed) {
      if (hasActual) addedFields.push(name);
      return;
    }
    const same =
      name === 'occurredAt' && typeof proposed === 'string' && typeof actual === 'string'
        ? Date.parse(proposed) === Date.parse(actual)
        : JSON.stringify(proposed) === JSON.stringify(actual);
    (same ? keptFields : changedFields).push(name);
  };
  compare('logTypeId', proposal.logTypeId, submitted.logTypeId);
  compare('taskId', proposal.taskId, submitted.taskId);
  compare('siteId', proposal.siteId, submitted.siteId);
  compare('text', proposal.text, submitted.text);
  compare('occurredAt', proposal.occurredAt, submitted.occurredAt);
  const submittedFields = submitted.customFields ?? {};
  const keys = new Set([...Object.keys(proposal.customFields), ...Object.keys(submittedFields)]);
  for (const key of [...keys].sort()) {
    compare(`customFields.${key}`, proposal.customFields[key], submittedFields[key]);
  }
  return { keptFields, changedFields, addedFields };
}
