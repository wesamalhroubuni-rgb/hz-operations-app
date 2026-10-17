import { describe, expect, it } from 'vitest';
import {
  customFieldDefinitionsSchema,
  MAX_CUSTOM_FIELD_TEXT_LENGTH,
  validateCustomFieldValues,
  type CustomFieldDefinition,
} from '../domain/custom-fields.js';
import {
  customFieldDescriptors,
  customFieldErrorCode,
  customFieldFormToValues,
  initialCustomFieldValues,
  parseFormNumber,
  reconcileCustomFieldValues,
  splitErrorDetails,
} from './custom-field-form.js';

const definitions: CustomFieldDefinition[] = customFieldDefinitionsSchema.parse([
  { key: 'area', label: 'Area', type: 'text', required: true, helpText: '  Where  ' },
  { key: 'quantity', label: 'Quantity', type: 'number', required: true },
  { key: 'passed', label: 'Passed', type: 'boolean' },
  { key: 'result', label: 'Result', type: 'select', options: ['ok', 'defect'] },
  { key: 'next_check', label: 'Next check', type: 'date' },
]);

const optionalOnly: CustomFieldDefinition[] = customFieldDefinitionsSchema.parse([
  { key: 'note', label: 'Note', type: 'text' },
  { key: 'count', label: 'Count', type: 'number' },
  { key: 'ok', label: 'OK', type: 'boolean' },
  { key: 'pick', label: 'Pick', type: 'select', options: ['a', 'b'] },
  { key: 'day', label: 'Day', type: 'date' },
]);

const requiredOnly: CustomFieldDefinition[] = customFieldDefinitionsSchema.parse([
  { key: 'note', label: 'Note', type: 'text', required: true },
  { key: 'count', label: 'Count', type: 'number', required: true },
  { key: 'ok', label: 'OK', type: 'boolean', required: true },
  { key: 'pick', label: 'Pick', type: 'select', options: ['a', 'b'], required: true },
  { key: 'day', label: 'Day', type: 'date', required: true },
]);

describe('customFieldDescriptors', () => {
  it('describes every field in order with the input to render', () => {
    const descriptors = customFieldDescriptors(definitions);
    expect(descriptors.map((field) => [field.key, field.input, field.required])).toEqual([
      ['area', 'text', true],
      ['quantity', 'number', true],
      ['passed', 'yesNo', false],
      ['result', 'choice', false],
      ['next_check', 'date', false],
    ]);
    expect(descriptors[0]?.helpText).toBe('Where');
    expect(descriptors[1]?.helpText).toBeNull();
    expect(descriptors[3]?.options).toEqual(['ok', 'defect']);
    expect(descriptors[0]?.options).toEqual([]);
  });

  it('returns nothing for a log type without fields', () => {
    expect(customFieldDescriptors([])).toEqual([]);
  });
});

describe('initialCustomFieldValues', () => {
  it('starts empty, with booleans unanswered', () => {
    expect(initialCustomFieldValues(definitions)).toEqual({
      area: '',
      quantity: '',
      passed: null,
      result: '',
      next_check: '',
    });
  });

  it('fills the form from a stored log and drops keys the type no longer has', () => {
    expect(
      initialCustomFieldValues(definitions, {
        area: 'North',
        quantity: 12.5,
        passed: false,
        result: 'defect',
        next_check: '2026-11-01T09:00:00Z',
        removed: 'x',
      }),
    ).toEqual({
      area: 'North',
      quantity: '12.5',
      passed: false,
      result: 'defect',
      next_check: '2026-11-01',
    });
  });

  it('treats a stored value of the wrong type as empty', () => {
    expect(
      initialCustomFieldValues(definitions, { quantity: 'many', passed: 'yes' }),
    ).toMatchObject({ quantity: '', passed: null });
  });
});

describe('reconcileCustomFieldValues', () => {
  it('keeps values of fields that still exist and adds new fields empty', () => {
    expect(
      reconcileCustomFieldValues(definitions, {
        area: 'Hall',
        passed: true,
        gone: 'x',
        quantity: 3,
      }),
    ).toEqual({ area: 'Hall', quantity: '', passed: true, result: '', next_check: '' });
  });
});

