import { Injectable } from '@nestjs/common';
import {
  customFieldValuesSchema,
  validateCustomFieldValues,
  WORK_LOG_MAX_FUTURE_MS,
  type CreateWorkLog,
  type CustomFieldValues,
  type ListWorkLogsQuery,
  type Paginated,
  type UpdateWorkLog,
  type WorkLog,
  type WorkLogLocationInput,
  type WorkLogStatus,
} from '@ops/shared';
import type { Prisma, WorkLog as WorkLogRow } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, iso, isoOrNull, isUniqueViolation, type Db } from '../common/db';
import { assertActiveReferences, ref } from '../common/references';
import { fieldsOf } from '../log-types/log-types.service';

export function toWorkLog(row: WorkLogRow): WorkLog {
  const customFields = customFieldValuesSchema.safeParse(row.customFields);
  return {
    id: row.id,
    organizationId: row.organizationId,
    clientId: row.clientId,
    authorId: row.authorId,
    occurredAt: iso(row.occurredAt),
    taskId: row.taskId,
    siteId: row.siteId,
    teamId: row.teamId,
    logTypeId: row.logTypeId,
    logTypeVersion: row.logTypeVersion,
    text: row.text,
    customFields: customFields.success ? customFields.data : {},
    location:
      row.latitude !== null && row.longitude !== null
        ? { latitude: row.latitude, longitude: row.longitude, accuracy: row.locationAccuracy }
        : null,
    status: row.status,
    source: row.source,
    aiMetadata: (row.aiMetadata ?? null) as WorkLog['aiMetadata'],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/** The three location columns for a location value from a request (null clears them). */
function locationColumns(location: WorkLogLocationInput | null) {
  return {
    latitude: location?.latitude ?? null,
    longitude: location?.longitude ?? null,
    locationAccuracy: location?.accuracy ?? null,
  };
}

/** Work is logged after it happened; only a small margin for a fast phone clock is allowed. */
function assertNotInFuture(occurredAt: string | undefined): void {
  if (occurredAt && new Date(occurredAt).getTime() > Date.now() + WORK_LOG_MAX_FUTURE_MS) {
    throw ApiException.validation([{ path: 'occurredAt', message: 'must not be in the future' }]);
  }
}

export interface CreateWorkLogResult {
  workLog: WorkLog;
  /** False when a log with the same `clientId` already existed and was returned unchanged. */
  created: boolean;
}

@Injectable()
export class WorkLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async list(organizationId: string, query: ListWorkLogsQuery): Promise<Paginated<WorkLog>> {
    const where: Prisma.WorkLogWhereInput = {
      organizationId,
      ...activeUnless(query.includeArchived),
      ...(query.authorId ? { authorId: query.authorId } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.taskId ? { taskId: query.taskId } : {}),
      ...(query.logTypeId ? { logTypeId: query.logTypeId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.source ? { source: query.source } : {}),
      ...(query.occurredFrom || query.occurredTo
        ? {
            occurredAt: {
              ...(query.occurredFrom ? { gte: new Date(query.occurredFrom) } : {}),
              ...(query.occurredTo ? { lt: new Date(query.occurredTo) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workLog.findMany({ where, orderBy: orderByArgs(query.sort), ...pageArgs(query) }),
      this.prisma.workLog.count({ where }),
    ]);
    return paginated(rows.map(toWorkLog), total, query);
  }

  async get(organizationId: string, id: string): Promise<WorkLog> {
    return toWorkLog(await this.find(this.prisma, organizationId, id));
  }

  /**
   * Creates a work log, idempotently on `clientId`: when the organization already has a log
   * with that client id (a retried upload), that log is returned as it is, nothing is written
   * and no audit or outbox event is recorded.
   *
   * @param actorUserId the acting user; the author unless the body names another one
   */
  async create(
    organizationId: string,
    actorUserId: string,
    input: CreateWorkLog,
  ): Promise<CreateWorkLogResult> {
    const existing = await this.findByClientId(organizationId, input.clientId);
    if (existing) {
      return { workLog: existing, created: false };
    }
    assertNotInFuture(input.occurredAt);
    const authorId = input.authorId ?? actorUserId;

    try {
      const workLog = await this.prisma.$transaction(async (tx) => {
        await assertActiveReferences(tx, organizationId, [
          ...ref('user', 'authorId', authorId),
          ...ref('task', 'taskId', input.taskId),
          ...ref('site', 'siteId', input.siteId),
          ...ref('team', 'teamId', input.teamId),
          ...ref('log_type', 'logTypeId', input.logTypeId),
        ]);
        const custom = await this.resolveCustomFields(
          tx,
          organizationId,
          input.logTypeId ?? null,
          input.customFields,
        );
        const created = toWorkLog(
          await tx.workLog.create({
            data: {
              organizationId,
              clientId: input.clientId,
              authorId,
              occurredAt: new Date(input.occurredAt),
              taskId: input.taskId,
              siteId: input.siteId,
              teamId: input.teamId,
              logTypeId: input.logTypeId,
              text: input.text,
              status: input.status,
              source: input.source,
              ...custom,
              ...locationColumns(input.location ?? null),
            },
          }),
        );
        await this.changes.record(tx, {
          organizationId,
          entityType: 'work_log',
          verb: 'created',
          entityId: created.id,
          after: created,
        });
        return created;
      });
      return { workLog, created: true };
    } catch (error) {
      // Two identical requests arrived together: the other one won the unique index on
      // (organizationId, clientId) and this transaction rolled back. Return the winner's log.
      if (isUniqueViolation(error)) {
        const winner = await this.findByClientId(organizationId, input.clientId);
        if (winner) {
          return { workLog: winner, created: false };
        }
      }
      throw error;
    }
  }

  async update(organizationId: string, id: string, input: UpdateWorkLog): Promise<WorkLog> {
    assertNotInFuture(input.occurredAt);
    return this.prisma.$transaction(async (tx) => {
      const row = await this.findActive(tx, organizationId, id);
      await assertActiveReferences(tx, organizationId, [
        ...ref('task', 'taskId', input.taskId),
        ...ref('site', 'siteId', input.siteId),
        ...ref('team', 'teamId', input.teamId),
        ...ref('log_type', 'logTypeId', input.logTypeId),
      ]);
      // Changing the log type or the values re-validates the result against the current
      // definition, which is also the version recorded on the log from then on.
      const custom =
        input.logTypeId !== undefined || input.customFields !== undefined
          ? await this.resolveCustomFields(
              tx,
              organizationId,
              input.logTypeId !== undefined ? input.logTypeId : row.logTypeId,
              input.customFields ?? row.customFields,
            )
          : {};
      const workLog = toWorkLog(
        await tx.workLog.update({
          where: { id },
          data: {
            occurredAt: input.occurredAt ? new Date(input.occurredAt) : undefined,
            taskId: input.taskId,
            siteId: input.siteId,
            teamId: input.teamId,
            logTypeId: input.logTypeId,
            text: input.text,
            ...custom,
            ...(input.location !== undefined ? locationColumns(input.location) : {}),
          },
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'work_log',
        verb: 'updated',
        entityId: id,
        before: toWorkLog(row),
        after: workLog,
      });
      return workLog;
    });
  }

  /** Setting the status the log already has changes and records nothing. */
  async changeStatus(organizationId: string, id: string, status: WorkLogStatus): Promise<WorkLog> {
    return this.prisma.$transaction(async (tx) => {
      const before = toWorkLog(await this.findActive(tx, organizationId, id));
      if (before.status === status) {
        return before;
      }
      const workLog = toWorkLog(await tx.workLog.update({ where: { id }, data: { status } }));
      await this.changes.record(tx, {
        organizationId,
        entityType: 'work_log',
        verb: 'status_changed',
        entityId: id,
        before,
        after: workLog,
        extra: { from: before.status, to: status },
      });
      return workLog;
    });
  }

  /** Archiving an archived work log changes and records nothing. */
  async archive(organizationId: string, id: string): Promise<WorkLog> {
    return this.prisma.$transaction(async (tx) => {
      const before = toWorkLog(await this.find(tx, organizationId, id));
      if (before.archivedAt !== null) {
        return before;
      }
      const workLog = toWorkLog(
        await tx.workLog.update({ where: { id }, data: { archivedAt: new Date() } }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'work_log',
        verb: 'archived',
        entityId: id,
        before,
        after: workLog,
      });
      return workLog;
    });
  }

  /**
   * Validates custom field values against the log type's current definition and returns the
   * columns to store. Without a log type there is nothing to validate against, so the values
   * must be empty.
   */
  private async resolveCustomFields(
    db: Db,
    organizationId: string,
    logTypeId: string | null,
    values: unknown,
  ): Promise<{ customFields: CustomFieldValues; logTypeVersion: number | null }> {
    const logType = logTypeId
      ? await db.logType.findFirst({ where: { id: logTypeId, organizationId } })
      : null;
    if (logTypeId && !logType) {
      throw ApiException.notFound('Log type', logTypeId);
    }
    const result = validateCustomFieldValues(logType ? fieldsOf(logType) : [], values);
    if (!result.ok) {
      throw ApiException.validation(
        logType
          ? result.issues
          : [{ path: 'customFields', message: 'must be empty when the log has no log type' }],
        'The custom fields are not valid for this log type',
      );
    }
    return { customFields: result.values, logTypeVersion: logType?.version ?? null };
  }

  private async findByClientId(organizationId: string, clientId: string): Promise<WorkLog | null> {
    const row = await this.prisma.workLog.findUnique({
      where: { organizationId_clientId: { organizationId, clientId } },
    });
    return row ? toWorkLog(row) : null;
  }

  private async find(db: Db, organizationId: string, id: string): Promise<WorkLogRow> {
    const row = await db.workLog.findFirst({ where: { id, organizationId } });
    if (!row) {
      throw ApiException.notFound('Work log', id);
    }
    return row;
  }

  private async findActive(db: Db, organizationId: string, id: string): Promise<WorkLogRow> {
    const row = await this.find(db, organizationId, id);
    if (row.archivedAt) {
      throw ApiException.conflict(`Work log ${id} is archived and cannot be changed`);
    }
    return row;
  }
}
