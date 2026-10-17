import { Injectable } from '@nestjs/common';
import {
  customFieldValuesSchema,
  validateCustomFieldValues,
  WORK_LOG_MAX_FUTURE_MS,
  type ChangeWorkLogStatus,
  workLogEditWindowHoursOf,
  type CreateWorkLog,
  type CustomFieldValues,
  type ListWorkLogsQuery,
  type Paginated,
  type UpdateWorkLog,
  type WorkLog,
  type WorkLogLocationInput,
} from '@ops/shared';
import type { Prisma, WorkLog as WorkLogRow } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessClock,
  AccessService,
  authorOf,
  canArchiveWorkLog,
  canChangeWorkLogStatus,
  canEditWorkLog,
  enforce,
  siteVisibilityWhere,
  taskVisibilityWhere,
  teamVisibilityWhere,
  workLogVisibilityWhere,
  type AccessContext,
  type WorkLogFacts,
} from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, iso, isoOrNull, isUniqueViolation, type Db } from '../common/db';
import { assertActiveReferences, ref, type Reference } from '../common/references';
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
    review:
      row.reviewedById !== null && row.reviewedAt !== null
        ? { reviewedById: row.reviewedById, reviewedAt: iso(row.reviewedAt), note: row.reviewNote }
        : null,
    source: row.source,
    aiMetadata: (row.aiMetadata ?? null) as WorkLog['aiMetadata'],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/** What the access rules read from a work log. */
export function workLogFactsOf(row: WorkLogRow): WorkLogFacts {
  return {
    authorId: row.authorId,
    siteId: row.siteId,
    teamId: row.teamId,
    status: row.status,
    createdAt: row.createdAt,
  };
}