describe('parseFormNumber', () => {
  it.each([
    ['12', 12],
    [' 12.5 ', 12.5],
    ['12,5', 12.5],
    ['-3', -3],
    ['.5', 0.5],
    ['1e3', 1000],
    ['1 000', 1000],
  ])('reads %p as %p', (text, expected) => {
    expect(parseFormNumber(text)).toBe(expected);
  });

  it.each(['', '  ', 'abc', '1.2.3', '1,2.3', '12kg', 'Infinity', 'NaN', '--1'])(
    'refuses %p',
    (text) => {
      expect(parseFormNumber(text)).toBeNull();
    },
  );
});

describe('customFieldFormToValues', () => {
  it('converts a complete form into stored values', () => {
    const result = customFieldFormToValues(definitions, {
      area: ' North hall ',
      quantity: '12,5',
      passed: true,
      result: 'ok',
      next_check: '2026-11-01',
    });
    expect(result).toEqual({
      ok: true,
      values: {
        area: ' North hall ',
        quantity: 12.5,
        passed: true,
        result: 'ok',
        next_check: '2026-11-01',
      },
    });
  });

  it('leaves empty optional fields out', () => {
    expect(customFieldFormToValues(optionalOnly, initialCustomFieldValues(optionalOnly))).toEqual({
      ok: true,
      values: {},
    });
  });

  it('keeps an explicit "no" of an optional boolean', () => {
    expect(customFieldFormToValues(optionalOnly, { ok: false })).toEqual({
      ok: true,
      values: { ok: false },
    });
  });

  it('reports every missing required field, whatever its type', () => {
    const result = customFieldFormToValues(requiredOnly, initialCustomFieldValues(requiredOnly));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(['count', 'day', 'note', 'ok', 'pick']);
    expect(Object.values(result.errors).every((error) => error.code === 'required')).toBe(true);
  });

  it('treats a blank required text as missing', () => {
    const result = customFieldFormToValues(requiredOnly, {
      note: '   ',
      count: '1',
      ok: false,
      pick: 'a',
      day: '2026-10-16',
    });
    expect(result).toEqual({
      ok: false,
      errors: { note: { code: 'required', message: 'is required' } },
    });
  });

  it('refuses a number it cannot read', () => {
    const result = customFieldFormToValues(optionalOnly, { count: '12 pcs' });
    expect(result).toEqual({
      ok: false,
      errors: { count: { code: 'number', message: 'must be a number' } },
    });
  });

  it('refuses a choice that is not an option', () => {
    const result = customFieldFormToValues(optionalOnly, { pick: 'c' });
    expect(result.ok === false && result.errors.pick?.code).toBe('option');
  });

  it('refuses a date that is not an ISO date', () => {
    const result = customFieldFormToValues(optionalOnly, { day: '16/10/2026' });
    expect(result.ok === false && result.errors.day?.code).toBe('date');
  });

  it('refuses a text longer than the limit', () => {
    const result = customFieldFormToValues(optionalOnly, {
      note: 'x'.repeat(MAX_CUSTOM_FIELD_TEXT_LENGTH + 1),
    });
    expect(result.ok === false && result.errors.note?.code).toBe('tooLong');
  });

  it('ignores form keys that are not fields of the log type', () => {
    expect(customFieldFormToValues(optionalOnly, { stray: 'x' })).toEqual({
      ok: true,
      values: {},
    });
  });

  it('reports a bad number and a missing field together', () => {
    const result = customFieldFormToValues(definitions, { area: '', quantity: 'abc' });
    expect(result).toEqual({
      ok: false,
      errors: {
        area: { code: 'required', message: 'is required' },
        quantity: { code: 'number', message: 'must be a number' },
      },
    });
  });
});

