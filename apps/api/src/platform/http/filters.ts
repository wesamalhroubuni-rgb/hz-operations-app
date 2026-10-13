/** Small, ORM-shaped helpers for the filters most list endpoints share. */

/**
 * Filter on a dotted name such as an audit action or an event type. A value ending in a dot or
 * an asterisk is a prefix (`task.` and `task.*` match `task.created`, `task.archived`, ...);
 * anything else must match exactly. Returns undefined when there is no value.
 */
export function nameFilter(
  value: string | undefined,
): { equals: string } | { startsWith: string } | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  if (value.endsWith('*')) {
    return { startsWith: escapeLike(value.slice(0, -1)) };
  }
  return value.endsWith('.') ? { startsWith: escapeLike(value) } : { equals: value };
}

/**
 * Escapes the LIKE wildcards % and _ (and the escape character itself), so a term given by a
 * caller is matched as plain text by `contains` / `startsWith` filters.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

/**
 * Range filter on a timestamp column from two optional ISO datetimes: `from` inclusive, `to`
 * exclusive, the convention of every date range in the API. Returns undefined when neither bound
 * is given.
 */
export function dateRangeFilter(
  from: string | undefined,
  to: string | undefined,
): { gte?: Date; lt?: Date } | undefined {
  if (from === undefined && to === undefined) {
    return undefined;
  }
  return {
    ...(from === undefined ? {} : { gte: new Date(from) }),
    ...(to === undefined ? {} : { lt: new Date(to) }),
  };
}
