import {
  createLogTypeSchema,
  customFieldDefinitionsSchema,
  customFieldKeySchema,
  logTypeKeySchema,
  MAX_CUSTOM_FIELD_OPTIONS,
  MAX_CUSTOM_FIELDS,
  type CreateLogTypeInput,
  type CustomFieldDefinition,
  type CustomFieldDefinitionInput,
  type CustomFieldType,
  type LogType,
  type UpdateLogTypeInput,
} from '@ops/shared';

/**
 * The log-type custom-field editor (Phase 6, ADR-0003, ADR-0009). Pure state and payload logic;
 * the component in `src/components/structure/` renders it.
 *
 * Rules:
 * - the KEY of a field that is already saved never changes (values are stored under it; a
 *   "rename" would orphan them). Only new fields get a key, suggested from the label until the
 *   user types one;
 * - `options` exist for `select` only (required, unique, non-empty), never for other types;
 * - order is changed with move up / move down (buttons, keyboard accessible), not drag only;
 * - saving sends the WHOLE field list (`PATCH /log-types/:id { fields }`) and only when it
 *   differs from the stored one; the API then raises `version` by one.
 */

export interface EditorField {
  /** Stable React key inside the editor (not sent). */
  uid: string;
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  options: string[];
  helpText: string;
  /** True for a field of the stored definition: its key is locked. */
  saved: boolean;
  /** The user typed the key themself (stop suggesting it from the label). */
  keyTouched: boolean;
}

export function editorFieldsFrom(definitions: readonly CustomFieldDefinition[]): EditorField[] {
  return definitions.map((field) => ({
    uid: `saved:${field.key}`,
    key: field.key,
    label: field.label,
    type: field.type,
    required: field.required,
    options: field.type === 'select' ? [...(field.options ?? [])] : [],
    helpText: field.helpText ?? '',
    saved: true,
    keyTouched: true,
  }));
}

/** A key from a label: `Batch no.` becomes `batch_no`; unique against `taken`. */
export function suggestFieldKey(label: string, taken: ReadonlySet<string>): string {
  let base = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `field${base === '' ? '' : `_${base}`}`;
  base = base.slice(0, 60);
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
}

export type EditorAction =
  | { type: 'add'; uid: string }
  | { type: 'remove'; uid: string }
  | { type: 'move'; uid: string; delta: -1 | 1 }
  | {
      type: 'update';
      uid: string;
      patch: Partial<Pick<EditorField, 'key' | 'label' | 'type' | 'required' | 'helpText'>>;
    }
  | { type: 'addOption'; uid: string }
  | { type: 'updateOption'; uid: string; index: number; value: string }
  | { type: 'removeOption'; uid: string; index: number }
  | { type: 'moveOption'; uid: string; index: number; delta: -1 | 1 }
  | { type: 'reset'; fields: EditorField[] };

function move<Item>(list: readonly Item[], index: number, delta: -1 | 1): Item[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as Item);
  return next;
}

function keysExcept(fields: readonly EditorField[], uid: string): Set<string> {
  return new Set(fields.filter((field) => field.uid !== uid).map((field) => field.key));
}