describe('every field type, required and optional (Phase 4 coverage)', () => {
  const complete = { note: 'n', count: '1', ok: true, pick: 'a', day: '2026-10-16' };

  describe('number', () => {
    it.each([
      ['a comma decimal', '0,5', 0.5],
      ['a negative comma decimal', '-12,75', -12.75],
      ['spaces around and inside', ' 1 250 ', 1250],
      ['zero', '0', 0],
    ])('reads %s', (_name, typed, stored) => {
      expect(customFieldFormToValues(optionalOnly, { count: typed })).toEqual({
        ok: true,
        values: { count: stored },
      });
    });

    it.each(['NaN', 'Infinity', '-Infinity', '1e400', '0x10', '12,5,0', '1.234,5', '½'])(
      'refuses %p with the number code, also when the field is optional',
      (typed) => {
        expect(customFieldFormToValues(optionalOnly, { count: typed })).toEqual({
          ok: false,
          errors: { count: { code: 'number', message: 'must be a number' } },
        });
      },
    );

    it('treats an empty or blank number as no value: absent when optional, required when required', () => {
      expect(customFieldFormToValues(optionalOnly, { count: '  ' })).toEqual({
        ok: true,
        values: {},
      });
      const result = customFieldFormToValues(requiredOnly, { ...complete, count: ' ' });
      expect(result).toEqual({
        ok: false,
        errors: { count: { code: 'required', message: 'is required' } },
      });
    });

    // Doubtful (reported): "1,000" typed as one thousand is read as 1 (the comma is taken as a
    // decimal separator whenever there is no dot).
    it('reads "1,000" as 1 (comma as decimal separator)', () => {
      expect(parseFormNumber('1,000')).toBe(1);
    });
  });

  describe('boolean', () => {
    it('unanswered (null) is no value; false is an answer', () => {
      expect(customFieldFormToValues(optionalOnly, { ok: null })).toEqual({ ok: true, values: {} });
      expect(customFieldFormToValues(requiredOnly, { ...complete, ok: false })).toEqual({
        ok: true,
        values: { note: 'n', count: 1, ok: false, pick: 'a', day: '2026-10-16' },
      });
      expect(customFieldFormToValues(requiredOnly, { ...complete, ok: null })).toEqual({
        ok: false,
        errors: { ok: { code: 'required', message: 'is required' } },
      });
    });

    it('ignores a text in a yes/no field (a stale draft) instead of sending it', () => {
      expect(customFieldFormToValues(optionalOnly, { ok: 'true' })).toEqual({
        ok: true,
        values: {},
      });
      const required = customFieldFormToValues(requiredOnly, { ...complete, ok: 'yes' });
      expect(required.ok === false && required.errors.ok?.code).toBe('required');
    });
  });

  describe('select', () => {
    const many = customFieldDefinitionsSchema.parse([
      {
        key: 'weather',
        label: 'Weather',
        type: 'select',
        options: ['sun', 'cloud', 'rain', 'snow', 'wind'],
        required: true,
      },
      { key: 'shift', label: 'Shift', type: 'select', options: ['day', 'night'] },
    ]);

    it('describes few and many options alike, in the defined order, as a copy', () => {
      const descriptors = customFieldDescriptors(many);
      expect(descriptors.map((field) => [field.input, field.options.length])).toEqual([
        ['choice', 5],
        ['choice', 2],
      ]);
      expect(descriptors[0]?.options).toEqual(['sun', 'cloud', 'rain', 'snow', 'wind']);
      expect(descriptors[0]?.options).not.toBe(many[0]?.options);
    });

    it('accepts any defined option, also beyond the fourth, and refuses a value not in the options', () => {
      expect(customFieldFormToValues(many, { weather: 'wind' })).toEqual({
        ok: true,
        values: { weather: 'wind' },
      });
      for (const value of ['WIND', ' wind ', 'hail', 'day']) {
        const result = customFieldFormToValues(many, { weather: value });
        // Surrounding spaces are trimmed (a select is exact otherwise).
        if (value === ' wind ') {
          expect(result).toEqual({ ok: true, values: { weather: 'wind' } });
        } else {
          expect([value, result.ok === false && result.errors.weather?.code]).toEqual([
            value,
            'option',
          ]);
        }
      }
      expect(customFieldFormToValues(many, { weather: 'sun', shift: '' })).toEqual({
        ok: true,
        values: { weather: 'sun' },
      });
    });
  });

  describe('date', () => {
    it.each([
      ['a calendar date', '2026-02-28', true],
      ['a leap day', '2028-02-29', true],
      ['a datetime with an offset', '2026-10-16T08:00:00+03:00', true],
      ['a datetime in UTC', '2026-10-16T08:00:00Z', true],
      ['a day that does not exist', '2026-02-30', false],
      ['a datetime without an offset', '2026-10-16T08:00:00', false],
      ['a local format', '16.10.2026', false],
      ['a month only', '2026-10', false],
    ])('%s (%s): accepted %s', (_name, typed, accepted) => {
      const result = customFieldFormToValues(optionalOnly, { day: typed });
      expect(result.ok).toBe(accepted);
      if (!result.ok) expect(result.errors.day?.code).toBe('date');
    });

    it('shows a stored datetime as its calendar date when the log is edited', () => {
      expect(initialCustomFieldValues(optionalOnly, { day: '2026-10-16T23:30:00+03:00' }).day).toBe(
        '2026-10-16',
      );
    });
  });

  describe('text', () => {
    it('keeps the inner and outer spaces of a filled text; a blank optional text is no value', () => {
      expect(customFieldFormToValues(optionalOnly, { note: '  a  b ' })).toEqual({
        ok: true,
        values: { note: '  a  b ' },
      });
      expect(customFieldFormToValues(optionalOnly, { note: '\n\t ' })).toEqual({
        ok: true,
        values: {},
      });
    });

    it('accepts exactly the maximum length', () => {
      expect(
        customFieldFormToValues(optionalOnly, { note: 'x'.repeat(MAX_CUSTOM_FIELD_TEXT_LENGTH) })
          .ok,
      ).toBe(true);
    });
  });

  it('every value the form produces passes the validator the API runs (round trip)', () => {
    const forms = [
      { note: 'Hall', count: '3,5', ok: false, pick: 'b', day: '2026-01-31' },
      { note: ' x ', count: '-0', ok: true, pick: 'a', day: '2026-10-16T08:00:00Z' },
      initialCustomFieldValues(optionalOnly),
    ];
    for (const form of forms) {
      const result = customFieldFormToValues(optionalOnly, form);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(validateCustomFieldValues(optionalOnly, result.values)).toEqual(result);
      }
    }
  });
});