/** The edit window of an organization, in hours (the default when it has not set one). */
export async function loadWorkLogEditWindowHours(db: Db, organizationId: string): Promise<number> {
  const organization = await db.organization.findUnique({
    where: { id: organizationId },
    select: { settings: true },
  });
  return workLogEditWindowHoursOf(organization?.settings);
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
function assertNotInFuture(occurredAt: string | undefined, now: Date): void {
  if (occurredAt && new Date(occurredAt).getTime() > now.getTime() + WORK_LOG_MAX_FUTURE_MS) {
    throw ApiException.validation([{ path: 'occurredAt', message: 'must not be in the future' }]);
  }
}

/** 409 for a write to an archived log. Checked after the permission, so a 403 comes first. */
function assertNotArchived(row: WorkLogRow): void {
  if (row.archivedAt) {
    throw ApiException.conflict(`Work log ${row.id} is archived and cannot be changed`);
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
    private readonly access: AccessService,
    private readonly clock: AccessClock,
  ) {}

  /** The work logs the caller may see. The filters asked for can only narrow that set. */
  async list(query: ListWorkLogsQuery): Promise<Paginated<WorkLog>> {
    const context = await this.access.context();
    const where: Prisma.WorkLogWhereInput = {
      organizationId: context.organizationId,
      ...activeUnless(query.includeArchived),
      AND: [workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput],
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

  async get(id: string): Promise<WorkLog> {
    return toWorkLog(await this.find(this.prisma, await this.access.context(), id));
  }

  /**
   * Creates a work log of the signed-in user: the author is never taken from the request.
   *
   * Idempotent on `clientId`: when the caller already has a log with that client id (a retried
   * upload), that log is returned as it is, nothing is written and no audit or outbox event is
   * recorded. A `clientId` that belongs to somebody else's log is a 409, never their log.
   */
  async create(input: CreateWorkLog): Promise<CreateWorkLogResult> {
    const context = await this.access.context();
    const { organizationId } = context;
    const authorId = authorOf(context);

    const existing = await this.findOwnByClientId(organizationId, authorId, input.clientId);
    if (existing) {
      return { workLog: existing, created: false };
    }
    assertNotInFuture(input.occurredAt, this.clock.now());

    try {
      const workLog = await this.prisma.$transaction(async (tx) => {
        await assertActiveReferences(tx, organizationId, this.references(context, input));
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
      // (organizationId, clientId) and this transaction rolled back. Return the winner's log
      // (or 409 when the winner is somebody else).
      if (isUniqueViolation(error)) {
        const winner = await this.findOwnByClientId(organizationId, authorId, input.clientId);
        if (winner) {
          return { workLog: winner, created: false };
        }
      }
      throw error;
    }
  }

  /**
   * Edits the content of a log: its author only, inside the organization's edit window and
   * while the log is not approved (`canEditWorkLog`).
   */
  async update(id: string, input: UpdateWorkLog): Promise<WorkLog> {
    const context = await this.access.context();
    const { organizationId } = context;
    const now = this.clock.now();
    assertNotInFuture(input.occurredAt, now);
    return this.prisma.$transaction(async (tx) => {
      const row = await this.find(tx, context, id);
      const editWindowHours = await loadWorkLogEditWindowHours(tx, organizationId);
      enforce(canEditWorkLog(context, workLogFactsOf(row), now, editWindowHours), 'Work log', id);
      assertNotArchived(row);
      await assertActiveReferences(tx, organizationId, this.references(context, input));
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

  /**
   * Moves a log to another status, per the transition table (`WORK_LOG_TRANSITIONS`): the
   * author between draft and submitted, a reviewer to approved or rejected and back, never
   * their own log. Setting the status the log already has changes and records nothing.
   *
   * Approving or rejecting records the reviewer, the time and the note (`review`; the schema
   * requires a note for `rejected` and accepts one only for approved/rejected). Going back to
   * submitted (or draft) clears them.
   *
   * Outbox payload of `work_log.status_changed`: `{ from, to, note, changedById, authorId,
   * reviewedById, workLog }` (`reviewedById` and `note` are null unless the new status is
   * approved or rejected).
   */
  async changeStatus(id: string, input: ChangeWorkLogStatus): Promise<WorkLog> {
    const context = await this.access.context();
    const { organizationId } = context;
    const { status } = input;
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const row = await this.find(tx, context, id);
      const before = toWorkLog(row);
      const reviewed = status === 'approved' || status === 'rejected';
      const note = reviewed ? (input.note ?? null) : null;
      // The same status is a no-op, unless a reviewer gives a different note for the same
      // decision (a corrected rejection reason): that updates the review, as a task's reason does.
      if (before.status === status && (!reviewed || note === (before.review?.note ?? null))) {
        return before;
      }
      const editWindowHours = await loadWorkLogEditWindowHours(tx, organizationId);
      enforce(
        canChangeWorkLogStatus(context, workLogFactsOf(row), status, now, editWindowHours),
        'Work log',
        id,
      );
      assertNotArchived(row);
      const changedById = authorOf(context);
      const workLog = toWorkLog(
        await tx.workLog.update({
          where: { id },
          data: {
            status,
            reviewedById: reviewed ? changedById : null,
            reviewedAt: reviewed ? now : null,
            reviewNote: note,
          },
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'work_log',
        verb: 'status_changed',
        entityId: id,
        before,
        after: workLog,
        extra: {
          from: before.status,
          to: status,
          note,
          changedById,
          authorId: workLog.authorId,
          reviewedById: reviewed ? changedById : null,
        },
      });
      return workLog;
    });
  }

  /**
   * Archives a log: its author under the edit rule, or a reviewer who can see it and did not
   * write it (`canArchiveWorkLog`). Archiving an archived log changes and records nothing.
   */
  async archive(id: string): Promise<WorkLog> {
    const context = await this.access.context();
    const { organizationId } = context;
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const row = await this.find(tx, context, id);
      const before = toWorkLog(row);
      if (before.archivedAt !== null) {
        return before;
      }
      const editWindowHours = await loadWorkLogEditWindowHours(tx, organizationId);
      enforce(
        canArchiveWorkLog(context, workLogFactsOf(row), now, editWindowHours),
        'Work log',
        id,
      );
      const workLog = toWorkLog(
        await tx.workLog.update({ where: { id }, data: { archivedAt: now } }),
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
   * The references of a create or update body. The task, the site and the team must be ones
   * the caller may see: a log cannot be attached to something outside the caller's scope, and
   * an id outside it is reported exactly like one that does not exist. Log types are visible
   * to everyone in the organization.
   */
  private references(
    context: AccessContext,
    input: Pick<UpdateWorkLog, 'taskId' | 'siteId' | 'teamId' | 'logTypeId'>,
  ): Reference[] {
    return [
      ...ref('task', 'taskId', input.taskId, taskVisibilityWhere(context)),
      ...ref('site', 'siteId', input.siteId, siteVisibilityWhere(context)),
      ...ref('team', 'teamId', input.teamId, teamVisibilityWhere(context)),
      ...ref('log_type', 'logTypeId', input.logTypeId),
    ];
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

  /**
   * The caller's own log with this client id, or null when there is none. A log with this
   * client id written by somebody else is a 409: the caller must not receive it, and cannot
   * reuse the id.
   */
  private async findOwnByClientId(
    organizationId: string,
    authorId: string,
    clientId: string,
  ): Promise<WorkLog | null> {
    const row = await this.prisma.workLog.findUnique({
      where: { organizationId_clientId: { organizationId, clientId } },
    });
    if (!row) {
      return null;
    }
    if (row.authorId !== authorId) {
      throw ApiException.conflict('This clientId has already been used', [
        { path: 'clientId', message: 'is already in use' },
      ]);
    }
    return toWorkLog(row);
  }

  /** The log, if the caller may see it; 404 otherwise (also for another organization). */
  private async find(db: Db, context: AccessContext, id: string): Promise<WorkLogRow> {
    const row = await db.workLog.findFirst({
      where: {
        id,
        organizationId: context.organizationId,
        AND: [workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput],
      },
    });
    if (!row) {
      throw ApiException.notFound('Work log', id);
    }
    return row;
  }
}
