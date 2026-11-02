import { Injectable } from '@nestjs/common';
import {
  ANOMALY_KINDS,
  zonedDaysRange,
  type AnomalyFlag,
  type DailySummaryPlaceStats,
  type DailySummaryScope,
  type DailySummaryStats,
  type ListFilter,
} from '@ops/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { userVisibilityWhere, type AccessContext } from '../../access';
import { siteNames, taskTitles, teamNames, userNames, type NameMap } from '../../common/names';
import { taskWhere } from '../../tasks/task-query';
import { workLogWhere } from '../../work-logs/work-log-query';
import { AnomaliesService } from '../anomalies/anomalies.service';
import type { FactNames } from './summary-facts';

/** Everything a summary is made of, computed for one recipient. */
export interface RecipientSummaryData {
  scope: DailySummaryScope;
  stats: DailySummaryStats;
  anomalies: AnomalyFlag[];
  /** Visible names of the subjects of the flags (for the facts given to the model). */
  names: FactNames;
  completedTaskTitles: string[];
}

type Group<Key extends string> = Record<Key, string | null> & { _count: { _all: number } };

function countsBy<Key extends string>(groups: Group<Key>[], key: Key): Map<string | null, number> {
  return new Map(groups.map((group) => [group[key], group._count._all]));
}

interface PlaceGroups<Key extends string> {
  logs: Group<Key>[];
  open: Group<Key>[];
  overdue: Group<Key>[];
  blocked: Group<Key>[];
  completed: Group<Key>[];
}

/**
 * One row per place with activity (logs, completed tasks) or open tasks, most logs first, then
 * most open tasks, the row without a place last, then by name. A place the recipient may not see
 * by itself keeps its id but no name (as on the dashboard).
 */
export function placeStats<Key extends string>(
  groups: PlaceGroups<Key>,
  key: Key,
  names: NameMap,
): DailySummaryPlaceStats[] {
  const maps = {
    logs: countsBy(groups.logs, key),
    open: countsBy(groups.open, key),
    overdue: countsBy(groups.overdue, key),
    blocked: countsBy(groups.blocked, key),
    completed: countsBy(groups.completed, key),
  };
  const ids = new Set<string | null>([
    ...maps.logs.keys(),
    ...maps.open.keys(),
    ...maps.completed.keys(),
  ]);
  return [...ids]
    .map((id): DailySummaryPlaceStats => ({
      id,
      name: id ? (names.get(id) ?? null) : null,
      logs: maps.logs.get(id) ?? 0,
      tasksOpen: maps.open.get(id) ?? 0,
      tasksOverdue: maps.overdue.get(id) ?? 0,
      tasksBlocked: maps.blocked.get(id) ?? 0,
      tasksCompleted: maps.completed.get(id) ?? 0,
    }))
    .filter((row) => row.logs > 0 || row.tasksOpen > 0 || row.tasksCompleted > 0)
    .sort(
      (a, b) =>
        b.logs - a.logs ||
        b.tasksOpen - a.tasksOpen ||
        (a.id === null ? 1 : 0) - (b.id === null ? 1 : 0) ||
        (a.name ?? '').localeCompare(b.name ?? '') ||
        (a.id ?? '').localeCompare(b.id ?? ''),
    );
}

/** The recipient's scope as stored with the summary (ids, never names). */
export function scopeSnapshot(context: AccessContext): DailySummaryScope {
  const { scope } = context;
  return {
    roles: [...context.roles],
    orgWide: scope.orgWide,
    siteIds: [...scope.siteIds].sort(),
    teamIds: [...scope.teamIds].sort(),
    peopleCount:
      scope.orgWide || scope.userIds === 'all'
        ? null
        : new Set([...scope.userIds, context.userId]).size,
  };
}

