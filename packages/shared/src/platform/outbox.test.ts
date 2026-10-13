import { describe, expect, it } from 'vitest';

import { listOutboxEventsQuerySchema, outboxSequenceSchema } from './outbox.js';

const MAX = '9223372036854775807';

describe('outboxSequenceSchema', () => {
  it.each([['0'], ['1'], ['42'], ['9007199254740993'], [MAX], ['0000000000000000001']])(
    'accepts the whole number %s',
    (value) => {
      expect(outboxSequenceSchema.safeParse(value).success).toBe(true);
    },
  );

  it.each([['9223372036854775808'], ['9999999999999999999']])(
    'refuses %s, which does not fit in a signed 64-bit integer',
    (value) => {
      const result = outboxSequenceSchema.safeParse(value);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.message)).toEqual([
        'must fit in a signed 64-bit integer',
      ]);
    },
  );

  // Every value below must come back as a validation failure. A schema that throws instead
  // turns a bad query string into an HTTP 500.
  it.each([
    ['a word', 'last'],
    ['a decimal', '1.5'],
    ['an exponent', '1e3'],
    ['a negative number', '-1'],
    ['a plus sign', '+1'],
    ['hexadecimal', '0x10'],
    ['an empty string', ''],
    ['a space', ' '],
    ['digits with a space', '1 2'],
    ['a trailing n', '5n'],
    ['more than 19 digits', '12345678901234567890'],
  ])('refuses %s without throwing', (_name, value) => {
    expect(() => outboxSequenceSchema.safeParse(value)).not.toThrow();
    const result = outboxSequenceSchema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('must be a whole number');
  });

  it.each([[5], [5n], [null], [['1']]])('refuses %p, which is not a string', (value) => {
    expect(() => outboxSequenceSchema.safeParse(value)).not.toThrow();
    expect(outboxSequenceSchema.safeParse(value).success).toBe(false);
  });
});

describe('listOutboxEventsQuerySchema', () => {
  it('reports a bad cursor at afterSequence and never throws', () => {
    for (const afterSequence of ['last', '1.5', '1e3', '9999999999999999999']) {
      expect(() => listOutboxEventsQuerySchema.safeParse({ afterSequence })).not.toThrow();
      const result = listOutboxEventsQuerySchema.safeParse({ afterSequence });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('afterSequence');
    }
  });

  it('accepts a cursor, a processed flag and the defaults', () => {
    expect(listOutboxEventsQuerySchema.parse({ afterSequence: MAX, processed: 'false' })).toEqual({
      page: 1,
      pageSize: 25,
      afterSequence: MAX,
      processed: false,
      sort: { field: 'sequence', direction: 'asc' },
    });
  });
});