describe('initial values and descriptors from a log type', () => {
  it('starts every field of the type, in order, even fields the stored log never had', () => {
    expect(Object.keys(initialCustomFieldValues(requiredOnly, { count: 4 }))).toEqual([
      'note',
      'count',
      'ok',
      'pick',
      'day',
    ]);
  });

  it('treats a number stored as NaN or Infinity (corrupt row) as empty', () => {
    expect(initialCustomFieldValues(optionalOnly, { count: Number.NaN, note: 12 })).toMatchObject({
      count: '',
      note: '',
    });
    expect(initialCustomFieldValues(optionalOnly, { count: Infinity }).count).toBe('');
  });

  it('marks required fields and drops a blank help text', () => {
    const [first] = customFieldDescriptors(
      customFieldDefinitionsSchema.parse([
        { key: 'a', label: 'A', type: 'text', required: true, helpText: '   ' },
      ]),
    );
    expect(first).toMatchObject({ required: true, helpText: null, options: [] });
  });
});

describe('reconciling a draft after the log type changed', () => {
  const before = customFieldDefinitionsSchema.parse([
    { key: 'area', label: 'Area', type: 'text', required: true },
    { key: 'count', label: 'Count', type: 'number' },
    { key: 'ok', label: 'OK', type: 'boolean' },
    { key: 'pick', label: 'Pick', type: 'select', options: ['a', 'b', 'c'] },
    { key: 'gone', label: 'Gone', type: 'text' },
  ]);
  const draft = initialCustomFieldValues(before, {
    area: 'Hall',
    count: 7,
    ok: true,
    pick: 'c',
    gone: 'x',
  });

  it('drops a removed field, so it is never sent', () => {
    const after = before.filter((field) => field.key !== 'gone');
    const reconciled = reconcileCustomFieldValues(after, draft);
    expect(reconciled).not.toHaveProperty('gone');
    expect(customFieldFormToValues(after, reconciled)).toEqual({
      ok: true,
      values: { area: 'Hall', count: 7, ok: true, pick: 'c' },
    });
  });

  it('a changed type keeps text-to-text values and resets the rest', () => {
    const after = customFieldDefinitionsSchema.parse([
      { key: 'area', label: 'Area', type: 'number', required: true }, // text -> number
      { key: 'count', label: 'Count', type: 'text' }, // number (as text) -> text
      { key: 'ok', label: 'OK', type: 'text' }, // boolean -> text
      { key: 'pick', label: 'Pick', type: 'boolean' }, // select -> boolean
    ]);
    const reconciled = reconcileCustomFieldValues(after, draft);
    expect(reconciled).toEqual({ area: 'Hall', count: '7', ok: '', pick: null });
    // "Hall" is no number: the phone says so before sending.
    expect(customFieldFormToValues(after, reconciled)).toEqual({
      ok: false,
      errors: { area: { code: 'number', message: 'must be a number' } },
    });
  });

  it('keeps a select value an option was removed from, and refuses it on save (never sent silently)', () => {
    const after = customFieldDefinitionsSchema.parse([
      ...before.filter((field) => field.key !== 'pick'),
      { key: 'pick', label: 'Pick', type: 'select', options: ['a', 'b'] },
    ]);
    const reconciled = reconcileCustomFieldValues(after, draft);
    expect(reconciled.pick).toBe('c');
    const result = customFieldFormToValues(after, reconciled);
    expect(result.ok === false && result.errors.pick?.code).toBe('option');
  });

  it('adds a new required field empty and asks for it', () => {
    const after = customFieldDefinitionsSchema.parse([
      ...before,
      { key: 'shift', label: 'Shift', type: 'select', options: ['day', 'night'], required: true },
      { key: 'checked', label: 'Checked', type: 'boolean', required: true },
    ]);
    const reconciled = reconcileCustomFieldValues(after, draft);
    expect(reconciled).toMatchObject({ shift: '', checked: null });
    const result = customFieldFormToValues(after, reconciled);
    expect(result.ok === false && Object.keys(result.errors).sort()).toEqual(['checked', 'shift']);
  });
});

