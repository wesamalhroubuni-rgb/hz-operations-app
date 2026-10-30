import { Injectable } from '@nestjs/common';
import {
  addDays,
  REPORT_MAX_LOGS,
  WORK_LOG_EXCERPT_LENGTH,
  zonedDayKey,
  type WorkLogReport,
  type WorkLogReportQuery,
} from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessClock, AccessService } from '../access';
import { iso } from '../common/db';
import {
  logTypeNames,
  nameIn,
  siteNames,
  teamNames,
  userNames,
  type NameMap,
} from '../common/names';
import { loadTimeZone } from '../common/org-time-zone';
import {
  ATTACHMENT_COUNT,
  excerptOf,
  READY_ATTACHMENTS,
  workLogWhere,
} from '../work-logs/work-log-query';

type Group = { id: string | null; name: string | null; count: number };

function groups(rows: Array<{ key: string | null; count: number }>, names: NameMap): Group[] {
  return rows
    .map((row) => ({ id: row.key, name: nameIn(names, row.key), count: row.count }))
    .sort((a, b) => b.count - a.count || (a.name ?? '').localeCompare(b.name ?? ''));
}

/** Every day from the day of `from` to the day before `to` (exclusive end), in a time zone. */
export function daysOfRange(from: Date, to: Date, timeZone: string): string[] {
  const first = zonedDayKey(from, timeZone);
  const last = zonedDayKey(new Date(to.getTime() - 1), timeZone);
  const days: string[] = [];
  for (let day = first; day <= last && days.length < 400; day = addDays(day, 1)) {
    days.push(day);
  }
  return days;
}

/**
 * The printable work-log report (Phase 6, `GET /reports/work-logs`): totals and groupings of
 * the visible, non-archived logs of a range (the same `where` as the list with these filters),
 * plus the newest `REPORT_MAX_LOGS` rows. Counts are aggregate queries; only the per-day series
 * reads one column per log, because a day in the organization's time zone is not a column.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly clock: AccessClock,
  ) {}

  async workLogs(query: WorkLogReportQuery): Promise<WorkLogReport> {
    const context = await this.access.context();
    const timeZone = await loadTimeZone(this.prisma, context.organizationId);
    const where = workLogWhere(context, query);
    const db = this.prisma;

    const [byStatus, withPhotos, withLocation, bySite, byTeam, byLogType, byWorker, times, rows] =
      await Promise.all([
        db.workLog.groupBy({ by: ['status'], where, _count: { _all: true } }),
        db.workLog.count({ where: { AND: [where, { attachments: { some: READY_ATTACHMENTS } }] } }),
        db.workLog.count({
          where: { AND: [where, { latitude: { not: null } }, { longitude: { not: null } }] },
        }),
        db.workLog.groupBy({ by: ['siteId'], where, _count: { _all: true } }),
        db.workLog.groupBy({ by: ['teamId'], where, _count: { _all: true } }),
        db.workLog.groupBy({ by: ['logTypeId'], where, _count: { _all: true } }),
        db.workLog.groupBy({ by: ['authorId', 'status'], where, _count: { _all: true } }),
        db.workLog.findMany({ where, select: { occurredAt: true } }),
        db.workLog.findMany({
          where,
          select: {
            id: true,
            occurredAt: true,
            authorId: true,
            siteId: true,
            teamId: true,
            logTypeId: true,
            status: true,
            text: true,
            ...ATTACHMENT_COUNT,
          },
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: REPORT_MAX_LOGS,
        }),
      ]);

    const [users, sites, teams, logTypes] = await Promise.all([
      userNames(db, context, [...byWorker.map((g) => g.authorId), ...rows.map((r) => r.authorId)]),
      siteNames(
        db,
        context,
        bySite.map((g) => g.siteId),
      ),
      teamNames(
        db,
        context,
        byTeam.map((g) => g.teamId),
      ),
      logTypeNames(
        db,
        context,
        byLogType.map((g) => g.logTypeId),
      ),
    ]);

    const status = (name: string) =>
      byStatus.find((group) => group.status === name)?._count._all ?? 0;
    const logs = byStatus.reduce((sum, group) => sum + group._count._all, 0);

    const perDay = new Map<string, number>();
    for (const { occurredAt } of times) {
      const day = zonedDayKey(occurredAt, timeZone);
      perDay.set(day, (perDay.get(day) ?? 0) + 1);
    }
    const from = new Date(query.occurredFrom);
    const to = new Date(query.occurredTo);

    const workers = new Map<string, { count: number; approved: number; rejected: number }>();
    for (const group of byWorker) {
      const entry = workers.get(group.authorId) ?? { count: 0, approved: 0, rejected: 0 };
      entry.count += group._count._all;
      if (group.status === 'approved') {
        entry.approved += group._count._all;
      }
      if (group.status === 'rejected') {
        entry.rejected += group._count._all;
      }
      workers.set(group.authorId, entry);
    }

    return {
      generatedAt: iso(this.clock.now()),
      timeZone,
      occurredFrom: iso(from),
      occurredTo: iso(to),
      totals: {
        logs,
        draft: status('draft'),
        submitted: status('submitted'),
        approved: status('approved'),
        rejected: status('rejected'),
        withPhotos,
        withLocation,
      },
      byDay: daysOfRange(from, to, timeZone).map((day) => ({ day, count: perDay.get(day) ?? 0 })),
      bySite: groups(
        bySite.map((g) => ({ key: g.siteId, count: g._count._all })),
        sites,
      ),
      byTeam: groups(
        byTeam.map((g) => ({ key: g.teamId, count: g._count._all })),
        teams,
      ),
      byLogType: groups(
        byLogType.map((g) => ({ key: g.logTypeId, count: g._count._all })),
        logTypes,
      ),
      byWorker: [...workers.entries()]
        .map(([authorId, entry]) => ({
          authorId,
          displayName: users.get(authorId) ?? null,
          ...entry,
        }))
        .sort(
          (a, b) => b.count - a.count || (a.displayName ?? '').localeCompare(b.displayName ?? ''),
        ),
      logs: rows.map((row) => ({
        id: row.id,
        occurredAt: iso(row.occurredAt),
        authorId: row.authorId,
        authorName: nameIn(users, row.authorId),
        siteName: nameIn(sites, row.siteId),
        teamName: nameIn(teams, row.teamId),
        logTypeName: nameIn(logTypes, row.logTypeId),
        status: row.status,
        excerpt: excerptOf(row.text, WORK_LOG_EXCERPT_LENGTH),
        attachmentCount: row._count.attachments,
      })),
      logsTruncated: logs > rows.length,
    };
  }
}
