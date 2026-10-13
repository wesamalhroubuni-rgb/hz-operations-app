import type { ApiErrorDetail } from '@ops/shared';
import { ApiException } from '../../platform/http';
import type { Db } from './db';
import { createsCycle } from './hierarchy';

/** The record kinds another record can point at. Names match the audit entity types. */
export type ReferenceKind = 'user' | 'site' | 'team' | 'task' | 'log_type' | 'work_log';

export interface Reference {
  kind: ReferenceKind;
  id: string;
  /** Where the id sits in the request body, for the error details (`siteId`, `teamIds.2`). */
  path: string;
}

/** Builds the references of one body field; null and undefined mean "no reference". */
export function ref(
  kind: ReferenceKind,
  path: string,
  value: string | readonly string[] | null | undefined,
): Reference[] {
  if (value === null || value === undefined) {
    return [];
  }
  return typeof value === 'string'
    ? [{ kind, id: value, path }]
    : value.map((id, index) => ({ kind, id, path: `${path}.${index}` }));
}

interface ActiveWhere {
  organizationId: string;
  archivedAt: null;
  id: { in: string[] };
}

const FIND_ACTIVE: Record<
  ReferenceKind,
  (db: Db, where: ActiveWhere) => Promise<{ id: string }[]>
> = {
  user: (db, where) => db.user.findMany({ where, select: { id: true } }),
  site: (db, where) => db.site.findMany({ where, select: { id: true } }),
  team: (db, where) => db.team.findMany({ where, select: { id: true } }),
  task: (db, where) => db.task.findMany({ where, select: { id: true } }),
  log_type: (db, where) => db.logType.findMany({ where, select: { id: true } }),
  work_log: (db, where) => db.workLog.findMany({ where, select: { id: true } }),
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
 * The one place that checks "these ids belong to this organization and are not archived".
 * Throws 422 `unprocessable` listing every reference that fails. A record of another
 * organization is reported exactly like one that does not exist, so nothing leaks.
 */
export async function assertActiveReferences(
  db: Db,
  organizationId: string,
  references: Reference[],
): Promise<void> {
  const details: ApiErrorDetail[] = [];
  const kinds = [...new Set(references.map((reference) => reference.kind))];

  for (const kind of kinds) {
    const ofKind = references.filter((reference) => reference.kind === kind);
    const ids = [...new Set(ofKind.map((reference) => reference.id))];
    const found = await FIND_ACTIVE[kind](db, {
      organizationId,
      archivedAt: null,
      id: { in: ids },
    });
    const active = new Set(found.map((row) => row.id));
    for (const reference of ofKind) {
      if (!active.has(reference.id)) {
        details.push({
          path: reference.path,
          message: `${LABELS[kind]} ${reference.id} does not exist in this organization or is archived`,
        });
      }
    }
  }

  if (details.length > 0) {
    throw ApiException.unprocessable(
      'The request refers to records that do not exist or are archived',
      details,
    );
  }
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