export function editorReducer(fields: EditorField[], action: EditorAction): EditorField[] {
  switch (action.type) {
    case 'reset':
      return action.fields;
    case 'add': {
      if (fields.length >= MAX_CUSTOM_FIELDS) return fields;
      const taken = new Set(fields.map((field) => field.key));
      return [
        ...fields,
        {
          uid: action.uid,
          key: suggestFieldKey('', taken),
          label: '',
          type: 'text',
          required: false,
          options: [],
          helpText: '',
          saved: false,
          keyTouched: false,
        },
      ];
    }
    case 'remove':
      return fields.filter((field) => field.uid !== action.uid);
    case 'move':
      return move(
        fields,
        fields.findIndex((field) => field.uid === action.uid),
        action.delta,
      );
    case 'update':
      return fields.map((field) => {
        if (field.uid !== action.uid) return field;
        const { key, ...rest } = action.patch;
        const next: EditorField = { ...field, ...rest };
        // A saved field's key is immutable: a key in the patch is ignored.
        if (!field.saved) {
          if (key !== undefined) {
            next.key = key.trim().toLowerCase();
            next.keyTouched = true;
          } else if (rest.label !== undefined && !field.keyTouched) {
            next.key = suggestFieldKey(rest.label, keysExcept(fields, field.uid));
          }
        }
        if (rest.type !== undefined && rest.type !== field.type) {
          next.options =
            rest.type === 'select' ? (field.options.length > 0 ? field.options : ['']) : [];
        }
        return next;
      });
    case 'addOption':
      return fields.map((field) =>
        field.uid === action.uid && field.options.length < MAX_CUSTOM_FIELD_OPTIONS
          ? { ...field, options: [...field.options, ''] }
          : field,
      );
    case 'updateOption':
      return fields.map((field) =>
        field.uid === action.uid
          ? {
              ...field,
              options: field.options.map((option, index) =>
                index === action.index ? action.value : option,
              ),
            }
          : field,
      );
    case 'removeOption':
      return fields.map((field) =>
        field.uid === action.uid
          ? { ...field, options: field.options.filter((_, index) => index !== action.index) }
          : field,
      );
    case 'moveOption':
      return fields.map((field) =>
        field.uid === action.uid
          ? { ...field, options: move(field.options, action.index, action.delta) }
          : field,
      );
  }
}

/** The definitions to send: trimmed, `options` only on select, `helpText` only when written. */
export function editorPayload(fields: readonly EditorField[]): CustomFieldDefinitionInput[] {
  return fields.map((field) => {
    const helpText = field.helpText.trim();
    return {
      key: field.key,
      label: field.label.trim(),
      type: field.type,
      required: field.required,
      ...(field.type === 'select' ? { options: field.options.map((option) => option.trim()) } : {}),
      ...(helpText === '' ? {} : { helpText }),
    };
  });
}

export type FieldErrorCode =
  | 'keyFormat'
  | 'keyDuplicate'
  | 'keyReused'
  | 'labelRequired'
  | 'optionsRequired'
  | 'optionEmpty'
  | 'optionsUnique'
  | 'invalid';

export interface FieldErrors {
  key?: FieldErrorCode;
  label?: FieldErrorCode;
  options?: FieldErrorCode;
  other?: FieldErrorCode;
}

/**
 * Problems per field uid; empty when the list can be saved. Mirrors the shared schema.
 *
 * `savedKeys`: every key of the stored definition (`logType.fields`), including fields removed in
 * this edit. A NEW field may not take one of them: old logs keep their values under that key, so
 * reusing it would give those values a different meaning (ADR-0003, ADR-0009).
 */
export function validateEditorFields(
  fields: readonly EditorField[],
  savedKeys: ReadonlySet<string> = new Set(),
): Record<string, FieldErrors> {
  const errors: Record<string, FieldErrors> = {};
  const seen = new Map<string, number>();
  for (const field of fields) seen.set(field.key, (seen.get(field.key) ?? 0) + 1);
  for (const field of fields) {
    const own: FieldErrors = {};
    if (!field.saved && !customFieldKeySchema.safeParse(field.key).success) own.key = 'keyFormat';
    else if ((seen.get(field.key) ?? 0) > 1) own.key = 'keyDuplicate';
    else if (!field.saved && savedKeys.has(field.key)) own.key = 'keyReused';
    if (field.label.trim() === '') own.label = 'labelRequired';
    if (field.type === 'select') {
      const options = field.options.map((option) => option.trim());
      if (options.length === 0) own.options = 'optionsRequired';
      else if (options.some((option) => option === '')) own.options = 'optionEmpty';
      else if (new Set(options).size !== options.length) own.options = 'optionsUnique';
    }
    if (Object.keys(own).length > 0) errors[field.uid] = own;
  }
  if (Object.keys(errors).length === 0) {
    // The shared schema is the final word (lengths, limits).
    const parsed = customFieldDefinitionsSchema.safeParse(editorPayload(fields));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const index = typeof issue.path[0] === 'number' ? issue.path[0] : -1;
        const field = fields[index];
        if (field) errors[field.uid] = { ...errors[field.uid], other: 'invalid' };
      }
    }
  }
  return errors;
}

