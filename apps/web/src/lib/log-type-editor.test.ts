import type { LogType } from '@ops/shared';
import { describe, expect, it } from 'vitest';

import { IDS } from './__fixtures__/agent-c-fixtures';
import {
  createLogTypeBody,
  editorFieldsFrom,
  editorPayload,
  editorReducer,
  removedFieldKeys,
  suggestFieldKey,
  updateLogTypeBody,
  validateEditorFields,
  versionAfterSave,
  type EditorField,
} from './log-type-editor';

const LOG_TYPE: LogType = {
  id: '0190f3a2-7c1e-7000-8000-000000000300',
  organizationId: IDS.org,
  key: 'inspection',
  name: 'Inspection',
  description: null,
  fields: [
    { key: 'depth_cm', label: 'Depth', type: 'number', required: true },
    { key: 'surface', label: 'Surface', type: 'select', required: false, options: ['Wet', 'Dry'] },
  ],
  version: 4,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  archivedAt: null,
};

function apply(fields: EditorField[], ...actions: Parameters<typeof editorReducer>[1][]) {
  return actions.reduce(editorReducer, fields);
}

describe('custom-field editor', () => {
  it('adds a field and suggests its key from the label until the key is typed', () => {
    let fields = apply(editorFieldsFrom(LOG_TYPE.fields), { type: 'add', uid: 'n1' });
    expect(fields).toHaveLength(3);
    fields = apply(fields, { type: 'update', uid: 'n1', patch: { label: 'Batch no.' } });
    expect(fields[2]?.key).toBe('batch_no');
    fields = apply(
      fields,
      { type: 'update', uid: 'n1', patch: { key: 'lot' } },
      { type: 'update', uid: 'n1', patch: { label: 'Lot number' } },
    );
    expect(fields[2]?.key).toBe('lot');
    expect(suggestFieldKey('Depth', new Set(['depth']))).toBe('depth_2');
    expect(suggestFieldKey('123', new Set())).toBe('field_123');
  });

  it('never changes the key of a saved field', () => {
    const fields = apply(editorFieldsFrom(LOG_TYPE.fields), {
      type: 'update',
      uid: 'saved:depth_cm',
      patch: { key: 'depth', label: 'Depth (cm)' },
    });
    expect(fields[0]).toMatchObject({ key: 'depth_cm', label: 'Depth (cm)', saved: true });
  });

  it('reorders with move up / down and ignores moves past the ends', () => {
    const start = editorFieldsFrom(LOG_TYPE.fields);
    const moved = apply(start, { type: 'move', uid: 'saved:surface', delta: -1 });
    expect(moved.map((field) => field.key)).toEqual(['surface', 'depth_cm']);
    expect(
      apply(moved, { type: 'move', uid: 'saved:surface', delta: -1 }).map((f) => f.key),
    ).toEqual(['surface', 'depth_cm']);
  });

  it('removes fields and reports their keys', () => {
    const fields = apply(editorFieldsFrom(LOG_TYPE.fields), {
      type: 'remove',
      uid: 'saved:surface',
    });
    expect(fields.map((field) => field.key)).toEqual(['depth_cm']);
    expect(removedFieldKeys(LOG_TYPE.fields, fields)).toEqual(['surface']);
  });

  it('handles options only for select fields', () => {
    let fields = apply(
      editorFieldsFrom([]),
      { type: 'add', uid: 'n1' },
      { type: 'update', uid: 'n1', patch: { label: 'Colour', type: 'select' } },
    );
    expect(fields[0]?.options).toEqual(['']);
    expect(validateEditorFields(fields)).toEqual({ n1: { options: 'optionEmpty' } });
    fields = apply(
      fields,
      { type: 'updateOption', uid: 'n1', index: 0, value: 'Red' },
      { type: 'addOption', uid: 'n1' },
      { type: 'updateOption', uid: 'n1', index: 1, value: 'Red' },
    );
    expect(validateEditorFields(fields)).toEqual({ n1: { options: 'optionsUnique' } });
    fields = apply(
      fields,
      { type: 'updateOption', uid: 'n1', index: 1, value: 'Blue' },
      { type: 'moveOption', uid: 'n1', index: 1, delta: -1 },
    );
    expect(fields[0]?.options).toEqual(['Blue', 'Red']);
    expect(validateEditorFields(fields)).toEqual({});
    const text = apply(fields, { type: 'update', uid: 'n1', patch: { type: 'text' } });
    expect(editorPayload(text)[0]).not.toHaveProperty('options');
  });

  it('flags missing labels, bad and duplicate keys', () => {
    const fields = apply(
      editorFieldsFrom(LOG_TYPE.fields),
      { type: 'add', uid: 'n1' },
      { type: 'update', uid: 'n1', patch: { key: 'Depth CM' } },
      { type: 'add', uid: 'n2' },
      { type: 'update', uid: 'n2', patch: { label: 'Again', key: 'surface' } },
    );
    expect(validateEditorFields(fields)).toEqual({
      n1: { key: 'keyFormat', label: 'labelRequired' },
      n2: { key: 'keyDuplicate' },
      'saved:surface': { key: 'keyDuplicate' },
    });
  });
});

