import { Injectable, Logger } from '@nestjs/common';
import {
  addDays,
  AI_DAY_RANGE_MAX_DAYS,
  ANOMALY_THRESHOLDS,
  OPEN_TASK_STATUSES,
  zonedDayKey,
  zonedDayStart,
  zonedDaysRange,
  type AnomalyFlag,
  type ListAnomaliesQuery,
  type Paginated,
} from '@ops/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessClock, AccessService, type AccessContext } from '../../access';
import { ChangeRecorder } from '../../common/change-recorder';
import { iso, isUniqueViolation } from '../../common/db';
import { loadTimeZone } from '../../common/org-time-zone';
import { dayColumn, dayKeyOfColumn, inclusiveDayRange } from '../day-column';
import {
  dominantLogType,
  farLocationFlags,
  fingerprintOf,
  noActivitySiteFlags,
  repeatedRejectionFlags,
  siteReference,
  slowTaskFlags,
  type CandidateFlag,
  type SiteReference,
} from './anomaly-rules';
import { visibleAnomalyFlagWhere } from './anomaly-visibility';

type AnomalyFlagRow = Prisma.AnomalyFlagGetPayload<object>;

const DAY_MS = 86_400_000;
const OPEN = { in: [...OPEN_TASK_STATUSES] };

/** A stored flag in its wire shape (`anomalyFlagSchema`). */
export function anomalyFlagToWire(row: AnomalyFlagRow): AnomalyFlag {
  return {
    id: row.id,
    organizationId: row.organizationId,
    day: dayKeyOfColumn(row.day),
    kind: row.kind,
    severity: row.severity,
    siteId: row.siteId,
    teamId: row.teamId,
    userId: row.userId,
    taskId: row.taskId,
    workLogId: row.workLogId,
    logTypeId: row.logTypeId,
    params: row.params,
    createdAt: iso(row.createdAt),
  } as AnomalyFlag;
}

/** Newest day first, then the most severe, then by kind (enum order) and id: stable pages. */
const FLAG_ORDER: Prisma.AnomalyFlagOrderByWithRelationInput[] = [
  { day: 'desc' },
  { severity: 'desc' },
  { kind: 'asc' },
  { id: 'asc' },
];

function countsBy<Key extends string>(
  groups: Array<Record<Key, string | null> & { _count: { _all: number } }>,
  key: Key,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const group of groups) {
    const id = group[key];
    if (id) {
      map.set(id, group._count._all);
    }
  }
  return map;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Anomaly flags v1 (Phase 7, ADR-0011 section 4): computes the rules for one organization and day
 * on all of its data (system context), stores each finding once (`fingerprint`), and lists the
 * flags a reader may see (every subject visible, `anomalyFlagVisibilityWhere`).
 */
