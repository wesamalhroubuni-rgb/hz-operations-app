import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIELD_TYPES,
  customFieldDefinitionSchema,
  customFieldDefinitionsSchema,
  customFieldValuesSchema,
  MAX_CUSTOM_FIELD_OPTIONS,
  MAX_CUSTOM_FIELD_TEXT_LENGTH,
  MAX_CUSTOM_FIELDS,
  validateCustomFieldValues,
  type CustomFieldDefinition,
  type CustomFieldDefinitionInput,
} from './custom-fields.js';

const definitions: CustomFieldDefinition[] = customFieldDefinitionsSchema.parse([
  { key: 'area', label: 'Area', type: 'text', required: true },
  { key: 'quantity', label: 'Quantity', type: 'number', required: true },
  { key: 'passed', label: 'Passed', type: 'boolean' },
  { key: 'result', label: 'Result', type: 'select', options: ['ok', 'defect'] },
  { key: 'next_check', label: 'Next check', type: 'date' },
]);

function issuesOf(values: unknown) {
  const result = validateCustomFieldValues(definitions, values);
  return result.ok ? [] : result.issues;
}

describe('customFieldDefinitionsSchema', () => {
  it('defaults required to false', () => {
    expect(definitions[2]?.required).toBe(false);
  });

  it('rejects duplicate keys', () => {
    const result = customFieldDefinitionsSchema.safeParse([
      { key: 'a', label: 'A', type: 'text' },
      { key: 'a', label: 'A again', type: 'number' },
    ]);
    expect(result.success).toBe(false);
  });

  it('requires options for select and forbids them elsewhere', () => {
    const parse = (field: unknown) => customFieldDefinitionsSchema.safeParse([field]).success;
    expect(parse({ key: 'a', label: 'A', type: 'select' })).toBe(false);
    expect(parse({ key: 'a', label: 'A', type: 'select', options: [] })).toBe(false);
    expect(parse({ key: 'a', label: 'A', type: 'select', options: ['x', 'x'] })).toBe(false);
    expect(parse({ key: 'a', label: 'A', type: 'text', options: ['x'] })).toBe(false);
    expect(parse({ key: 'a', label: 'A', type: 'select', options: ['x', 'y'] })).toBe(true);
  });

  it('rejects keys that are not slugs', () => {
    const parse = (key: string) =>
      customFieldDefinitionsSchema.safeParse([{ key, label: 'A', type: 'text' }]).success;
    expect(parse('Area')).toBe(false);
    expect(parse('1st')).toBe(false);
    expect(parse('has space')).toBe(false);
    expect(parse('next_check_2')).toBe(true);
  });
});

