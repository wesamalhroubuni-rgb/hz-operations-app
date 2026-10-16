import { Injectable } from '@nestjs/common';
import type { Attachment, CreateAttachment, ListAttachmentsQuery, Paginated } from '@ops/shared';
import type {
  Attachment as AttachmentRow,
  Prisma,
  WorkLog as WorkLogRow,
} from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessClock,
  AccessService,
  attachmentVisibilityWhere,
  authorOf,
  canChangeAttachments,
  enforce,
  workLogVisibilityWhere,
  type AccessContext,
} from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, iso, isoOrNull, isUniqueViolation, type Db } from '../common/db';
import { loadWorkLogEditWindowHours, workLogFactsOf } from '../work-logs/work-logs.service';

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    organizationId: row.organizationId,
    workLogId: row.workLogId,
    uploadedById: row.uploadedById,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    storageKey: row.storageKey,
    createdAt: iso(row.createdAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/**
 * Attachment metadata only. The bytes are uploaded and served through the `FileStorage`
 * interface (see ../storage), which has no provider until Phase 4; nothing here calls it yet.
 *
 * Attachments follow their work log: whoever can see the log reads them; adding and archiving
 * one follows `canChangeAttachments` (the log's author while they may still change the log, or
 * a reviewer who can see it).
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
    private readonly clock: AccessClock,
  ) {}

  async listForWorkLog(
    workLogId: string,
    query: ListAttachmentsQuery,
  ): Promise<Paginated<Attachment>> {
    const context = await this.access.context();
    await this.findWorkLog(this.prisma, context, workLogId);
    const where: Prisma.AttachmentWhereInput = {
      organizationId: context.organizationId,
      workLogId,
      ...activeUnless(query.includeArchived),
      AND: [attachmentVisibilityWhere(context) as Prisma.AttachmentWhereInput],
    };
    const [rows, total] = await Promise.all([
      this.prisma.attachment.findMany({
        where,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.attachment.count({ where }),
    ]);
    return paginated(rows.map(toAttachment), total, query);
  }

  async get(id: string): Promise<Attachment> {
    const context = await this.access.context();
    return toAttachment((await this.find(this.prisma, context, id)).attachment);
  }

  /** Records a file on a work log. The uploader is the signed-in user. */
  async create(workLogId: string, input: CreateAttachment): Promise<Attachment> {
    const context = await this.access.context();
    const { organizationId } = context;
    const uploadedById = authorOf(context);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const workLog = await this.findWorkLog(tx, context, workLogId);
        await this.assertMayChange(tx, context, workLog);
        if (workLog.archivedAt) {
          throw ApiException.conflict(`Work log ${workLogId} is archived and cannot be changed`);
        }
        const attachment = toAttachment(
          await tx.attachment.create({
            data: { ...input, organizationId, workLogId, uploadedById },
          }),
        );
        await this.changes.record(tx, {
          organizationId,
          entityType: 'attachment',
          verb: 'created',
          entityId: attachment.id,
          after: attachment,
        });
        return attachment;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiException.conflict('An attachment with this storage key already exists', [
          { path: 'storageKey', message: 'is already in use' },
        ]);
      }
      throw error;
    }
  }

  /** Archiving an archived attachment changes and records nothing. The stored file is kept. */
  async archive(id: string): Promise<Attachment> {
    const context = await this.access.context();
    return this.prisma.$transaction(async (tx) => {
      const found = await this.find(tx, context, id);
      const before = toAttachment(found.attachment);
      if (before.archivedAt !== null) {
        return before;
      }
      await this.assertMayChange(tx, context, found.workLog);
      const attachment = toAttachment(
        await tx.attachment.update({ where: { id }, data: { archivedAt: this.clock.now() } }),
      );
      await this.changes.record(tx, {
        organizationId: context.organizationId,
        entityType: 'attachment',
        verb: 'archived',
        entityId: id,
        before,
        after: attachment,
      });
      return attachment;
    });
  }

  /** 403 unless the caller may add or archive attachments on this (visible) work log. */
  private async assertMayChange(
    db: Db,
    context: AccessContext,
    workLog: WorkLogRow,
  ): Promise<void> {
    const editWindowHours = await loadWorkLogEditWindowHours(db, context.organizationId);
    enforce(
      canChangeAttachments(context, workLogFactsOf(workLog), this.clock.now(), editWindowHours),
      'Work log',
      workLog.id,
    );
  }

  /** The attachment and its work log, if the caller may see that log; 404 otherwise. */
  private async find(
    db: Db,
    context: AccessContext,
    id: string,
  ): Promise<{ attachment: AttachmentRow; workLog: WorkLogRow }> {
    const row = await db.attachment.findFirst({
      where: {
        id,
        organizationId: context.organizationId,
        AND: [attachmentVisibilityWhere(context) as Prisma.AttachmentWhereInput],
      },
      include: { workLog: true },
    });
    if (!row) {
      throw ApiException.notFound('Attachment', id);
    }
    const { workLog, ...attachment } = row;
    return { attachment, workLog };
  }

  /** The work log, if the caller may see it; 404 otherwise (also for another organization). */
  private async findWorkLog(
    db: Db,
    context: AccessContext,
    workLogId: string,
  ): Promise<WorkLogRow> {
    const workLog = await db.workLog.findFirst({
      where: {
        id: workLogId,
        organizationId: context.organizationId,
        AND: [workLogVisibilityWhere(context) as Prisma.WorkLogWhereInput],
      },
    });
    if (!workLog) {
      throw ApiException.notFound('Work log', workLogId);
    }
    return workLog;
  }
}