@Injectable()
export class AnomaliesService {
  private readonly logger = new Logger('AnomalyFlags');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly changes: ChangeRecorder,
    private readonly clock: AccessClock,
  ) {}

  /**
   * Computes and stores the flags of `day` (org-local, in `timeZone`) for one organization.
   * Runs under `runAsSystem`, so it must be called outside a signed-in request. Idempotent: a
   * finding already stored for the day (same kind and subjects) is kept as it is. Returns the
   * number of new flags.
   */
  computeForDay(organizationId: string, day: string, timeZone: string): Promise<number> {
    return this.access.runAsSystem(organizationId, async () => {
      const candidates = await this.evaluate(organizationId, day, timeZone, this.clock.now());
      return this.store(organizationId, day, candidates);
    });
  }

  /** The rules over the organization's current data, for one day. No writes. */
  async evaluate(
    organizationId: string,
    day: string,
    timeZone: string,
    now: Date,
  ): Promise<CandidateFlag[]> {
    const range = zonedDaysRange(day, day, timeZone);
    const dayStart = new Date(range.from);
    const dayEnd = new Date(range.to);
    // Ages are measured at the end of the day, or now while the day is still running.
    const asOf = new Date(Math.min(now.getTime(), dayEnd.getTime()));
    const [noActivity, slow, rejections, far] = await Promise.all([
      this.noActivity(organizationId, day, timeZone, dayStart, dayEnd, asOf),
      this.slowTasks(organizationId, asOf),
      this.rejections(organizationId, day, timeZone, dayEnd),
      this.farLocations(organizationId, day, timeZone, dayStart, dayEnd),
    ]);
    return [...noActivity, ...slow, ...rejections, ...far];
  }

  private async noActivity(
    organizationId: string,
    day: string,
    timeZone: string,
    dayStart: Date,
    dayEnd: Date,
    /** Overdue is measured at this moment: the end of the day, or now while it runs. */
    asOf: Date,
  ): Promise<CandidateFlag[]> {
    const lookbackStart = zonedDayStart(
      addDays(day, -(ANOMALY_THRESHOLDS.activeSiteLookbackDays - 1)),
      timeZone,
    );
    const logs = { organizationId, archivedAt: null, siteId: { not: null } };
    const tasks = { organizationId, archivedAt: null, siteId: { not: null }, status: OPEN };
    const [sites, open, overdue, lookback, onDay, before] = await Promise.all([
      this.prisma.site.findMany({
        where: { organizationId, archivedAt: null, createdAt: { lt: dayEnd } },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
      this.prisma.task.groupBy({ by: ['siteId'], where: tasks, _count: { _all: true } }),
      this.prisma.task.groupBy({
        by: ['siteId'],
        where: { ...tasks, dueAt: { lt: asOf } },
        _count: { _all: true },
      }),
      this.prisma.workLog.groupBy({
        by: ['siteId'],
        where: { ...logs, occurredAt: { gte: lookbackStart, lt: dayEnd } },
        _count: { _all: true },
      }),
      this.prisma.workLog.groupBy({
        by: ['siteId'],
        where: { ...logs, occurredAt: { gte: dayStart, lt: dayEnd } },
        _count: { _all: true },
      }),
      this.prisma.workLog.groupBy({
        by: ['siteId'],
        where: { ...logs, occurredAt: { lt: dayStart } },
        _max: { occurredAt: true },
      }),
    ]);
    const openBySite = countsBy(open, 'siteId');
    const overdueBySite = countsBy(overdue, 'siteId');
    const lookbackBySite = countsBy(lookback, 'siteId');
    const onDayBySite = countsBy(onDay, 'siteId');
    const lastBySite = new Map(before.map((group) => [group.siteId, group._max.occurredAt]));
    return noActivitySiteFlags(
      sites.map((site) => ({
        siteId: site.id,
        openTasks: openBySite.get(site.id) ?? 0,
        overdueOpenTasks: overdueBySite.get(site.id) ?? 0,
        logsInLookback: lookbackBySite.get(site.id) ?? 0,
        logsOnDay: onDayBySite.get(site.id) ?? 0,
        lastLogBeforeDay: lastBySite.get(site.id) ?? null,
      })),
    );
  }

  private async slowTasks(organizationId: string, asOf: Date): Promise<CandidateFlag[]> {
    const open = await this.prisma.task.findMany({
      where: {
        organizationId,
        archivedAt: null,
        status: OPEN,
        siteId: { not: null },
        createdAt: { lt: asOf },
      },
      select: { id: true, siteId: true, createdAt: true },
      orderBy: { id: 'asc' },
    });
    if (open.length === 0) {
      return [];
    }
    const siteIds = [...new Set(open.map((task) => task.siteId!))];
    const completed = await this.prisma.task.findMany({
      where: {
        organizationId,
        archivedAt: null,
        status: 'done',
        siteId: { in: siteIds },
        completedAt: {
          gte: new Date(asOf.getTime() - ANOMALY_THRESHOLDS.slowTaskLookbackDays * DAY_MS),
          lt: asOf,
        },
      },
      select: { id: true, siteId: true, createdAt: true, completedAt: true },
    });
    const typed = await this.prisma.workLog.groupBy({
      by: ['taskId', 'logTypeId'],
      where: {
        organizationId,
        archivedAt: null,
        logTypeId: { not: null },
        taskId: { in: [...open, ...completed].map((task) => task.id) },
      },
      _count: { _all: true },
    });
    const typesByTask = new Map<string, Array<string | null>>();
    for (const group of typed) {
      if (group.taskId) {
        const list = typesByTask.get(group.taskId) ?? [];
        list.push(...Array<string | null>(group._count._all).fill(group.logTypeId));
        typesByTask.set(group.taskId, list);
      }
    }
    const dominant = (taskId: string) => dominantLogType(typesByTask.get(taskId) ?? []);
    return slowTaskFlags(
      open.map((task) => ({
        taskId: task.id,
        siteId: task.siteId,
        createdAt: task.createdAt,
        dominantLogTypeId: dominant(task.id),
      })),
      completed.map((task) => ({
        siteId: task.siteId,
        createdAt: task.createdAt,
        completedAt: task.completedAt!,
        dominantLogTypeId: dominant(task.id),
      })),
      asOf,
    );
  }

  /**
   * Rejections are counted from the audit log (`work_log.status_changed` into `rejected`), so a
   * later resubmission or approval does not hide them; a corrected note on an already rejected
   * log is not a new rejection. Archived users get no flag.
   */
  private async rejections(
    organizationId: string,
    day: string,
    timeZone: string,
    dayEnd: Date,
  ): Promise<CandidateFlag[]> {
    const windowStart = zonedDayStart(
      addDays(day, -(ANOMALY_THRESHOLDS.repeatedRejectionsWindowDays - 1)),
      timeZone,
    );
    const events = await this.prisma.auditEvent.findMany({
      where: {
        organizationId,
        action: 'work_log.status_changed',
        occurredAt: { gte: windowStart, lt: dayEnd },
      },
      select: { before: true, after: true },
    });
    const authors: string[] = [];
    for (const event of events) {
      const after = asRecord(event.after);
      const before = asRecord(event.before);
      if (after?.status === 'rejected' && before?.status !== 'rejected') {
        if (typeof after.authorId === 'string') {
          authors.push(after.authorId);
        }
      }
    }
    if (authors.length === 0) {
      return [];
    }
    const active = await this.prisma.user.findMany({
      where: { organizationId, archivedAt: null, id: { in: [...new Set(authors)] } },
      select: { id: true },
    });
    const activeIds = new Set(active.map((user) => user.id));
    return repeatedRejectionFlags(authors.filter((id) => activeIds.has(id)));
  }

  private async farLocations(
    organizationId: string,
    day: string,
    timeZone: string,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<CandidateFlag[]> {
    const located = {
      organizationId,
      archivedAt: null,
      latitude: { not: null },
      longitude: { not: null },
    };
    const logs = await this.prisma.workLog.findMany({
      where: { ...located, siteId: { not: null }, occurredAt: { gte: dayStart, lt: dayEnd } },
      select: { id: true, siteId: true, latitude: true, longitude: true },
      orderBy: { id: 'asc' },
    });
    if (logs.length === 0) {
      return [];
    }
    const siteIds = [...new Set(logs.map((log) => log.siteId!))];
    const sites = await this.prisma.site.findMany({
      where: { organizationId, id: { in: siteIds } },
      select: { id: true, latitude: true, longitude: true },
    });
    const withoutCoordinates = sites
      .filter((site) => site.latitude === null || site.longitude === null)
      .map((site) => site.id);
    const history =
      withoutCoordinates.length === 0
        ? []
        : await this.prisma.workLog.findMany({
            where: {
              ...located,
              siteId: { in: withoutCoordinates },
              occurredAt: {
                gte: zonedDayStart(
                  addDays(day, -(ANOMALY_THRESHOLDS.farLocationLookbackDays - 1)),
                  timeZone,
                ),
                lt: dayEnd,
              },
            },
            select: { siteId: true, latitude: true, longitude: true },
          });
    const references = new Map<string, SiteReference>();
    for (const site of sites) {
      const points = history
        .filter((log) => log.siteId === site.id)
        .map((log) => ({ latitude: log.latitude!, longitude: log.longitude! }));
      const reference = siteReference(site, points);
      if (reference) {
        references.set(site.id, reference);
      }
    }
    return farLocationFlags(
      logs.map((log) => ({
        workLogId: log.id,
        siteId: log.siteId!,
        latitude: log.latitude!,
        longitude: log.longitude!,
      })),
      references,
    );
  }

  /**
   * Stores the findings not stored yet, each in its own transaction with its audit and outbox
   * event (`anomaly_flag.created`). A finding stored meanwhile by another process loses on the
   * unique fingerprint and is skipped.
   */
  private async store(
    organizationId: string,
    day: string,
    candidates: readonly CandidateFlag[],
  ): Promise<number> {
    if (candidates.length === 0) {
      return 0;
    }
    const withPrints = candidates.map((flag) => ({
      flag,
      fingerprint: fingerprintOf(flag.kind, day, flag.subjects),
    }));
    const existing = await this.prisma.anomalyFlag.findMany({
      where: { organizationId, fingerprint: { in: withPrints.map((item) => item.fingerprint) } },
      select: { fingerprint: true },
    });
    const known = new Set(existing.map((row) => row.fingerprint));
    let created = 0;
    for (const { flag, fingerprint } of withPrints) {
      if (known.has(fingerprint)) {
        continue;
      }
      known.add(fingerprint);
      try {
        await this.prisma.$transaction(async (tx) => {
          const row = await tx.anomalyFlag.create({
            data: {
              organizationId,
              day: dayColumn(day),
              kind: flag.kind,
              severity: flag.severity,
              siteId: flag.subjects.siteId ?? null,
              teamId: flag.subjects.teamId ?? null,
              userId: flag.subjects.userId ?? null,
              taskId: flag.subjects.taskId ?? null,
              workLogId: flag.subjects.workLogId ?? null,
              logTypeId: flag.subjects.logTypeId ?? null,
              params: flag.params,
              fingerprint,
            },
          });
          await this.changes.record(tx, {
            organizationId,
            entityType: 'anomaly_flag',
            verb: 'created',
            entityId: row.id,
            after: anomalyFlagToWire(row),
          });
        });
        created += 1;
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }
    }
    if (created > 0) {
      this.logger.log(`${created} anomaly flag(s) for organization ${organizationId} on ${day}`);
    }
    return created;
  }

  /** `GET /ai/anomalies`: the flags of a day range whose every subject the caller may see. */
  async list(query: ListAnomaliesQuery): Promise<Paginated<AnomalyFlag>> {
    const context = await this.access.context();
    const timeZone = await loadTimeZone(this.prisma, context.organizationId);
    const today = zonedDayKey(this.clock.now(), timeZone);
    const { from, to } = inclusiveDayRange(query, today, AI_DAY_RANGE_MAX_DAYS);
    const base: Prisma.AnomalyFlagWhereInput = {
      organizationId: context.organizationId,
      day: { gte: dayColumn(from), lte: dayColumn(to) },
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };
    const where = await visibleAnomalyFlagWhere(this.prisma, context, base);
    const [total, rows] = await Promise.all([
      this.prisma.anomalyFlag.count({ where }),
      this.prisma.anomalyFlag.findMany({
        where,
        orderBy: FLAG_ORDER,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      items: rows.map(anomalyFlagToWire),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /** Every flag of one day that this context may see, most severe first. */
  async visibleForDay(context: AccessContext, day: string): Promise<AnomalyFlag[]> {
    const where = await visibleAnomalyFlagWhere(this.prisma, context, {
      organizationId: context.organizationId,
      day: dayColumn(day),
    });
    const rows = await this.prisma.anomalyFlag.findMany({ where, orderBy: FLAG_ORDER });
    return rows.map(anomalyFlagToWire);
  }
}