describe('the request the editor sends', () => {
  it('sends the whole field list (required flag, options) and expects the next version', () => {
    const fields = apply(
      editorFieldsFrom(LOG_TYPE.fields),
      { type: 'update', uid: 'saved:surface', patch: { required: true } },
      { type: 'add', uid: 'n1' },
      { type: 'update', uid: 'n1', patch: { label: 'Notes', helpText: '  Anything odd  ' } },
    );
    const result = updateLogTypeBody(LOG_TYPE, { name: 'Inspection', description: '' }, fields);
    expect(result).toEqual({
      ok: true,
      body: {
        fields: [
          { key: 'depth_cm', label: 'Depth', type: 'number', required: true },
          {
            key: 'surface',
            label: 'Surface',
            type: 'select',
            required: true,
            options: ['Wet', 'Dry'],
          },
          { key: 'notes', label: 'Notes', type: 'text', required: false, helpText: 'Anything odd' },
        ],
      },
    });
    expect(result.ok && versionAfterSave(LOG_TYPE, result.body)).toBe(5);
  });

  it('does not send fields (no version bump) when only the name changes, and nothing when unchanged', () => {
    const fields = editorFieldsFrom(LOG_TYPE.fields);
    const renamed = updateLogTypeBody(
      LOG_TYPE,
      { name: 'Site inspection', description: '' },
      fields,
    );
    expect(renamed).toEqual({ ok: true, body: { name: 'Site inspection' } });
    expect(renamed.ok && versionAfterSave(LOG_TYPE, renamed.body)).toBe(4);
    expect(updateLogTypeBody(LOG_TYPE, { name: 'Inspection', description: '' }, fields)).toEqual({
      ok: true,
      body: null,
    });
  });

  it('refuses a saved field whose key was altered outside the reducer', () => {
    const fields = editorFieldsFrom(LOG_TYPE.fields).map((field) =>
      field.key === 'depth_cm' ? { ...field, key: 'depth' } : field,
    );
    const result = updateLogTypeBody(LOG_TYPE, { name: 'Inspection', description: '' }, fields);
    expect(result.ok).toBe(false);
  });

  it('creates a log type with a valid key', () => {
    const fields = apply(
      editorFieldsFrom([]),
      { type: 'add', uid: 'n1' },
      { type: 'update', uid: 'n1', patch: { label: 'Count', type: 'number' } },
    );
    expect(
      createLogTypeBody({ key: 'delivery', name: 'Delivery', description: '' }, fields),
    ).toEqual({
      ok: true,
      body: {
        key: 'delivery',
        name: 'Delivery',
        fields: [{ key: 'count', label: 'Count', type: 'number', required: false }],
      },
    });
    expect(createLogTypeBody({ key: 'Bad Key', name: '', description: '' }, []).ok).toBe(false);
  });
});

describe('reusing the key of a saved field', () => {
  it('refuses a new field that takes the key of a field removed in this edit', () => {
    const fields = apply(
      editorFieldsFrom(LOG_TYPE.fields),
      { type: 'remove', uid: 'saved:surface' },
      { type: 'add', uid: 'n1' },
      { type: 'update', uid: 'n1', patch: { key: 'surface', label: 'Surface again' } },
    );
    const result = updateLogTypeBody(LOG_TYPE, { name: 'Inspection', description: '' }, fields);
    expect(result).toMatchObject({ ok: false, fieldErrors: { n1: { key: 'keyReused' } } });
    expect(validateEditorFields(fields, new Set(['depth_cm', 'surface']))).toEqual({
      n1: { key: 'keyReused' },
    });
  });

  it('still accepts a new field with a key that was never saved', () => {
    const fields = apply(
      editorFieldsFrom(LOG_TYPE.fields),
      { type: 'remove', uid: 'saved:surface' },
      { type: 'add', uid: 'n1' },
      { type: 'update', uid: 'n1', patch: { key: 'surface_v2', label: 'Surface' } },
    );
    expect(updateLogTypeBody(LOG_TYPE, { name: 'Inspection', description: '' }, fields).ok).toBe(
      true,
    );
  });
});
