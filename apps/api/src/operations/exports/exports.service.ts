import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  EXPORT_MAX_ROWS,
  formatSortableInTimeZone,
  TASK_EXPORT_COLUMNS,
  toCsv,
  WORK_LOG_EXPORT_COLUMNS,
  zonedDayKey,
  type CsvValue,
  type ExportTasksQuery,
  type ExportWorkLogsQuery,
  type SortSpec,
} from '@ops/shared';
import { ApiException, orderByArgs } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessClock, AccessService } from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { iso } from '../common/db';
import { logTypeNames, nameIn, siteNames, taskTitles, teamNames, userNames } from '../common/names';
import { loadTimeZone } from '../common/org-time-zone';
import { taskWhere } from '../tasks/task-query';
import { ATTACHMENT_COUNT, workLogWhere } from '../work-logs/work-log-query';

/** A finished CSV file: the text (BOM included) and the name to save it under. */
export interface CsvFile {
  fileName: string;
  content: string;
  rowCount: number;
}

type WorkLogColumn = (typeof WORK_LOG_EXPORT_COLUMNS)[number][0];
type TaskColumn = (typeof TASK_EXPORT_COLUMNS)[number][0];

/** The filters as they go into the audit event: plain values, the sort as `field:direction`. */
function filtersForAudit(query: { sort: SortSpec<string> } & Record<string, unknown>) {
  const { sort, ...filters } = query;
  const kept = Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== undefined),
  );
  return { ...kept, sort: `${sort.field}:${sort.direction}` };
}

function tooLarge(count: number): ApiException {
  return ApiException.of(
    'export_too_large',
    `The export would hold ${count} rows; at most ${EXPORT_MAX_ROWS} are allowed. Narrow the filters.`,
  );
}

