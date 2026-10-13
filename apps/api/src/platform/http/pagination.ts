import type { Paginated, PaginationQuery, SortSpec } from '@ops/shared';

/** `skip` / `take` for the ORM from the validated `page` / `pageSize` query. */
export function pageArgs(query: PaginationQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/**
 * `orderBy` for the ORM from the validated `sort` query. `id` is added as a tie-breaker so the
 * order is stable across pages.
 */
export function orderByArgs<Field extends string>(
  sort: SortSpec<Field>,
): Array<Record<string, 'asc' | 'desc'>> {
  return sort.field === 'id'
    ? [{ id: sort.direction }]
    : [{ [sort.field]: sort.direction }, { id: sort.direction }];
}

/** The list envelope every list endpoint returns. */
export function paginated<Item>(
  items: Item[],
  total: number,
  query: PaginationQuery,
): Paginated<Item> {
  return { items, page: query.page, pageSize: query.pageSize, total };
}
