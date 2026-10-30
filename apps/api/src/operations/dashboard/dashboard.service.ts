import { Injectable } from '@nestjs/common';
import {
  DIRECTORY_MAX_ITEMS,
  IDLE_WORKERS_LIMIT,
  rolesHighestFirst,
  zonedDayKey,
  zonedDaysRange,
  type DashboardIdleWorker,
  type DashboardOverview,
  type DashboardOverviewQuery,
  type DashboardPlaceActivity,
  type Directory,
  type ListFilter,
} from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessClock,
  AccessService,
  siteVisibilityWhere,
  teamVisibilityWhere,
  userVisibilityWhere,
  type AccessContext,
} from '../access';
import { iso, isoOrNull } from '../common/db';
import { siteNames, teamNames, type NameMap } from '../common/names';
import { loadTimeZone } from '../common/org-time-zone';
import { taskWhere } from '../tasks/task-query';
import { workLogWhere } from '../work-logs/work-log-query';

/** The review queue: submitted logs the caller did not write (they can never approve their own). */
const AWAITING_FILTERS = { status: 'submitted' as const, excludeOwn: true };

interface PlaceCounts {
  logs: Map<string | null, number>;
  tasks: Map<string | null, number>;
}

/**
 * One row per place with activity (logs in the day or open tasks), most logs first, then most
 * open tasks, then by name. The row of records without a place has id null. A place the caller
 * may not see by itself (a supervisor of a team sees that team's logs at any site) keeps its
 * id, which the logs already carry, but no name.
 */
export function placeActivity(
  counts: PlaceCounts,
  names: NameMap,
  key: 'siteId' | 'teamId',
  dayFilter: ListFilter,
): DashboardPlaceActivity[] {
  const ids = new Set<string | null>([...counts.logs.keys(), ...counts.tasks.keys()]);
  const rows = [...ids].map((id): DashboardPlaceActivity => {
    const place: ListFilter = id ? { [key]: id } : {};
    return {
      id,
      name: id ? (names.get(id) ?? null) : null,
      logsToday: counts.logs.get(id) ?? 0,
      tasksOpen: counts.tasks.get(id) ?? 0,
      logsFilter: { ...place, ...dayFilter },
      tasksFilter: { ...place, open: 'true' },
    };
  });
  return rows
    .filter((row) => row.logsToday > 0 || row.tasksOpen > 0)
    .sort(
      (a, b) =>
        b.logsToday - a.logsToday ||
        b.tasksOpen - a.tasksOpen ||
        (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0) ||
        (a.name ?? '').localeCompare(b.name ?? ''),
    );
}

function countsBy<Key extends string>(
  groups: Array<Record<Key, string | null> & { _count: { _all: number } }>,
  key: Key,
): Map<string | null, number> {
  return new Map(groups.map((group) => [group[key], group._count._all]));
}

