import type { Prisma } from '../../generated/prisma/client';
import {
  siteVisibilityWhere,
  taskVisibilityWhere,
  teamVisibilityWhere,
  userVisibilityWhere,
  type AccessContext,
} from '../access';
import type { Db } from './db';

// The names behind ids, for the dashboard's aggregates, exports, reports and histories. Every
// lookup goes through the resource's visibility filter, so a name the caller may not see is
// simply absent from the map (the caller shows it as empty or "Unknown"). Ids that are null or
// repeated are ignored; an empty list costs no query.

export type NameMap = ReadonlyMap<string, string>;

function distinct(ids: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    if (id) {
      set.add(id);
    }
  }
  return [...set];
}

export async function userNames(
  db: Db,
  context: AccessContext,
  ids: Iterable<string | null | undefined>,
): Promise<NameMap> {
  const wanted = distinct(ids);
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await db.user.findMany({
    where: {
      id: { in: wanted },
      organizationId: context.organizationId,
      AND: [userVisibilityWhere(context) as Prisma.UserWhereInput],
    },
    select: { id: true, displayName: true },
  });
  return new Map(rows.map((row) => [row.id, row.displayName]));
}

export async function siteNames(
  db: Db,
  context: AccessContext,
  ids: Iterable<string | null | undefined>,
): Promise<NameMap> {
  const wanted = distinct(ids);
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await db.site.findMany({
    where: {
      id: { in: wanted },
      organizationId: context.organizationId,
      AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput],
    },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function teamNames(
  db: Db,
  context: AccessContext,
  ids: Iterable<string | null | undefined>,
): Promise<NameMap> {
  const wanted = distinct(ids);
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await db.team.findMany({
    where: {
      id: { in: wanted },
      organizationId: context.organizationId,
      AND: [teamVisibilityWhere(context) as Prisma.TeamWhereInput],
    },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Log types are visible to every member of the organization. */
export async function logTypeNames(
  db: Db,
  context: AccessContext,
  ids: Iterable<string | null | undefined>,
): Promise<NameMap> {
  const wanted = distinct(ids);
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await db.logType.findMany({
    where: { id: { in: wanted }, organizationId: context.organizationId },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function taskTitles(
  db: Db,
  context: AccessContext,
  ids: Iterable<string | null | undefined>,
): Promise<NameMap> {
  const wanted = distinct(ids);
  if (wanted.length === 0) {
    return new Map();
  }
  const rows = await db.task.findMany({
    where: {
      id: { in: wanted },
      organizationId: context.organizationId,
      AND: [taskVisibilityWhere(context) as Prisma.TaskWhereInput],
    },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

/** The name of an id in a map, or null (no id, or not visible). */
export function nameIn(map: NameMap, id: string | null | undefined): string | null {
  return id ? (map.get(id) ?? null) : null;
}
