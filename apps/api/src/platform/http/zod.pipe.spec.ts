import { z } from 'zod';
import { ApiException } from './api-exception';
import { ZodPipe } from './zod.pipe';

const UNKNOWN = 'is not a recognised field';

const schema = z.strictObject({
  name: z.string().min(1),
  count: z.number().int().optional(),
  location: z.strictObject({ latitude: z.number(), longitude: z.number() }).optional(),
  fields: z.array(z.strictObject({ key: z.string() })).optional(),
});

/** The ApiException a value is rejected with; fails the test when it is accepted. */
function rejection(pipe: ZodPipe<z.ZodType>, value: unknown): ApiException {
  try {
    pipe.transform(value);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    return error as ApiException;
  }
  throw new Error('expected the pipe to reject the value');
}

describe('ZodPipe', () => {
  const pipe = new ZodPipe(schema);

  it('returns the parsed value, with defaults and transforms applied', () => {
    const trimmed = new ZodPipe(
      z.object({ name: z.string().trim(), page: z.coerce.number().default(1) }),
    );
    expect(trimmed.transform({ name: '  North ' })).toEqual({ name: 'North', page: 1 });
    expect(pipe.transform({ name: 'North' })).toEqual({ name: 'North' });
  });

  it('rejects with a 400 validation_failed ApiException', () => {
    const error = rejection(pipe, { name: '' });
    expect(error.getStatus()).toBe(400);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe('The request is not valid');
  });

  it('reports an unknown top-level key with the key as the path', () => {
    expect(rejection(pipe, { name: 'North', colour: 'red' }).details).toEqual([
      { path: 'colour', message: UNKNOWN },
    ]);
  });

  it('reports several unknown keys as several details, in the order sent', () => {
    expect(rejection(pipe, { name: 'North', zeta: 1, alpha: 2, mid: 3 }).details).toEqual([
      { path: 'zeta', message: UNKNOWN },
      { path: 'alpha', message: UNKNOWN },
      { path: 'mid', message: UNKNOWN },
    ]);
  });

  it('reports an unknown nested key as <parent>.<key>', () => {
    expect(
      rejection(pipe, { name: 'North', location: { latitude: 1, longitude: 2, altitude: 3 } })
        .details,
    ).toEqual([{ path: 'location.altitude', message: UNKNOWN }]);
  });

  it('reports an unknown key inside a list item with its index', () => {
    expect(
      rejection(pipe, { name: 'North', fields: [{ key: 'a' }, { key: 'b', min: 0, max: 1 }] })
        .details,
    ).toEqual([
      { path: 'fields.1.min', message: UNKNOWN },
      { path: 'fields.1.max', message: UNKNOWN },
    ]);
  });

  it('reports unknown keys at several levels together', () => {
    const details = rejection(pipe, {
      name: 'North',
      colour: 'red',
      location: { latitude: 1, longitude: 2, altitude: 3 },
    }).details;
    expect(details).toHaveLength(2);
    expect(details).toEqual(
      expect.arrayContaining([
        { path: 'colour', message: UNKNOWN },
        { path: 'location.altitude', message: UNKNOWN },
      ]),
    );
  });

  it('leaves ordinary issues as they are: dotted path and the schema message', () => {
    const details = rejection(pipe, { count: 1.5, location: { latitude: 'north' } }).details ?? [];
    expect(details.map((detail) => detail.path).sort()).toEqual([
      'count',
      'location.latitude',
      'location.longitude',
      'name',
    ]);
    for (const detail of details) {
      expect(detail.message).not.toBe(UNKNOWN);
      expect(detail.message.length).toBeGreaterThan(0);
    }
  });

  it('reports unknown keys and ordinary issues in one answer', () => {
    const details = rejection(pipe, { name: '', colour: 'red' }).details ?? [];
    expect(details).toContainEqual({ path: 'colour', message: UNKNOWN });
    expect(details.filter((detail) => detail.path === 'name')).toHaveLength(1);
    expect(details).toHaveLength(2);
  });

  it('keeps a custom message and an empty path for an issue on the value itself', () => {
    const refined = new ZodPipe(
      z.strictObject({ a: z.string().optional() }).refine((value) => value.a !== undefined, {
        error: 'Provide at least one field to update',
      }),
    );
    expect(rejection(refined, {}).details).toEqual([
      { path: '', message: 'Provide at least one field to update' },
    ]);
    expect(rejection(new ZodPipe(z.uuid()), 'nope').details?.[0]?.path).toBe('');
  });

  it('does not report unknown keys for a schema that is not strict', () => {
    const lenient = new ZodPipe(z.object({ page: z.coerce.number().default(1) }));
    expect(lenient.transform({ page: '2', utm_source: 'mail' })).toEqual({ page: 2 });
  });

  it('never puts the rejected value in a detail', () => {
    const details = rejection(pipe, { name: 'North', secretNote: 'example-secret-value' }).details;
    expect(JSON.stringify(details)).not.toContain('example-secret-value');
  });
});