/**
 * The dashboard's home page and its directory of names (Phase 6, ADR-0009). Every number is a
 * count over the same `where` as the list it links to (`workLogWhere` / `taskWhere`), so it is
 * always inside the caller's visibility and always equal to that list's total. Counts and
 * groupings are aggregate queries: no rows are loaded to be counted.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly clock: AccessClock,
  ) {}

  async overview(query: DashboardOverviewQuery): Promise<DashboardOverview> {
    const context = await this.access.context();
    const now = this.clock.now();
    const timeZone = await loadTimeZone(this.prisma, context.organizationId);
    const day = query.day ?? zonedDayKey(now, timeZone);
    const range = zonedDaysRange(day, day, timeZone);
    const dayFilter: ListFilter = { occurredFrom: range.from, occurredTo: range.to };

    const logsToday = workLogWhere(context, dayFilter);
    const awaiting = workLogWhere(context, AWAITING_FILTERS);
    const open = taskWhere(context, { open: true }, now);
    const overdue = taskWhere(context, { overdue: true }, now);
    const blocked = taskWhere(context, { status: 'blocked' }, now);

    const [
      logsTodayCount,
      awaitingCount,
      openCount,
      overdueCount,
      blockedCount,
      logsBySite,
      logsByTeam,
      tasksBySite,
      tasksByTeam,
      idleWorkers,
    ] = await Promise.all([
      this.prisma.workLog.count({ where: logsToday }),
      this.prisma.workLog.count({ where: awaiting }),
      this.prisma.task.count({ where: open }),
      this.prisma.task.count({ where: overdue }),
      this.prisma.task.count({ where: blocked }),
      this.prisma.workLog.groupBy({ by: ['siteId'], where: logsToday, _count: { _all: true } }),
      this.prisma.workLog.groupBy({ by: ['teamId'], where: logsToday, _count: { _all: true } }),
      this.prisma.task.groupBy({ by: ['siteId'], where: open, _count: { _all: true } }),
      this.prisma.task.groupBy({ by: ['teamId'], where: open, _count: { _all: true } }),
      this.idleWorkers(context, new Date(range.from), new Date(range.to)),
    ]);

    const siteCounts = {
      logs: countsBy(logsBySite, 'siteId'),
      tasks: countsBy(tasksBySite, 'siteId'),
    };
    const teamCounts = {
      logs: countsBy(logsByTeam, 'teamId'),
      tasks: countsBy(tasksByTeam, 'teamId'),
    };
    const [sites, teams] = await Promise.all([
      siteNames(this.prisma, context, [...siteCounts.logs.keys(), ...siteCounts.tasks.keys()]),
      teamNames(this.prisma, context, [...teamCounts.logs.keys(), ...teamCounts.tasks.keys()]),
    ]);

    return {
      generatedAt: iso(now),
      timeZone,
      day,
      dayStart: range.from,
      dayEnd: range.to,
      logsToday: { count: logsTodayCount, filter: dayFilter },
      logsAwaitingApproval: {
        count: awaitingCount,
        filter: { status: 'submitted', excludeOwn: 'true' },
      },
      tasksOpen: { count: openCount, filter: { open: 'true' } },
      tasksOverdue: { count: overdueCount, filter: { overdue: 'true' } },
      tasksBlocked: { count: blockedCount, filter: { status: 'blocked' } },
      bySite: placeActivity(siteCounts, sites, 'siteId', dayFilter),
      byTeam: placeActivity(teamCounts, teams, 'teamId', dayFilter),
      idleWorkers,
    };
  }

  /**
   * Active users with an active worker membership among the caller's people (a supervisor's
   * `scope.userIds`; everyone for an organization-wide caller), the caller excluded, without a
   * non-archived log whose `occurredAt` is in the day. Counted in full, listed by name up to
   * `IDLE_WORKERS_LIMIT`, each with the time of their latest log.
   */
  private async idleWorkers(
    context: AccessContext,
    from: Date,
    to: Date,
  ): Promise<DashboardOverview['idleWorkers']> {
    const { userIds } = context.scope;
    const where: Prisma.UserWhereInput = {
      organizationId: context.organizationId,
      archivedAt: null,
      AND: [
        userVisibilityWhere(context) as Prisma.UserWhereInput,
        ...(userIds === 'all' ? [] : [{ id: { in: [...userIds] } }]),
        { id: { not: context.userId } },
      ],
      memberships: { some: { archivedAt: null, role: 'worker' } },
      workLogs: { none: { archivedAt: null, occurredAt: { gte: from, lt: to } } },
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          displayName: true,
          memberships: { where: { archivedAt: null }, select: { role: true } },
        },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: IDLE_WORKERS_LIMIT,
      }),
    ]);
    const latest =
      rows.length === 0
        ? []
        : await this.prisma.workLog.groupBy({
            by: ['authorId'],
            where: workLogWhere(context, {}, [{ authorId: { in: rows.map((row) => row.id) } }]),
            _max: { occurredAt: true },
          });
    const lastLogAt = new Map(latest.map((group) => [group.authorId, group._max.occurredAt]));
    const items = rows.map((row): DashboardIdleWorker => ({
      userId: row.id,
      displayName: row.displayName,
      roles: rolesHighestFirst(row.memberships.map((membership) => membership.role)),
      lastLogAt: isoOrNull(lastLogAt.get(row.id) ?? null),
      filter: { authorId: row.id },
    }));
    return { total, items, truncated: total > items.length };
  }

  /**
   * The names behind the ids the caller can meet (Phase 6, `GET /directory`): visible users in
   * the basic shape (name and roles only), visible sites and teams, and the log types; archived
   * records included and flagged. Each kind is capped at `DIRECTORY_MAX_ITEMS`.
   */
  async directory(): Promise<Directory> {
    const context = await this.access.context();
    const { organizationId } = context;
    const take = DIRECTORY_MAX_ITEMS + 1;
    const [users, sites, teams, logTypes] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          organizationId,
          AND: [userVisibilityWhere(context) as Prisma.UserWhereInput],
        },
        select: {
          id: true,
          displayName: true,
          archivedAt: true,
          memberships: { where: { archivedAt: null }, select: { role: true } },
        },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take,
      }),
      this.prisma.site.findMany({
        where: { organizationId, AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput] },
        select: { id: true, name: true, parentId: true, archivedAt: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take,
      }),
      this.prisma.team.findMany({
        where: { organizationId, AND: [teamVisibilityWhere(context) as Prisma.TeamWhereInput] },
        select: { id: true, name: true, parentId: true, archivedAt: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take,
      }),
      this.prisma.logType.findMany({
        where: { organizationId },
        select: { id: true, key: true, name: true, version: true, archivedAt: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take,
      }),
    ]);
    const truncated = [users, sites, teams, logTypes].some(
      (list) => list.length > DIRECTORY_MAX_ITEMS,
    );
    const place = (row: {
      id: string;
      name: string;
      parentId: string | null;
      archivedAt: Date | null;
    }) => ({
      id: row.id,
      name: row.name,
      parentId: row.parentId,
      archived: row.archivedAt !== null,
    });
    return {
      users: users.slice(0, DIRECTORY_MAX_ITEMS).map((row) => ({
        id: row.id,
        displayName: row.displayName,
        roles: rolesHighestFirst(row.memberships.map((membership) => membership.role)),
        archived: row.archivedAt !== null,
      })),
      sites: sites.slice(0, DIRECTORY_MAX_ITEMS).map(place),
      teams: teams.slice(0, DIRECTORY_MAX_ITEMS).map(place),
      logTypes: logTypes.slice(0, DIRECTORY_MAX_ITEMS).map((row) => ({
        id: row.id,
        key: row.key,
        name: row.name,
        version: row.version,
        archived: row.archivedAt !== null,
      })),
      truncated,
    };
  }
}
