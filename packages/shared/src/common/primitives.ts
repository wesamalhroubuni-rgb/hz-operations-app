import { z } from 'zod';

/** A UUID as used for every record id. */
export const idSchema = z.uuid();

/** An ISO 8601 datetime string with an offset or Z, as sent over the wire. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/**
 * Query-string boolean: accepts the strings "true" / "false" (and real booleans), because
 * `z.coerce.boolean()` would turn the string "false" into true.
 */
export const queryBooleanSchema = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);
