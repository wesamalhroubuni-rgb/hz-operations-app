import { Injectable } from '@nestjs/common';
import {
  RECORD_HISTORY_LIMIT,
  TASK_HISTORY_FIELDS,
  WORK_LOG_HISTORY_FIELDS,
  type AuditFieldChange,
  type RecordHistory,
  type RecordHistoryEntry,
} from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { ApiException } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessService,
  attachmentVisibilityWhere,
  taskVisibilityWhere,
  workLogVisibilityWhere,
} from '../access';
import { iso } from '../common/db';
import { userNames } from '../common/names';

interface AuditRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  actorType: 'user' | 'system';
  actorId: string | null;
  changes: unknown;
  metadata: unknown;
}

/**
 * Only the allowed fields of a stored diff (already redacted when it was written), or null
 * when none of them changed. Nothing else of the audit row (before, after, correlation id,
 * device metadata) ever leaves this function.
 */
export function historyChanges(
  changes: unknown,
  allowed: readonly string[],
): Record<string, AuditFieldChange> | null {
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    return null;
  }
  const kept: Record<string, AuditFieldChange> = {};
  for (const field of allowed) {
    const change = (changes as Record<string, unknown>)[field];
    if (typeof change === 'object' && change !== null && 'from' in change && 'to' in change) {
      kept[field] = { from: change.from ?? null, to: change.to ?? null };
    }
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

/** True when the change came from a phone's offline queue (ADR-0008 audit metadata). */
export function isOfflineChange(metadata: unknown): boolean {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    (metadata as Record<string, unknown>).via === 'offline_sync'
  );
}

/**
 * The history of one work log or task, built from the audit log (Phase 6, ADR-0009):
 * `GET /work-logs/:id/history` and `GET /tasks/:id/history`. Visible exactly when the record is
 * (404 otherwise, the same as reading it), role-shaped (an actor's name only when the caller may
 * see that user) and limited to the record's history fields.
 */
@Injectable()
export class RecordHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  /** The log's events, and those of its attachments the caller may see. */
  async workLog(id: string): Promise<RecordHistory> {
    const context = await this.access.context();
    const { organizationId } = context;
    const log = await this.prisma.workLog.findFirst({
      where: {
        id,
        organizationId,
        AND: [workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput],
      },
      select: { id: true },
    });
    if (!log) {
      throw ApiException.notFound('Work log', id);
    }
    const attachments = await this.prisma.attachment.findMany({
      where: {
        workLogId: id,
        organizationId,
        AND: [attachmentVisibilityWhere(context) as Prisma.AttachmentWhereInput],
      },
      select: { id: true },
    });
    return this.history(
      organizationId,
      [
        { entityType: 'work_log', entityId: id },
        ...(attachments.length > 0
          ? [{ entityType: 'attachment', entityId: { in: attachments.map((a) => a.id) } }]
          : []),
      ],
      WORK_LOG_HISTORY_FIELDS,
    );
  }

  async task(id: string): Promise<RecordHistory> {
    const context = await this.access.context();
    const { organizationId } = context;
    const task = await this.prisma.task.findFirst({
      where: {
        id,
        organizationId,
        AND: [taskVisibilityWhere(context) as Prisma.TaskWhereInput],
      },
      select: { id: true },
    });
    if (!task) {
      throw ApiException.notFound('Task', id);
    }
    return this.history(
      organizationId,
      [{ entityType: 'task', entityId: id }],
      TASK_HISTORY_FIELDS,
    );
  }

  private async history(
    organizationId: string,
    entities: Prisma.AuditEventWhereInput[],
    fields: readonly string[],
  ): Promise<RecordHistory> {
    const context = await this.access.context();
    const rows: AuditRow[] = await this.prisma.auditEvent.findMany({
      where: { organizationId, OR: entities },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: RECORD_HISTORY_LIMIT + 1,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        occurredAt: true,
        actorType: true,
        actorId: true,
        changes: true,
        metadata: true,
      },
    });
    const kept = rows.slice(0, RECORD_HISTORY_LIMIT);
    const names = await userNames(
      this.prisma,
      context,
      kept.map((row) => row.actorId),
    );
    const items: RecordHistoryEntry[] = kept.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      occurredAt: iso(row.occurredAt),
      actorType: row.actorType,
      actorId: row.actorType === 'system' ? null : row.actorId,
      actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
      changes: historyChanges(row.changes, fields),
      offline: isOfflineChange(row.metadata),
    }));
    return { items, truncated: rows.length > RECORD_HISTORY_LIMIT };
  }
}