/**
 * The facts of a daily summary for ONE recipient (Phase 7, ADR-0011 section 3), computed with
 * the recipient's access context (`AccessService.runAsUser`) through the same query builders as
 * the dashboard (`workLogWhere`, `taskWhere`) and the visibility filters, so every count and name
 * is one the recipient's own dashboard would show. Aggregate queries only.
 */
@Injectable()
export class SummaryStatsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly anomalies: AnomaliesService,
  ) {}

  async compute(
    context: AccessContext,
    day: string,
    timeZone: string,
    now: Date,
  ): Promise<RecipientSummaryData> {
    const range = zonedDaysRange(day, day, timeZone);
    const dayStart = new Date(range.from);
    const dayEnd = new Date(range.to);
    const dayFilter: ListFilter = { occurredFrom: range.from, occurredTo: range.to };
    const inDay = { gte: dayStart, lt: dayEnd };

    const logsOfDay = workLogWhere(context, dayFilter);
    const reviewed = (status: 'approved' | 'rejected') =>
      workLogWhere(context, { status }, [{ reviewedAt: inDay }]);
    const awaiting = workLogWhere(context, { status: 'submitted', excludeOwn: true });
    const open = taskWhere(context, { open: true }, now);
    // Overdue in the summary: open with a due time before the end of the day, or before now
    // while the day is still running (as the anomaly rules measure it).
    const asOf = new Date(Math.min(now.getTime(), dayEnd.getTime()));
    const overdue = taskWhere(context, { overdue: true }, asOf);
    const blocked = taskWhere(context, { status: 'blocked' }, now);
    const completed: Prisma.TaskWhereInput = {
      AND: [taskWhere(context, {}, now), { completedAt: inDay }],
    };
    const created: Prisma.TaskWhereInput = {
      AND: [taskWhere(context, {}, now), { createdAt: inDay }],
    };
    const groupLogs = (by: 'siteId' | 'teamId') =>
      this.prisma.workLog.groupBy({ by: [by], where: logsOfDay, _count: { _all: true } });
    const groupTasks = (by: 'siteId' | 'teamId', where: Prisma.TaskWhereInput) =>
      this.prisma.task.groupBy({ by: [by], where, _count: { _all: true } });

    const [
      byStatus,
      aiAssisted,
      reviewsApproved,
      reviewsRejected,
      awaitingCount,
      openCount,
      overdueCount,
      blockedCount,
      completedCount,
      createdCount,
      workers,
      siteGroups,
      teamGroups,
      completedTasks,
      anomalies,
    ] = await Promise.all([
      this.prisma.workLog.groupBy({ by: ['status'], where: logsOfDay, _count: { _all: true } }),
      this.prisma.workLog.count({ where: { AND: [logsOfDay, { source: 'ai_assisted' }] } }),
      this.prisma.workLog.count({ where: reviewed('approved') }),
      this.prisma.workLog.count({ where: reviewed('rejected') }),
      this.prisma.workLog.count({ where: awaiting }),
      this.prisma.task.count({ where: open }),
      this.prisma.task.count({ where: overdue }),
      this.prisma.task.count({ where: blocked }),
      this.prisma.task.count({ where: completed }),
      this.prisma.task.count({ where: created }),
      this.workers(context, dayStart, dayEnd),
      Promise.all([
        groupLogs('siteId'),
        groupTasks('siteId', open),
        groupTasks('siteId', overdue),
        groupTasks('siteId', blocked),
        groupTasks('siteId', completed),
      ]),
      Promise.all([
        groupLogs('teamId'),
        groupTasks('teamId', open),
        groupTasks('teamId', overdue),
        groupTasks('teamId', blocked),
        groupTasks('teamId', completed),
      ]),
      this.prisma.task.findMany({
        where: completed,
        select: { title: true },
        orderBy: [{ completedAt: 'asc' }, { id: 'asc' }],
        take: 10,
      }),
      this.anomalies.visibleForDay(context, day),
    ]);

    const statusCount = (status: string) =>
      byStatus.find((group) => group.status === status)?._count._all ?? 0;
    const [siteLogs, siteOpen, siteOverdue, siteBlocked, siteCompleted] = siteGroups;
    const [teamLogs, teamOpen, teamOverdue, teamBlocked, teamCompleted] = teamGroups;
    const placeIds = (groups: Array<Array<Record<string, unknown>>>, key: string) =>
      groups.flat().map((group) => group[key] as string | null);

    const [sites, teams, flagSites, flagTasks, flagUsers] = await Promise.all([
      siteNames(this.prisma, context, placeIds([siteLogs, siteOpen, siteCompleted], 'siteId')),
      teamNames(this.prisma, context, placeIds([teamLogs, teamOpen, teamCompleted], 'teamId')),
      siteNames(
        this.prisma,
        context,
        anomalies.map((flag) => flag.siteId),
      ),
      taskTitles(
        this.prisma,
        context,
        anomalies.map((flag) => flag.taskId),
      ),
      userNames(
        this.prisma,
        context,
        anomalies.map((flag) => flag.userId),
      ),
    ]);

    const byKind = Object.fromEntries(
      ANOMALY_KINDS.map((kind) => [kind, anomalies.filter((flag) => flag.kind === kind).length]),
    ) as DailySummaryStats['anomalies']['byKind'];

    const stats: DailySummaryStats = {
      day,
      timeZone,
      dayStart: range.from,
      dayEnd: range.to,
      logs: {
        total: byStatus.reduce((sum, group) => sum + group._count._all, 0),
        draft: statusCount('draft'),
        submitted: statusCount('submitted'),
        approved: statusCount('approved'),
        rejected: statusCount('rejected'),
        aiAssisted,
      },
      reviews: { approved: reviewsApproved, rejected: reviewsRejected },
      awaitingApproval: awaitingCount,
      tasks: {
        open: openCount,
        overdue: overdueCount,
        blocked: blockedCount,
        completed: completedCount,
        created: createdCount,
      },
      workers,
      bySite: placeStats(
        {
          logs: siteLogs,
          open: siteOpen,
          overdue: siteOverdue,
          blocked: siteBlocked,
          completed: siteCompleted,
        },
        'siteId',
        sites,
      ),
      byTeam: placeStats(
        {
          logs: teamLogs,
          open: teamOpen,
          overdue: teamOverdue,
          blocked: teamBlocked,
          completed: teamCompleted,
        },
        'teamId',
        teams,
      ),
      anomalies: { total: anomalies.length, byKind },
    };

    return {
      scope: scopeSnapshot(context),
      stats,
      anomalies,
      names: { sites: flagSites, tasks: flagTasks, users: flagUsers },
      completedTaskTitles: completedTasks.map((task) => task.title),
    };
  }

  /**
   * The recipient's people with an active worker membership (everyone for an organization-wide
   * recipient), the recipient excluded: with a log in the day (active) and without (idle). The
   * same population as the dashboard's idle workers.
   */
  private async workers(
    context: AccessContext,
    from: Date,
    to: Date,
  ): Promise<DailySummaryStats['workers']> {
    const { userIds } = context.scope;
    const logOfDay = { archivedAt: null, occurredAt: { gte: from, lt: to } };
    const base: Prisma.UserWhereInput = {
      organizationId: context.organizationId,
      archivedAt: null,
      AND: [
        userVisibilityWhere(context) as Prisma.UserWhereInput,
        ...(userIds === 'all' ? [] : [{ id: { in: [...userIds] } }]),
        { id: { not: context.userId } },
      ],
      memberships: { some: { archivedAt: null, role: 'worker' } },
    };
    const [active, idle] = await Promise.all([
      this.prisma.user.count({ where: { ...base, workLogs: { some: logOfDay } } }),
      this.prisma.user.count({ where: { ...base, workLogs: { none: logOfDay } } }),
    ]);
    return { active, idle };
  }
}
