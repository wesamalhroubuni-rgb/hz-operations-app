import { z } from 'zod';
import type { QueryValue } from '../api-client/client.js';
import { isoDateTimeSchema } from '../common/primitives.js';

/**
 * Query parameters a client may pass to a list endpoint: every key of the validated query,
 * optional, as a plain query-string value (`sort` is the string form, e.g. `createdAt:desc`).
 */
export type ListQueryParams<Schema extends z.ZodType> = Partial<
  Record<keyof z.output<Schema>, QueryValue>
>;

/** A short single-line text such as a name or a title. */
export const nameSchema = z.string().trim().min(1).max(200);

/** Free text such as a description. */
export const longTextSchema = z.string().trim().max(10_000);

/** Free-text search term of a list endpoint. */
export const searchQuerySchema = z.string().trim().min(1).max(200).optional();

/** A nullable ISO datetime on the wire (`archivedAt`, `dueAt`, ...). */
export const nullableIsoDateTimeSchema = isoDateTimeSchema.nullable();

/** A list of record ids without duplicates. */
export function uniqueIdListSchema(max = 200) {
  return z
    .array(z.uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'must not contain duplicates' });
}

/** Rejects an update body with no field at all, which is always a client mistake. */
export function atLeastOneField(value: Record<string, unknown>): boolean {
  return Object.values(value).some((field) => field !== undefined);
}

export const AT_LEAST_ONE_FIELD = { error: 'Provide at least one field to update' } as const;
