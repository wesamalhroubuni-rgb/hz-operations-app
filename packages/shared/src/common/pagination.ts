import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** `page` and `pageSize` query parameters, accepted as strings or numbers. */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface SortSpec<Field extends string> {
  field: Field;
  direction: 'asc' | 'desc';
}

/**
 * `sort` query parameter in the form `field:asc` or `field:desc` (direction defaults to asc),
 * restricted to the fields an endpoint allows.
 *
 * @example sortQuerySchema(['occurredAt', 'createdAt'], { field: 'occurredAt', direction: 'desc' })
 */
export function sortQuerySchema<const Fields extends readonly [string, ...string[]]>(
  fields: Fields,
  defaultSort: SortSpec<Fields[number]>,
) {
  const allowed = `Allowed: ${fields.join(', ')}; append :asc or :desc.`;
  return z
    .string()
    .optional()
    .transform((value, ctx): SortSpec<Fields[number]> => {
      if (value === undefined || value === '') {
        return defaultSort;
      }
      const [field, direction = 'asc', ...rest] = value.split(':');
      if (
        rest.length > 0 ||
        field === undefined ||
        !fields.includes(field) ||
        (direction !== 'asc' && direction !== 'desc')
      ) {
        ctx.addIssue({ code: 'custom', message: `Invalid sort "${value}". ${allowed}` });
        return z.NEVER;
      }
      return { field: field as Fields[number], direction };
    });
}

/** Envelope of every list endpoint. */
export function paginatedSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
  });
}

export interface Paginated<Item> {
  items: Item[];
  page: number;
  pageSize: number;
  total: number;
}