/**
 * CSV exports of work logs and tasks (Phase 6, ADR-0009). The rows are exactly those of the
 * list with the same filters (`workLogWhere` / `taskWhere`: the caller's visibility, narrowed by
 * the filters), in the list's sort order. Names are resolved through the caller's visibility:
 * a name the caller may not see is left empty. Cells go through `toCsv` (quoting and formula
 * neutralisation) and the file starts with a UTF-8 BOM. Every export, even of zero rows, is
 * audited with its filters and row count (audit only, no outbox event).
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly changes: ChangeRecorder,
    private readonly clock: AccessClock,
  ) {}

  async workLogs(query: ExportWorkLogsQuery): Promise<CsvFile> {
    const context = await this.access.context();
    const { organizationId } = context;
    const now = this.clock.now();
    const where = workLogWhere(context, query);
    const count = await this.prisma.workLog.count({ where });
    if (count > EXPORT_MAX_ROWS) {
      throw tooLarge(count);
    }
    const [rows, timeZone] = await Promise.all([
      this.prisma.workLog.findMany({
        where,
        include: ATTACHMENT_COUNT,
        orderBy: orderByArgs(query.sort),
        take: EXPORT_MAX_ROWS,
      }),
      loadTimeZone(this.prisma, organizationId),
    ]);
    const [users, sites, teams, logTypes, tasks] = await Promise.all([
      userNames(
        this.prisma,
        context,
        rows.flatMap((row) => [row.authorId, row.reviewedById]),
      ),
      siteNames(
        this.prisma,
        context,
        rows.map((row) => row.siteId),
      ),
      teamNames(
        this.prisma,
        context,
        rows.map((row) => row.teamId),
      ),
      logTypeNames(
        this.prisma,
        context,
        rows.map((row) => row.logTypeId),
      ),
      taskTitles(
        this.prisma,
        context,
        rows.map((row) => row.taskId),
      ),
    ]);
    const lines = rows.map((row) => {
      const cells: Record<WorkLogColumn, CsvValue> = {
        id: row.id,
        occurredAtLocal: formatSortableInTimeZone(row.occurredAt, timeZone),
        timeZone,
        occurredAtUtc: iso(row.occurredAt),
        status: row.status,
        author: nameIn(users, row.authorId),
        site: nameIn(sites, row.siteId),
        team: nameIn(teams, row.teamId),
        logType: nameIn(logTypes, row.logTypeId),
        task: nameIn(tasks, row.taskId),
        text: row.text,
        customFields:
          row.customFields && Object.keys(row.customFields as object).length > 0
            ? JSON.stringify(row.customFields)
            : null,
        photoCount: row._count.attachments,
        latitude: row.latitude,
        longitude: row.longitude,
        accuracyMeters: row.locationAccuracy,
        reviewedBy: nameIn(users, row.reviewedById),
        reviewedAtLocal: formatSortableInTimeZone(row.reviewedAt, timeZone),
        reviewNote: row.reviewNote,
        submittedOffline: row.submittedOffline,
        createdAtUtc: iso(row.createdAt),
      };
      return WORK_LOG_EXPORT_COLUMNS.map(([key]) => cells[key]);
    });
    const content = toCsv(
      WORK_LOG_EXPORT_COLUMNS.map(([, label]) => label),
      lines,
    );
    await this.changes.recordAccess(this.prisma, {
      organizationId,
      action: 'export.work_logs',
      entityType: 'export',
      entityId: randomUUID(),
      after: { format: 'csv', filters: filtersForAudit(query), rowCount: rows.length },
    });
    return {
      fileName: `work-logs-${zonedDayKey(now, timeZone)}.csv`,
      content,
      rowCount: rows.length,
    };
  }

  async tasks(query: ExportTasksQuery): Promise<CsvFile> {
    const context = await this.access.context();
    const { organizationId } = context;
    const now = this.clock.now();
    const where = taskWhere(context, query, now);
    const count = await this.prisma.task.count({ where });
    if (count > EXPORT_MAX_ROWS) {
      throw tooLarge(count);
    }
    const [rows, timeZone] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: { assignees: { select: { userId: true }, orderBy: { userId: 'asc' } } },
        orderBy: orderByArgs(query.sort),
        take: EXPORT_MAX_ROWS,
      }),
      loadTimeZone(this.prisma, organizationId),
    ]);
    const [users, sites, teams] = await Promise.all([
      userNames(
        this.prisma,
        context,
        rows.flatMap((row) => [row.createdById, ...row.assignees.map((a) => a.userId)]),
      ),
      siteNames(
        this.prisma,
        context,
        rows.map((row) => row.siteId),
      ),
      teamNames(
        this.prisma,
        context,
        rows.map((row) => row.teamId),
      ),
    ]);
    const lines = rows.map((row) => {
      const cells: Record<TaskColumn, CsvValue> = {
        id: row.id,
        title: row.title,
        status: row.status,
        statusReason: row.statusReason,
        priority: row.priority,
        site: nameIn(sites, row.siteId),
        team: nameIn(teams, row.teamId),
        assignees: row.assignees
          .map((assignee) => nameIn(users, assignee.userId))
          .filter((name): name is string => name !== null)
          .join('; '),
        createdBy: nameIn(users, row.createdById),
        dueAtLocal: formatSortableInTimeZone(row.dueAt, timeZone),
        completedAtLocal: formatSortableInTimeZone(row.completedAt, timeZone),
        timeZone,
        description: row.description,
        createdAtUtc: iso(row.createdAt),
        updatedAtUtc: iso(row.updatedAt),
      };
      return TASK_EXPORT_COLUMNS.map(([key]) => cells[key]);
    });
    const content = toCsv(
      TASK_EXPORT_COLUMNS.map(([, label]) => label),
      lines,
    );
    await this.changes.recordAccess(this.prisma, {
      organizationId,
      action: 'export.tasks',
      entityType: 'export',
      entityId: randomUUID(),
      after: { format: 'csv', filters: filtersForAudit(query), rowCount: rows.length },
    });
    return {
      fileName: `tasks-${zonedDayKey(now, timeZone)}.csv`,
      content,
      rowCount: rows.length,
    };
  }
}