function normalised(definitions: readonly CustomFieldDefinitionInput[]): string {
  return JSON.stringify(
    definitions.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required ?? false,
      options: field.type === 'select' ? (field.options ?? []) : null,
      helpText: field.helpText?.trim() ? field.helpText.trim() : null,
    })),
  );
}

/** True when saving would change the stored definition (and so raise the version). */
export function fieldsChanged(
  stored: readonly CustomFieldDefinition[],
  payload: readonly CustomFieldDefinitionInput[],
): boolean {
  return normalised(stored) !== normalised(payload);
}

/** Keys of saved fields that the editor removes (their values stay on older logs). */
export function removedFieldKeys(
  stored: readonly CustomFieldDefinition[],
  fields: readonly EditorField[],
): string[] {
  const kept = new Set(fields.map((field) => field.key));
  return stored.map((field) => field.key).filter((key) => !kept.has(key));
}

export interface LogTypeFormState {
  key: string;
  name: string;
  description: string;
}

export type LogTypeBody<Body> =
  | { ok: true; body: Body }
  | { ok: false; errors: Record<string, string>; fieldErrors: Record<string, FieldErrors> };

/** `POST /log-types`: key, name, description and the field list (version 1). */
export function createLogTypeBody(
  form: LogTypeFormState,
  fields: readonly EditorField[],
): LogTypeBody<CreateLogTypeInput> {
  const fieldErrors = validateEditorFields(fields);
  const errors: Record<string, string> = {};
  if (!logTypeKeySchema.safeParse(form.key.trim()).success) errors.key = 'keyFormat';
  if (form.name.trim() === '') errors.name = 'required';
  if (Object.keys(errors).length > 0 || Object.keys(fieldErrors).length > 0) {
    return { ok: false, errors, fieldErrors };
  }
  const description = form.description.trim();
  const body: CreateLogTypeInput = {
    key: form.key.trim(),
    name: form.name.trim(),
    ...(description === '' ? {} : { description }),
    fields: editorPayload(fields),
  };
  const parsed = createLogTypeSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: { form: 'invalid' }, fieldErrors };
}

/**
 * `PATCH /log-types/:id`: name and description when changed, and `fields` only when the list
 * differs from the stored one (so a name change does not raise the version). Null when nothing
 * changed. The key is never sent (immutable).
 */
export function updateLogTypeBody(
  logType: LogType,
  form: Pick<LogTypeFormState, 'name' | 'description'>,
  fields: readonly EditorField[],
): LogTypeBody<UpdateLogTypeInput | null> {
  const storedKeys = new Set(logType.fields.map((field) => field.key));
  const fieldErrors = validateEditorFields(fields, storedKeys);
  const errors: Record<string, string> = {};
  if (form.name.trim() === '') errors.name = 'required';
  // Defence in depth: a saved key must still be there unchanged or removed, never edited.
  for (const field of fields) {
    if (field.saved && !storedKeys.has(field.key)) errors.form = 'invalid';
  }
  if (Object.keys(errors).length > 0 || Object.keys(fieldErrors).length > 0) {
    return { ok: false, errors, fieldErrors };
  }
  const body: UpdateLogTypeInput = {};
  const name = form.name.trim();
  if (name !== logType.name) body.name = name;
  const description = form.description.trim() === '' ? null : form.description.trim();
  if (description !== logType.description) body.description = description;
  const payload = editorPayload(fields);
  if (fieldsChanged(logType.fields, payload)) body.fields = payload;
  return { ok: true, body: Object.keys(body).length === 0 ? null : body };
}

/** The version the log type will have after saving `body`. */
export function versionAfterSave(
  logType: Pick<LogType, 'version'>,
  body: UpdateLogTypeInput | null,
): number {
  return body?.fields !== undefined ? logType.version + 1 : logType.version;
}
