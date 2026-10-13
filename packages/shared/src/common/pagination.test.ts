import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiErrorSchema } from './errors.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
} from './pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from './primitives.js';

describe('paginationQuerySchema', () => {
  it('defaults to the first page and the default page size', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('accepts query-string values and numbers alike', () => {
    expect(paginationQuerySchema.parse({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
    expect(paginationQuerySchema.parse({ page: 3, pageSize: 50 })).toEqual({
      page: 3,
      pageSize: 50,
    });
  });

  it('accepts the bounds: page 1, page size 1 and the maximum page size', () => {
    expect(paginationQuerySchema.parse({ page: '1', pageSize: '1' }).pageSize).toBe(1);
    expect(paginationQuerySchema.parse({ pageSize: String(MAX_PAGE_SIZE) }).pageSize).toBe(
      MAX_PAGE_SIZE,
    );
  });

  it.each([
    ['page 0', { page: '0' }],
    ['a negative page', { page: '-1' }],
    ['a fractional page', { page: '1.5' }],
    ['a page that is not a number', { page: 'two' }],
    ['a page with trailing text', { page: '2abc' }],
    ['an infinite page', { page: 'Infinity' }],
    ['page size 0', { pageSize: '0' }],
    ['a negative page size', { pageSize: '-5' }],
    ['a page size above the maximum', { pageSize: String(MAX_PAGE_SIZE + 1) }],
    ['a fractional page size', { pageSize: '10.5' }],
    ['a page size that is not a number', { pageSize: 'all' }],
    ['a repeated parameter', { page: ['1', '2'] }],
  ])('rejects %s', (_name, query) => {
    expect(paginationQuerySchema.safeParse(query).success).toBe(false);
  });

  it('names the parameter at fault', () => {
    const result = paginationQuerySchema.safeParse({ page: '1', pageSize: '500' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['pageSize']);
  });
});

describe('sortQuerySchema', () => {
  const schema = sortQuerySchema(['occurredAt', 'createdAt'], {
    field: 'occurredAt',
    direction: 'desc',
  });

  it('uses the default when the parameter is absent or empty', () => {
    expect(schema.parse(undefined)).toEqual({ field: 'occurredAt', direction: 'desc' });
    expect(schema.parse('')).toEqual({ field: 'occurredAt', direction: 'desc' });
  });

  it('parses field:asc and field:desc', () => {
    expect(schema.parse('createdAt:asc')).toEqual({ field: 'createdAt', direction: 'asc' });
    expect(schema.parse('createdAt:desc')).toEqual({ field: 'createdAt', direction: 'desc' });
  });

  it('sorts ascending when only the field is given, whatever the default direction', () => {
    expect(schema.parse('occurredAt')).toEqual({ field: 'occurredAt', direction: 'asc' });
  });

  it.each([
    ['a field that is not allowed', 'name:asc'],
    ['a field in another case', 'OccurredAt:asc'],
    ['a direction that is not asc or desc', 'createdAt:up'],
    ['an upper-case direction', 'createdAt:DESC'],
    ['an empty direction', 'createdAt:'],
    ['an empty field', ':asc'],
    ['a third part', 'createdAt:asc:extra'],
    ['two fields', 'createdAt,occurredAt'],
    ['spaces', ' createdAt:asc'],
    ['a minus prefix', '-createdAt'],
    ['a field name from Object.prototype', 'constructor:asc'],
  ])('rejects %s and lists the allowed fields', (_name, value) => {
    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      `Invalid sort "${value}". Allowed: occurredAt, createdAt; append :asc or :desc.`,
    );
  });

  it('rejects a value that is not a string', () => {
    expect(schema.safeParse(['createdAt:asc', 'occurredAt:asc']).success).toBe(false);
    expect(schema.safeParse(5).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });

  it('reports the problem at the key it sits under in a query object', () => {
    const query = paginationQuerySchema.extend({ sort: schema });
    expect(query.parse({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      sort: { field: 'occurredAt', direction: 'desc' },
    });
    const result = query.safeParse({ sort: 'nope' });
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual(['sort']);
  });
});

describe('paginatedSchema', () => {
  const schema = paginatedSchema(z.object({ id: z.string() }));

  it('accepts the list envelope, also when empty', () => {
    expect(schema.safeParse({ items: [], page: 1, pageSize: 25, total: 0 }).success).toBe(true);
    expect(schema.safeParse({ items: [{ id: 'a' }], page: 2, pageSize: 1, total: 7 }).success).toBe(
      true,
    );
  });

  it.each([
    ['a bare list', [{ id: 'a' }]],
    ['a missing total', { items: [], page: 1, pageSize: 25 }],
    ['page 0', { items: [], page: 0, pageSize: 25, total: 0 }],
    ['a negative total', { items: [], page: 1, pageSize: 25, total: -1 }],
    ['an item of the wrong shape', { items: [{ id: 1 }], page: 1, pageSize: 25, total: 1 }],
  ])('rejects %s', (_name, body) => {
    expect(schema.safeParse(body).success).toBe(false);
  });
});

describe('query primitives', () => {
  it('reads the strings "true" and "false" as booleans, unlike z.coerce.boolean', () => {
    expect(queryBooleanSchema.parse('true')).toBe(true);
    expect(queryBooleanSchema.parse('false')).toBe(false);
    expect(queryBooleanSchema.parse(true)).toBe(true);
    expect(queryBooleanSchema.parse(false)).toBe(false);
  });

  it.each([['1'], ['0'], ['yes'], ['TRUE'], [''], [1], [null]])(
    'rejects %p as a query boolean',
    (value) => {
      expect(queryBooleanSchema.safeParse(value).success).toBe(false);
    },
  );

  it('accepts datetimes with Z or an offset and rejects local ones', () => {
    expect(isoDateTimeSchema.safeParse('2026-10-13T08:30:00Z').success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-10-13T08:30:00.000+03:00').success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-10-13T08:30:00').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('2026-10-13').success).toBe(false);
    expect(isoDateTimeSchema.safeParse('yesterday').success).toBe(false);
  });

  it('accepts a UUID as an id and nothing else', () => {
    expect(idSchema.safeParse('0190f3a2-7c1e-7000-8000-000000000001').success).toBe(true);
    expect(idSchema.safeParse('0190f3a2-7c1e-7000-8000-00000000000').success).toBe(false);
    expect(idSchema.safeParse('1').success).toBe(false);
    expect(idSchema.safeParse('').success).toBe(false);
  });
});

describe('apiErrorSchema', () => {
  const error = {
    statusCode: 400,
    code: 'validation_failed',
    message: 'The request is not valid',
    correlationId: 'c-1',
    timestamp: '2026-10-13T10:00:00.000Z',
  };

  it('accepts the standard body with and without details, and a null correlation id', () => {
    expect(apiErrorSchema.safeParse(error).success).toBe(true);
    expect(
      apiErrorSchema.safeParse({ ...error, details: [{ path: 'name', message: 'is required' }] })
        .success,
    ).toBe(true);
    expect(apiErrorSchema.safeParse({ ...error, correlationId: null }).success).toBe(true);
  });

  it.each([
    ['an unknown code', { ...error, code: 'oops' }],
    ['a missing correlation id', { ...error, correlationId: undefined }],
    ['a timestamp that is not ISO', { ...error, timestamp: 'now' }],
    ['a status sent as text', { ...error, statusCode: '400' }],
    ['details that are not path/message pairs', { ...error, details: ['name is required'] }],
    [
      'the default NestJS error body',
      { statusCode: 404, message: 'Not Found', error: 'Not Found' },
    ],
  ])('rejects %s', (_name, body) => {
    expect(apiErrorSchema.safeParse(body).success).toBe(false);
  });
});