describe('validateCustomFieldValues', () => {
  it('accepts valid values and returns them', () => {
    const values = {
      area: 'Roof',
      quantity: 12.5,
      passed: true,
      result: 'ok',
      next_check: '2026-11-01',
    };
    expect(validateCustomFieldValues(definitions, values)).toEqual({ ok: true, values });
  });

  it('treats absent and null optional fields as no value', () => {
    const result = validateCustomFieldValues(definitions, {
      area: 'Roof',
      quantity: 0,
      passed: null,
    });
    expect(result).toEqual({ ok: true, values: { area: 'Roof', quantity: 0 } });
  });

  it('reports every missing required field, including null and blank text', () => {
    expect(issuesOf({})).toEqual([
      { path: 'customFields.area', message: 'is required' },
      { path: 'customFields.quantity', message: 'is required' },
    ]);
    expect(issuesOf({ area: '   ', quantity: null })).toEqual([
      { path: 'customFields.area', message: 'is required' },
      { path: 'customFields.quantity', message: 'is required' },
    ]);
    expect(issuesOf(undefined)).toHaveLength(2);
  });

  it('rejects unknown keys', () => {
    expect(issuesOf({ area: 'Roof', quantity: 1, colour: 'red' })).toEqual([
      { path: 'customFields.colour', message: 'is not a field of this log type' },
    ]);
  });

  it('checks each type', () => {
    const valid = { area: 'Roof', quantity: 1 };
    const pathsOf = (extra: Record<string, unknown>) =>
      issuesOf({ ...valid, ...extra }).map((issue) => issue.path);

    expect(pathsOf({ area: 5 })).toEqual(['customFields.area']);
    expect(pathsOf({ area: 'x'.repeat(MAX_CUSTOM_FIELD_TEXT_LENGTH + 1) })).toEqual([
      'customFields.area',
    ]);
    expect(pathsOf({ quantity: '1' })).toEqual(['customFields.quantity']);
    expect(pathsOf({ quantity: Number.NaN })).toEqual(['customFields.quantity']);
    expect(pathsOf({ quantity: Number.POSITIVE_INFINITY })).toEqual(['customFields.quantity']);
    expect(pathsOf({ passed: 'true' })).toEqual(['customFields.passed']);
    expect(pathsOf({ result: 'maybe' })).toEqual(['customFields.result']);
    expect(pathsOf({ next_check: 'tomorrow' })).toEqual(['customFields.next_check']);
    expect(pathsOf({ next_check: '2026-02-30' })).toEqual(['customFields.next_check']);
    expect(pathsOf({ next_check: '2026-11-01T08:30:00Z' })).toEqual([]);
    expect(pathsOf({ next_check: '2026-11-01T08:30:00+03:00' })).toEqual([]);
  });

  it('rejects values that are not an object', () => {
    for (const values of ['text', 5, ['a'], true]) {
      expect(issuesOf(values)).toEqual([{ path: 'customFields', message: 'must be an object' }]);
    }
  });

  it('accepts no values when there are no definitions, and rejects any value', () => {
    expect(validateCustomFieldValues([], {})).toEqual({ ok: true, values: {} });
    expect(validateCustomFieldValues([], { a: 1 }).ok).toBe(false);
  });

  it('does not mistake inherited object properties for fields', () => {
    expect(issuesOf({ area: 'Roof', quantity: 1, toString: 'x' })).toEqual([
      { path: 'customFields.toString', message: 'is not a field of this log type' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Field by field: one optional and one required field of each type.
// ---------------------------------------------------------------------------

function field(definition: CustomFieldDefinitionInput): CustomFieldDefinition {
  return customFieldDefinitionSchema.parse(definition);
}

/** Validates one value against one field and returns the message, or null when it is accepted. */
function check(definition: CustomFieldDefinitionInput, value: unknown): string | null {
  const parsed = field(definition);
  const result = validateCustomFieldValues([parsed], { [parsed.key]: value });
  if (result.ok) {
    expect(result.values).toEqual({ [parsed.key]: value });
    return null;
  }
  expect(result.issues).toHaveLength(1);
  expect(result.issues[0]?.path).toBe(`customFields.${parsed.key}`);
  return result.issues[0]?.message ?? '';
}

describe('validateCustomFieldValues: text', () => {
  const text = { key: 'note', label: 'Note', type: 'text' } as const;

  it.each([['Roof'], ['  padded  '], ['12'], ['true'], ['ünïcödé ✓'], ['line\nbreak']])(
    'accepts the string %p',
    (value) => {
      expect(check(text, value)).toBeNull();
    },
  );

  it('accepts exactly the maximum length and rejects one more', () => {
    expect(check(text, 'x'.repeat(MAX_CUSTOM_FIELD_TEXT_LENGTH))).toBeNull();
    expect(check(text, 'x'.repeat(MAX_CUSTOM_FIELD_TEXT_LENGTH + 1))).toBe(
      `must be at most ${MAX_CUSTOM_FIELD_TEXT_LENGTH} characters`,
    );
  });

  it.each([[5], [0], [true], [false], [['a']], [{ a: 1 }], [Number.NaN]])(
    'rejects %p, which is not a string',
    (value) => {
      expect(check(text, value)).toBe('must be text');
    },
  );

  it('accepts an empty or blank string when optional and rejects it when required', () => {
    expect(check(text, '')).toBeNull();
    expect(check(text, '   ')).toBeNull();
    expect(check({ ...text, required: true }, '')).toBe('is required');
    expect(check({ ...text, required: true }, ' \t\n ')).toBe('is required');
    expect(check({ ...text, required: true }, ' x ')).toBeNull();
  });
});

describe('validateCustomFieldValues: number', () => {
  const number = { key: 'amount', label: 'Amount', type: 'number', required: true } as const;

  it.each([[0], [-0], [1], [-12.5], [1e21], [Number.MAX_SAFE_INTEGER], [Number.MIN_VALUE]])(
    'accepts the finite number %p',
    (value) => {
      expect(check(number, value)).toBeNull();
    },
  );

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '12'],
    ['a decimal string', '12.5'],
    ['an empty string', ''],
    ['a boolean', true],
    ['a BigInt', 12n],
    ['an array', [1]],
    ['an object', { value: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(check(number, value)).toBe('must be a number');
  });

  it('accepts zero for a required number: zero is a value, not a missing one', () => {
    expect(validateCustomFieldValues([field(number)], { amount: 0 })).toEqual({
      ok: true,
      values: { amount: 0 },
    });
  });
});

describe('validateCustomFieldValues: boolean', () => {
  const boolean = { key: 'done', label: 'Done', type: 'boolean', required: true } as const;

  it('accepts true and false, also for a required field', () => {
    expect(check(boolean, true)).toBeNull();
    expect(check(boolean, false)).toBeNull();
  });

  it.each([['true'], ['false'], [1], [0], ['yes'], [''], [[]], [{}]])(
    'rejects %p, which is not a boolean',
    (value) => {
      expect(check(boolean, value)).toBe('must be true or false');
    },
  );
});

describe('validateCustomFieldValues: select', () => {
  const select: CustomFieldDefinitionInput = {
    key: 'grade',
    label: 'Grade',
    type: 'select',
    options: ['A', 'B grade', '10'],
  };

  it.each([['A'], ['B grade'], ['10']])('accepts the option %p', (value) => {
    expect(check(select, value)).toBeNull();
  });

  it.each([
    ['a value that is not an option', 'C'],
    ['an option in another case', 'a'],
    ['an option with extra spaces', ' A'],
    ['an empty string', ''],
    ['the number form of an option', 10],
    ['a boolean', true],
    ['a list of options', ['A']],
    ['an object', { value: 'A' }],
  ])('rejects %s and names the options', (_name, value) => {
    expect(check(select, value)).toBe('must be one of: A, B grade, 10');
  });
});

describe('validateCustomFieldValues: date', () => {
  const date = { key: 'due', label: 'Due', type: 'date' } as const;

  it.each([
    ['2026-10-13'],
    ['2028-02-29'],
    ['2026-10-13T08:30:00Z'],
    ['2026-10-13T08:30:00.123Z'],
    ['2026-10-13T08:30:00+03:00'],
    ['2026-10-13T08:30:00-05:30'],
  ])('accepts %p', (value) => {
    expect(check(date, value)).toBeNull();
  });

  it.each([
    ['a word', 'tomorrow'],
    ['an empty string', ''],
    ['day-first', '13-10-2026'],
    ['slashes', '2026/10/13'],
    ['US style', '10/13/2026'],
    ['no zero padding', '2026-1-5'],
    ['month 13', '2026-13-01'],
    ['30 February', '2026-02-30'],
    ['29 February of a common year', '2026-02-29'],
    ['a datetime without an offset', '2026-10-13T08:30:00'],
    ['a datetime with a space', '2026-10-13 08:30:00Z'],
    ['hour 25', '2026-10-13T25:00:00Z'],
    ['a date with trailing text', '2026-10-13 morning'],
    ['a timestamp number', 1_791_800_000_000],
    ['a Date object', new Date('2026-10-13T00:00:00Z')],
    ['a boolean', true],
  ])('rejects %s', (_name, value) => {
    expect(check(date, value)).toBe(
      'must be an ISO date (YYYY-MM-DD) or an ISO datetime with an offset',
    );
  });
});

describe('validateCustomFieldValues: required, optional, null and absent', () => {
  const TYPES: CustomFieldDefinitionInput[] = [
    { key: 'f', label: 'F', type: 'text' },
    { key: 'f', label: 'F', type: 'number' },
    { key: 'f', label: 'F', type: 'boolean' },
    { key: 'f', label: 'F', type: 'select', options: ['x'] },
    { key: 'f', label: 'F', type: 'date' },
  ];

  it.each(TYPES)('optional $type: absent, null and undefined all mean no value', (definition) => {
    const definitions = [field(definition)];
    expect(validateCustomFieldValues(definitions, {})).toEqual({ ok: true, values: {} });
    expect(validateCustomFieldValues(definitions, { f: null })).toEqual({ ok: true, values: {} });
    expect(validateCustomFieldValues(definitions, { f: undefined })).toEqual({
      ok: true,
      values: {},
    });
  });

  it.each(TYPES)('required $type: absent, null and undefined are all rejected', (definition) => {
    const definitions = [field({ ...definition, required: true })];
    const required = { ok: false, issues: [{ path: 'customFields.f', message: 'is required' }] };
    expect(validateCustomFieldValues(definitions, {})).toEqual(required);
    expect(validateCustomFieldValues(definitions, { f: null })).toEqual(required);
    expect(validateCustomFieldValues(definitions, { f: undefined })).toEqual(required);
    expect(validateCustomFieldValues(definitions, null)).toEqual(required);
    expect(validateCustomFieldValues(definitions, undefined)).toEqual(required);
  });

  it('accepts false for a required boolean', () => {
    const definitions = [field({ key: 'f', label: 'F', type: 'boolean', required: true })];
    expect(validateCustomFieldValues(definitions, { f: false })).toEqual({
      ok: true,
      values: { f: false },
    });
  });

  it('treats null and undefined values as an empty object when nothing is required', () => {
    const definitions = [field({ key: 'f', label: 'F', type: 'text' })];
    expect(validateCustomFieldValues(definitions, null)).toEqual({ ok: true, values: {} });
    expect(validateCustomFieldValues(definitions, undefined)).toEqual({ ok: true, values: {} });
  });
});

describe('validateCustomFieldValues: unknown keys and several errors', () => {
  it('rejects an unknown key even when its value is null', () => {
    expect(issuesOf({ area: 'Roof', quantity: 1, colour: null })).toEqual([
      { path: 'customFields.colour', message: 'is not a field of this log type' },
    ]);
  });

  it('is case-sensitive about keys', () => {
    expect(issuesOf({ Area: 'Roof', quantity: 1 })).toEqual([
      { path: 'customFields.Area', message: 'is not a field of this log type' },
      { path: 'customFields.area', message: 'is required' },
    ]);
  });

  it('rejects a "__proto__" key that arrives through JSON', () => {
    const values: unknown = JSON.parse('{"area":"Roof","quantity":1,"__proto__":{"x":1}}');
    expect(issuesOf(values)).toEqual([
      { path: 'customFields.__proto__', message: 'is not a field of this log type' },
    ]);
  });

  it('handles a field whose key is also the name of an Object.prototype member', () => {
    const definitions = [field({ key: 'constructor', label: 'Constructor', type: 'text' })];
    expect(validateCustomFieldValues(definitions, {})).toEqual({ ok: true, values: {} });
    const result = validateCustomFieldValues(definitions, { constructor: 'ACME' });
    expect(result).toEqual({ ok: true, values: { constructor: 'ACME' } });
  });

  it('reports every problem at once: unknown keys first, then fields in definition order', () => {
    expect(
      issuesOf({
        zebra: 1,
        next_check: 'soon',
        result: 'maybe',
        passed: 'yes',
        quantity: '12',
        apple: 2,
      }),
    ).toEqual([
      { path: 'customFields.zebra', message: 'is not a field of this log type' },
      { path: 'customFields.apple', message: 'is not a field of this log type' },
      { path: 'customFields.area', message: 'is required' },
      { path: 'customFields.quantity', message: 'must be a number' },
      { path: 'customFields.passed', message: 'must be true or false' },
      { path: 'customFields.result', message: 'must be one of: ok, defect' },
      {
        path: 'customFields.next_check',
        message: 'must be an ISO date (YYYY-MM-DD) or an ISO datetime with an offset',
      },
    ]);
  });

  it('prefixes every path with customFields.', () => {
    const issues = issuesOf({ colour: 'red', quantity: 'x' });
    expect(issues.length).toBeGreaterThan(1);
    for (const issue of issues) {
      expect(issue.path).toMatch(/^customFields\.[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });

  it('returns no values at all when anything is wrong', () => {
    const result = validateCustomFieldValues(definitions, { area: 'Roof', quantity: 'x' });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('values');
  });

  it('returns a new object and leaves the input untouched', () => {
    const input = { area: 'Roof', quantity: 1, passed: null };
    const result = validateCustomFieldValues(definitions, input);
    expect(result).toEqual({ ok: true, values: { area: 'Roof', quantity: 1 } });
    expect(input).toEqual({ area: 'Roof', quantity: 1, passed: null });
    expect(result.ok && result.values).not.toBe(input);
  });

  it.each([[new Date()], [new Map()], [Symbol('x')], [() => ({})]])(
    'does not throw on an odd container (%p)',
    (values) => {
      expect(() => validateCustomFieldValues(definitions, values)).not.toThrow();
      expect(validateCustomFieldValues(definitions, values).ok).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** `path: message` of every issue, for a list of definitions that must not parse. */
function definitionIssues(fields: unknown): string[] {
  const result = customFieldDefinitionsSchema.safeParse(fields);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('customFieldDefinitionsSchema: details', () => {
  it('accepts an empty list and one field of every type', () => {
    expect(customFieldDefinitionsSchema.parse([])).toEqual([]);
    const parsed = customFieldDefinitionsSchema.parse(
      CUSTOM_FIELD_TYPES.map((type, index) => ({
        key: `f${index}`,
        label: `Field ${index}`,
        type,
        ...(type === 'select' ? { options: ['a'] } : {}),
      })),
    );
    expect(parsed.map((item) => item.type)).toEqual([
      'text',
      'number',
      'boolean',
      'select',
      'date',
    ]);
  });

  it('reports a duplicate key on the later field, at <index>.key', () => {
    expect(
      definitionIssues([
        { key: 'a', label: 'A', type: 'text' },
        { key: 'b', label: 'B', type: 'text' },
        { key: 'a', label: 'A again', type: 'number' },
        { key: 'a', label: 'A a third time', type: 'date' },
      ]),
    ).toEqual(['2.key: Duplicate field key "a"', '3.key: Duplicate field key "a"']);
  });

  it('reports a select without options at <index>.options', () => {
    expect(definitionIssues([{ key: 'a', label: 'A', type: 'select' }])).toEqual([
      '0.options: A select field needs at least one option',
    ]);
    expect(definitionIssues([{ key: 'a', label: 'A', type: 'select', options: [] }])).toEqual([
      '0.options: A select field needs at least one option',
    ]);
  });

  it('reports duplicate options, also when they differ only by surrounding spaces', () => {
    expect(
      definitionIssues([{ key: 'a', label: 'A', type: 'select', options: ['x', ' x '] }]),
    ).toEqual(['0.options: Options must be unique']);
  });

  it.each(['text', 'number', 'boolean', 'date'] as const)(
    'rejects options on a %s field, even an empty list',
    (type) => {
      expect(definitionIssues([{ key: 'a', label: 'A', type, options: ['x'] }])).toEqual([
        '0.options: Only a select field may have options',
      ]);
      expect(definitionIssues([{ key: 'a', label: 'A', type, options: [] }])).toEqual([
        '0.options: Only a select field may have options',
      ]);
    },
  );

  it.each([
    ['an upper-case letter', 'Area'],
    ['a leading digit', '1st'],
    ['a leading underscore', '_area'],
    ['a space', 'has space'],
    ['a hyphen', 'next-check'],
    ['a dot', 'a.b'],
    ['an empty string', ''],
    ['a non-ASCII letter', 'größe'],
    ['65 characters', `a${'b'.repeat(64)}`],
  ])('rejects a key with %s', (_name, key) => {
    const issues = definitionIssues([{ key, label: 'A', type: 'text' }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^0\.key: must be a slug/);
  });

  it.each([['a'], ['a1'], ['next_check_2'], [`a${'b'.repeat(63)}`]])(
    'accepts the key %p',
    (key) => {
      expect(definitionIssues([{ key, label: 'A', type: 'text' }])).toEqual([]);
    },
  );

  it('rejects a key that is not a string', () => {
    expect(
      customFieldDefinitionSchema.safeParse({ key: 5, label: 'A', type: 'text' }).success,
    ).toBe(false);
  });

  it('rejects an unknown type, a blank label and a non-boolean required', () => {
    const parse = (definition: unknown) =>
      customFieldDefinitionSchema.safeParse(definition).success;
    expect(parse({ key: 'a', label: 'A', type: 'datetime' })).toBe(false);
    expect(parse({ key: 'a', label: 'A', type: 'multiselect', options: ['x'] })).toBe(false);
    expect(parse({ key: 'a', label: '   ', type: 'text' })).toBe(false);
    expect(parse({ key: 'a', type: 'text' })).toBe(false);
    expect(parse({ key: 'a', label: 'A', type: 'text', required: 'yes' })).toBe(false);
    expect(parse({ key: 'a', label: 'A' })).toBe(false);
  });

  it('trims the label, the help text and the options', () => {
    expect(
      customFieldDefinitionSchema.parse({
        key: 'a',
        label: '  Result  ',
        type: 'select',
        options: [' ok ', 'defect'],
        helpText: '  pick one ',
      }),
    ).toEqual({
      key: 'a',
      label: 'Result',
      type: 'select',
      required: false,
      options: ['ok', 'defect'],
      helpText: 'pick one',
    });
  });

  it('rejects a blank option and more options than the maximum', () => {
    const select = (options: string[]) =>
      customFieldDefinitionSchema.safeParse({ key: 'a', label: 'A', type: 'select', options })
        .success;
    const many = (count: number) => Array.from({ length: count }, (_item, index) => `o${index}`);
    expect(select(['ok', '  '])).toBe(false);
    expect(select(many(MAX_CUSTOM_FIELD_OPTIONS))).toBe(true);
    expect(select(many(MAX_CUSTOM_FIELD_OPTIONS + 1))).toBe(false);
  });

  it('accepts the maximum number of fields and rejects one more', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_item, index) => ({
        key: `f${index}`,
        label: `F${index}`,
        type: 'text',
      }));
    expect(customFieldDefinitionsSchema.safeParse(many(MAX_CUSTOM_FIELDS)).success).toBe(true);
    expect(customFieldDefinitionsSchema.safeParse(many(MAX_CUSTOM_FIELDS + 1)).success).toBe(false);
  });

  it('reports several broken definitions together', () => {
    const issues = definitionIssues([
      { key: 'Bad Key', label: 'A', type: 'text' },
      { key: 'b', label: 'B', type: 'select' },
      { key: 'c', label: 'C', type: 'number', options: ['x'] },
    ]);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatch(/^0\.key:/);
    expect(issues[1]).toMatch(/^1\.options:/);
    expect(issues[2]).toMatch(/^2\.options:/);
  });

  it('rejects something that is not a list', () => {
    expect(customFieldDefinitionsSchema.safeParse({ key: 'a' }).success).toBe(false);
    expect(customFieldDefinitionsSchema.safeParse(null).success).toBe(false);
  });
});

describe('customFieldValuesSchema (stored values)', () => {
  it('accepts strings, numbers and booleans and rejects null and nested values', () => {
    expect(customFieldValuesSchema.safeParse({ a: 'x', b: 1, c: false }).success).toBe(true);
    expect(customFieldValuesSchema.safeParse({ a: null }).success).toBe(false);
    expect(customFieldValuesSchema.safeParse({ a: ['x'] }).success).toBe(false);
    expect(customFieldValuesSchema.safeParse({ a: { b: 1 } }).success).toBe(false);
  });

  it('accepts whatever validateCustomFieldValues returns', () => {
    const result = validateCustomFieldValues(definitions, {
      area: 'Roof',
      quantity: 2,
      passed: false,
      result: 'defect',
      next_check: '2026-11-01',
    });
    expect(result.ok && customFieldValuesSchema.safeParse(result.values).success).toBe(true);
  });
});