describe('server errors land on the right field', () => {
  it('maps the API 400 details of a work log (customFields.<key>) to field codes and keeps the rest', () => {
    const fromApi = [
      { path: 'customFields.area', message: 'is required' },
      { path: 'customFields.count', message: 'must be a number' },
      { path: 'customFields.pick', message: 'must be one of: a, b' },
      {
        path: 'customFields.day',
        message: 'must be an ISO date (YYYY-MM-DD) or an ISO datetime with an offset',
      },
      { path: 'customFields.ok', message: 'must be true or false' },
      { path: 'customFields.gone', message: 'is not a field of this log type' },
      { path: 'customFields', message: 'must be an object' },
      { path: 'logTypeId', message: 'does not exist' },
    ];
    const { customFields, other } = splitErrorDetails(fromApi);
    expect(
      Object.fromEntries(Object.entries(customFields).map(([key, error]) => [key, error.code])),
    ).toEqual({
      area: 'required',
      count: 'number',
      pick: 'option',
      day: 'date',
      ok: 'boolean',
      gone: 'unknownField',
    });
    expect(other).toEqual({ customFields: 'must be an object', logTypeId: 'does not exist' });
  });

  it('gives the same codes as the phone for the same mistakes', () => {
    const phone = customFieldFormToValues(requiredOnly, {
      note: '',
      count: 'x',
      ok: null,
      pick: 'z',
      day: 'no',
    });
    const server = validateCustomFieldValues(requiredOnly, { count: 'x', pick: 'z', day: 'no' });
    expect(server.ok).toBe(false);
    if (phone.ok || server.ok) return;
    const serverCodes = splitErrorDetails(server.issues).customFields;
    expect(Object.keys(serverCodes).sort()).toEqual(Object.keys(phone.errors).sort());
    for (const [key, error] of Object.entries(phone.errors)) {
      expect([key, serverCodes[key]?.code]).toEqual([key, error.code]);
    }
  });
});

describe('customFieldErrorCode', () => {
  it.each([
    ['is required', 'required'],
    ['must be a number', 'number'],
    ['must be at most 2000 characters', 'tooLong'],
    ['must be one of: a, b', 'option'],
    ['must be an ISO date (YYYY-MM-DD) or an ISO datetime with an offset', 'date'],
    ['must be true or false', 'boolean'],
    ['must be text', 'text'],
    ['is not a field of this log type', 'unknownField'],
    ['something new', 'invalid'],
  ] as const)('maps %p to %p', (message, code) => {
    expect(customFieldErrorCode(message)).toBe(code);
  });
});

describe('splitErrorDetails', () => {
  it('puts custom-field problems under their key and keeps the first per field', () => {
    expect(
      splitErrorDetails([
        { path: 'customFields.quantity', message: 'is required' },
        { path: 'customFields.quantity', message: 'must be a number' },
        { path: 'occurredAt', message: 'must not be in the future' },
        { path: 'customFields.result', message: 'must be one of: ok, defect' },
      ]),
    ).toEqual({
      customFields: {
        quantity: { code: 'required', message: 'is required' },
        result: { code: 'option', message: 'must be one of: ok, defect' },
      },
      other: { occurredAt: 'must not be in the future' },
    });
  });
});
