import type { Prisma } from '../../../generated/prisma/client';
import {
  anomalyFlagVisibilityWhere,
  siteVisibility,
  siteVisibilityWhere,
  taskVisibility,
  taskVisibilityWhere,
  teamVisibility,
  teamVisibilityWhere,
  userVisibility,
  userVisibilityWhere,
  workLogVisibility,
  workLogVisibilityWhere,
  type AccessContext,
  type AnomalySubjectFacts,
  type VisibleAnomalySubjects,
  type VisibleIds,
} from '../../access';
import type { Db } from '../../common/db';

function distinct(values: Iterable<string | null>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value) {
      set.add(value);
    }
  }
  return [...set];
}

async function visibleAmong(
  all: boolean,
  ids: string[],
  load: (ids: string[]) => Promise<Array<{ id: string }>>,
): Promise<VisibleIds> {
  if (all) {
    return 'all';
  }
  if (ids.length === 0) {
    return [];
  }
  return (await load(ids)).map((row) => row.id);
}

/**
 * Which of the subjects named on these flags the caller may see, each kind through its own
 * resource's visibility filter (the same as the lists and the dashboard), so a flag's visibility
 * can never be wider than its subjects'. Feed the result to `anomalyFlagVisibilityWhere`.
 */
export async function resolveVisibleAnomalySubjects(
  db: Db,
  context: AccessContext,
  flags: readonly AnomalySubjectFacts[],
): Promise<VisibleAnomalySubjects> {
  const { organizationId } = context;
  const [siteIds, teamIds, userIds, taskIds, workLogIds] = await Promise.all([
    visibleAmong(siteVisibility(context).all, distinct(flags.map((flag) => flag.siteId)), (ids) =>
      db.site.findMany({
        where: {
          id: { in: ids },
          organizationId,
          AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput],
        },
        select: { id: true },
      }),
    ),
    visibleAmong(teamVisibility(context).all, distinct(flags.map((flag) => flag.teamId)), (ids) =>
      db.team.findMany({
        where: {
          id: { in: ids },
          organizationId,
          AND: [teamVisibilityWhere(context) as Prisma.TeamWhereInput],
        },
        select: { id: true },
      }),
    ),
    visibleAmong(userVisibility(context).all, distinct(flags.map((flag) => flag.userId)), (ids) =>
      db.user.findMany({
        where: {
          id: { in: ids },
          organizationId,
          AND: [userVisibilityWhere(context) as Prisma.UserWhereInput],
        },
        select: { id: true },
      }),
    ),
    visibleAmong(taskVisibility(context).all, distinct(flags.map((flag) => flag.taskId)), (ids) =>
      db.task.findMany({
        where: {
          id: { in: ids },
          organizationId,
          AND: [taskVisibilityWhere(context) as Prisma.TaskWhereInput],
        },
        select: { id: true },
      }),
    ),
    visibleAmong(
      workLogVisibility(context).all,
      distinct(flags.map((flag) => flag.workLogId)),
      (ids) =>
        db.workLog.findMany({
          where: {
            id: { in: ids },
            organizationId,
            AND: [workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput],
          },
          select: { id: true },
        }),
    ),
  ]);
  return { siteIds, teamIds, userIds, taskIds, workLogIds };
}

const SUBJECT_SELECT = {
  siteId: true,
  teamId: true,
  userId: true,
  taskId: true,
  workLogId: true,
  logTypeId: true,
} as const;

/**
 * The full `where` of the flags the caller may see among those matching `base` (which must hold
 * the organization): the candidates' subjects are resolved first, then the visibility fragment is
 * added under `AND`, so `base` can only narrow.
 */
export async function visibleAnomalyFlagWhere(
  db: Db,
  context: AccessContext,
  base: Prisma.AnomalyFlagWhereInput,
): Promise<Prisma.AnomalyFlagWhereInput> {
  const candidates = await db.anomalyFlag.findMany({ where: base, select: SUBJECT_SELECT });
  const visible = await resolveVisibleAnomalySubjects(db, context, candidates);
  return {
    ...base,
    AND: [anomalyFlagVisibilityWhere(context, visible) as Prisma.AnomalyFlagWhereInput],
  };
}
