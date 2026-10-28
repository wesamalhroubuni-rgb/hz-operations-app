import { Injectable } from '@nestjs/common';
import { SYNC_WINDOW_DAYS, type SyncPullQuery, type SyncPullResponse } from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { ApiException } from '../../platform/http';
import { toAppNotification } from '../../platform/notifications/notification-inbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessClock,
  AccessService,
  siteVisibilityWhere,
  taskVisibilityWhere,
  teamVisibilityWhere,
  workLogVisibilityWhere,
} from '../access';
import { toLogType } from '../log-types/log-types.service';
import { toOrganizationSummary } from '../organization/organization.service';
import { toSite } from '../sites/sites.service';
import { TASK_INCLUDE, toTask } from '../tasks/tasks.service';
import { toTeam } from '../teams/teams.service';
import { toWorkLog } from '../work-logs/work-logs.service';
import { changedSince, decodeSyncCursor, encodeSyncCursor, scopeFingerprint } from './sync-cursor';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Most recent first, then by id, so a page of upserts is stable. */
const NEWEST_FIRST = [{ updatedAt: 'desc' as const }, { id: 'asc' as const }];

/**
 * `GET /sync/pull` (ADR-0008 section 6): what the phone caches for offline work, for the
 * signed-in user only. Every query goes through the resource's visibility filter
 * (`xxxVisibilityWhere`) and is narrowed further (assigned tasks, own logs, own notifications);
 * nothing is ever selected by raw id.
 *
 * `ids` is always the complete set the phone should hold now, so it deletes everything else
 * (archived, out of scope, aged out). `upserts` are the records changed since the cursor's time
 * minus `SYNC_CURSOR_OVERLAP_SECONDS`, or all of them on a full pull. Log types, sites and teams
 * are always sent in full.
 */
@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly clock: AccessClock,
  ) {}

  async pull(query: SyncPullQuery): Promise<SyncPullResponse> {
    const context = await this.access.context();
    const { organizationId, userId } = context;
    // Taken before any read: a change committed while this pull runs is in the next delta. The
    // cursor runs on the process clock, the one updatedAt is stamped with; the windows run on
    // the rules' clock (the same in production, movable in tests).
    const serverTime = new Date();
    const now = this.clock.now();
    const fingerprint = scopeFingerprint(context);
    const cursorTime = decodeSyncCursor(query.cursor, fingerprint, serverTime);
    const since = cursorTime ? changedSince(cursorTime) : null;
    const windowStart = new Date(now.getTime() - SYNC_WINDOW_DAYS * DAY_MS);
    const changed = since ? { updatedAt: { gte: since } } : {};

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
    });
    if (!organization) {
      throw ApiException.notFound('Organization', organizationId);
    }

    const taskWhere: Prisma.TaskWhereInput = {
      organizationId,
      archivedAt: null,
      AND: [
        taskVisibilityWhere(context) as Prisma.TaskWhereInput,
        { assignees: { some: { userId } } },
        { OR: [{ status: { notIn: ['done', 'cancelled'] } }, { updatedAt: { gte: windowStart } }] },
      ],
    };
    const workLogWhere: Prisma.WorkLogWhereInput = {
      organizationId,
      archivedAt: null,
      authorId: userId,
      AND: [
        workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput,
        { OR: [{ createdAt: { gte: windowStart } }, { occurredAt: { gte: windowStart } }] },
      ],
    };
    const siteWhere: Prisma.SiteWhereInput = {
      organizationId,
      archivedAt: null,
      AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput],
    };
    const teamWhere: Prisma.TeamWhereInput = {
      organizationId,
      archivedAt: null,
      AND: [teamVisibilityWhere(context) as Prisma.TeamWhereInput],
    };
    const notificationWhere: Prisma.NotificationWhereInput = {
      organizationId,
      recipientId: userId,
      createdAt: { gte: windowStart },
    };
    const idOnly = { select: { id: true }, orderBy: { id: 'asc' as const } };

    const [
      taskIds,
      tasks,
      logTypes,
      sites,
      teams,
      workLogIds,
      workLogs,
      notificationIds,
      notifications,
    ] = await Promise.all([
      this.prisma.task.findMany({ where: taskWhere, ...idOnly }),
      this.prisma.task.findMany({
        where: { ...taskWhere, ...changed },
        include: TASK_INCLUDE,
        orderBy: NEWEST_FIRST,
      }),
      this.prisma.logType.findMany({
        where: { organizationId, archivedAt: null },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.site.findMany({ where: siteWhere, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      this.prisma.team.findMany({ where: teamWhere, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      this.prisma.workLog.findMany({ where: workLogWhere, ...idOnly }),
      this.prisma.workLog.findMany({
        where: { ...workLogWhere, ...changed },
        orderBy: NEWEST_FIRST,
      }),
      this.prisma.notification.findMany({ where: notificationWhere, ...idOnly }),
      this.prisma.notification.findMany({
        where: {
          ...notificationWhere,
          ...(since ? { OR: [{ createdAt: { gte: since } }, { readAt: { gte: since } }] } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    ]);

    const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
    return {
      serverTime: serverTime.toISOString(),
      cursor: encodeSyncCursor(serverTime, fingerprint),
      full: since === null,
      organization: toOrganizationSummary(organization),
      tasks: { upserts: tasks.map(toTask), ids: ids(taskIds) },
      logTypes: { upserts: logTypes.map(toLogType), ids: ids(logTypes) },
      sites: { upserts: sites.map(toSite), ids: ids(sites) },
      teams: { upserts: teams.map(toTeam), ids: ids(teams) },
      workLogs: { upserts: workLogs.map(toWorkLog), ids: ids(workLogIds) },
      notifications: {
        upserts: notifications.map(toAppNotification),
        ids: ids(notificationIds),
      },
    };
  }
}
