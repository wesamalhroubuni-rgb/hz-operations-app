import type { ApiErrorDetail } from '@ops/shared';
import { ApiException } from '../../platform/http';
import type { Prisma } from '../../generated/prisma/client';
import type { Db } from './db';
import { createsCycle } from './hierarchy';

/** The record kinds another record can point at. Names match the audit entity types. */
export type ReferenceKind = 'user' | 'site' | 'team' | 'task' | 'log_type' | 'work_log';

/** A Prisma `where` fragment of the referenced model, from the access rules. */
type VisibleWhere = Record<string, unknown>;

export interface Reference {
  kind: ReferenceKind;
  id: string;
  /** Where the id sits in the request body, for the error details (`siteId`, `teamIds.2`). */
  path: string;
  /**
   * The caller's visibility of that kind of record, when the reference must also be something
   * the caller may see (or assign). A record outside it is reported exactly like one that does
   * not exist.
   */
  visible?: VisibleWhere;
}

/**
 * Builds the references of one body field; null and undefined mean "no reference".
 *
 * @param visible `where` fragment the referenced records must also satisfy (the caller's
 *   visibility of them, from `operations/access/rules`)
 */
export function ref(
  kind: ReferenceKind,
  path: string,
  value: string | readonly string[] | null | undefined,
  visible?: VisibleWhere,
): Reference[] {
  if (value === null || value === undefined) {
    return [];
  }
  return typeof value === 'string'
    ? [{ kind, id: value, path, visible }]
    : value.map((id, index) => ({ kind, id, path: `${path}.${index}`, visible }));
}

interface ActiveWhere {
  organizationId: string;
  archivedAt: null;
  id: { in: string[] };
  AND: VisibleWhere[];
}

const FIND_ACTIVE: Record<
  ReferenceKind,
  (db: Db, where: ActiveWhere) => Promise<{ id: string }[]>
> = {
  user: (db, where) =>
    db.user.findMany({ where: where as Prisma.UserWhereInput, select: { id: true } }),
  site: (db, where) =>
    db.site.findMany({ where: where as Prisma.SiteWhereInput, select: { id: true } }),
  team: (db, where) =>
    db.team.findMany({ where: where as Prisma.TeamWhereInput, select: { id: true } }),
  task: (db, where) =>
    db.task.findMany({ where: where as Prisma.TaskWhereInput, select: { id: true } }),
  log_type: (db, where) =>
    db.logType.findMany({ where: where as Prisma.LogTypeWhereInput, select: { id: true } }),
  work_log: (db, where) =>
    db.workLog.findMany({ where: where as Prisma.WorkLogWhereInput, select: { id: true } }),
};

const LABELS: Record<ReferenceKind, string> = {
  user: 'User',
  site: 'Site',
  team: 'Team',
  task: 'Task',
  log_type: 'Log type',
  work_log: 'Work log',
};

/**
 * The one place that checks "these ids belong to this organization, are not archived and, when
 * the reference says so, are visible to the caller". Throws 422 `unprocessable` listing every
 * reference that fails. A record of another organization, and a record outside the caller's
 * scope, are reported exactly like one that does not exist, so nothing leaks.
 *
 * The visibility is part of the query (`AND`), never a filter applied after loading.
 */
export async function assertActiveReferences(
  db: Db,
  organizationId: string,
  references: Reference[],
): Promise<void> {
  const details = await referenceProblems(db, organizationId, references);
  if (details.length > 0) {
    throw ApiException.unprocessable(
      'The request refers to records that do not exist or are archived',
      details,
    );
  }
}

/**
 * The references of {@link assertActiveReferences} that fail its check (missing, of another
 * organization, archived, or outside the caller's visibility), one detail each, without
 * throwing. Used where an unusable reference is dropped instead of refused (a queued offline
 * create, ADR-0008 section 3).
 */
export async function referenceProblems(
  db: Db,
  organizationId: string,
  references: Reference[],
): Promise<ApiErrorDetail[]> {
  const details: ApiErrorDetail[] = [];

  // One query per kind and visibility rule (a body rarely has more than one rule per kind).
  const groups = new Map<ReferenceKind, Map<VisibleWhere | undefined, Reference[]>>();
  for (const reference of references) {
    const byRule = groups.get(reference.kind) ?? new Map<VisibleWhere | undefined, Reference[]>();
    byRule.set(reference.visible, [...(byRule.get(reference.visible) ?? []), reference]);
    groups.set(reference.kind, byRule);
  }

  for (const [kind, byRule] of groups) {
    for (const [visible, ofRule] of byRule) {
      const ids = [...new Set(ofRule.map((reference) => reference.id))];
      const found = await FIND_ACTIVE[kind](db, {
        organizationId,
        archivedAt: null,
        id: { in: ids },
        AND: visible ? [visible] : [],
      });
      const active = new Set(found.map((row) => row.id));
      for (const reference of ofRule) {
        if (!active.has(reference.id)) {
          details.push({
            path: reference.path,
            message: `${LABELS[kind]} ${reference.id} does not exist in this organization or is archived`,
          });
        }
      }
    }
  }

  return details;
}

/**
 * Validates the `parentId` of a site or team: the parent must be an active record of the same
 * organization, must not be the record itself, and must not sit below it (no cycles).
 *
 * @param id the record being updated, or null when it is being created
 */
export async function assertValidParent(
  db: Db,
  kind: 'site' | 'team',
  organizationId: string,
  id: string | null,
  parentId: string | null | undefined,
): Promise<void> {
  if (parentId === null || parentId === undefined) {
    return;
  }
  const label = LABELS[kind];
  if (parentId === id) {
    throw ApiException.unprocessable(`${label} cannot be its own parent`, [
      { path: 'parentId', message: 'must be a different record' },
    ]);
  }
  await assertActiveReferences(db, organizationId, ref(kind, 'parentId', parentId));
  if (id === null) {
    return;
  }

  const select = { id: true, parentId: true };
  const nodes =
    kind === 'site'
      ? await db.site.findMany({ where: { organizationId }, select })
      : await db.team.findMany({ where: { organizationId }, select });
  if (createsCycle(nodes, id, parentId)) {
    throw ApiException.unprocessable(`${label} cannot be moved below one of its own descendants`, [
      { path: 'parentId', message: 'would create a cycle' },
    ]);
  }
}
