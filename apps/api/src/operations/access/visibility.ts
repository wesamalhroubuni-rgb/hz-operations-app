/**
 * Visibility as data.
 *
 * "Which records of a resource may this caller see" is written ONCE per resource, as a
 * `Visibility` value built from the caller's access context. Two interpreters read that value:
 *
 * - `isVisible(visibility, facts)`     the in-memory predicate for one record;
 * - `visibilityWhere(visibility)`      the Prisma `where` fragment for a query.
 *
 * Because both are derived from the same value, the predicate of a resource and its list filter
 * cannot drift apart: there is no second place to forget.
 *
 * A record is visible when the visibility is `all`, or when at least one clause matches.
 * No clause (or only clauses with an empty id list) means nothing is visible.
 */

/** The record's own column holds one of the ids: `authorId IN (...)`. */
export interface FieldClause<Facts> {
  kind: 'field';
  /** Name of the column, and of the fact holding its value. */
  field: keyof Facts & string;
  in: readonly string[];
}

/**
 * Something related to the record holds one of the ids: `assignees SOME userId IN (...)`.
 *
 * `fact` names the list on the in-memory record that carries the same information as the
 * relation `path` does in the database (for a task: `assigneeIds` and
 * `['assignees', 'some', 'userId']`).
 */
export interface RelationClause<Facts> {
  kind: 'relation';
  fact: keyof Facts & string;
  /** Prisma relation path down to the id column, e.g. `['assignees', 'some', 'userId']`. */
  path: readonly [string, ...string[]];
  in: readonly string[];
  /**
   * Relations along the path whose records count only while not archived, e.g. `['tasks']`:
   * an archived task no longer makes its site visible. The facts given to the predicate must be
   * computed the same way (from non-archived records only).
   */
  activeOnly?: readonly string[];
}

export type Clause<Facts> = FieldClause<Facts> | RelationClause<Facts>;

export type Visibility<Facts> = { all: true } | { all: false; anyOf: readonly Clause<Facts>[] };

export const EVERYTHING = { all: true } as const;

export function anyOf<Facts>(...clauses: Clause<Facts>[]): Visibility<Facts> {
  return { all: false, anyOf: clauses.filter((clause) => clause.in.length > 0) };
}

export function fieldIn<Facts>(
  field: keyof Facts & string,
  ids: Iterable<string>,
): FieldClause<Facts> {
  return { kind: 'field', field, in: [...new Set(ids)] };
}

export function relationIn<Facts>(
  fact: keyof Facts & string,
  path: readonly [string, ...string[]],
  ids: Iterable<string>,
  options: { activeOnly?: readonly string[] } = {},
): RelationClause<Facts> {
  return {
    kind: 'relation',
    fact,
    path,
    in: [...new Set(ids)],
    ...(options.activeOnly ? { activeOnly: options.activeOnly } : {}),
  };
}

const LIST_OPERATORS = new Set(['some', 'every', 'none']);

function clauseMatches<Facts>(clause: Clause<Facts>, facts: Facts): boolean {
  const value: unknown = facts[clause.kind === 'field' ? clause.field : clause.fact];
  if (clause.kind === 'field') {
    return typeof value === 'string' && clause.in.includes(value);
  }
  return (
    Array.isArray(value) && value.some((id) => typeof id === 'string' && clause.in.includes(id))
  );
}

/** The predicate: may a record with these facts be seen? */
export function isVisible<Facts>(visibility: Visibility<Facts>, facts: Facts): boolean {
  return visibility.all || visibility.anyOf.some((clause) => clauseMatches(clause, facts));
}

export type WhereFragment = Record<string, unknown>;

/** A filter that matches no row. */
export const MATCH_NOTHING: WhereFragment = { id: { in: [] } };

function clauseWhere<Facts>(clause: Clause<Facts>): WhereFragment {
  const ids = { in: [...clause.in] };
  if (clause.kind === 'field') {
    return { [clause.field]: ids };
  }
  // ['assignees', 'some', 'userId'] becomes { assignees: { some: { userId: { in } } } }.
  // A relation listed in `activeOnly` also gets `archivedAt: null` on its records: on the
  // object under its list operator (`tasks: { some: { archivedAt: null, ... } }`), or on the
  // object itself for a to-one relation (`task: { archivedAt: null, ... }`).
  const activeOnly = new Set(clause.activeOnly ?? []);
  const { path } = clause;
  return path.reduceRight<WhereFragment | { in: string[] }>((inner, key, index) => {
    const previous = path[index - 1];
    const next = path[index + 1];
    const recordLevel =
      (LIST_OPERATORS.has(key) && previous !== undefined && activeOnly.has(previous)) ||
      (activeOnly.has(key) && (next === undefined || !LIST_OPERATORS.has(next)));
    return { [key]: recordLevel ? { archivedAt: null, ...inner } : inner };
  }, ids) as WhereFragment;
}

/**
 * The same rule as a Prisma `where` fragment. Put it under `AND` next to the organization
 * filter and the filters the caller asked for, so those can only narrow what is visible.
 */
export function visibilityWhere<Facts>(visibility: Visibility<Facts>): WhereFragment {
  if (visibility.all) {
    return {};
  }
  const clauses = visibility.anyOf.filter((clause) => clause.in.length > 0);
  return clauses.length === 0 ? MATCH_NOTHING : { OR: clauses.map(clauseWhere) };
}
