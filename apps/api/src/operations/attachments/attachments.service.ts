import { Injectable } from '@nestjs/common';
import type { Attachment, CreateAttachment, ListAttachmentsQuery, Paginated } from '@ops/shared';
import type { Attachment as AttachmentRow, Prisma } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, iso, isoOrNull, isUniqueViolation, type Db } from '../common/db';
import { assertActiveReferences, ref } from '../common/references';

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
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async listForWorkLog(
    organizationId: string,
    workLogId: string,
    query: ListAttachmentsQuery,
  ): Promise<Paginated<Attachment>> {
    await this.findWorkLog(this.prisma, organizationId, workLogId);
    const where: Prisma.AttachmentWhereInput = {
      organizationId,
      workLogId,
      ...activeUnless(query.includeArchived),
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

  async get(organizationId: string, id: string): Promise<Attachment> {
    return toAttachment(await this.find(this.prisma, organizationId, id));
  }

  /** @param uploadedById the acting user, recorded as the uploader */
  async create(
    organizationId: string,
    uploadedById: string,
    workLogId: string,
    input: CreateAttachment,
  ): Promise<Attachment> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const workLog = await this.findWorkLog(tx, organizationId, workLogId);
        if (workLog.archivedAt) {
          throw ApiException.conflict(`Work log ${workLogId} is archived and cannot be changed`);
        }
        await assertActiveReferences(tx, organizationId, ref('user', 'uploadedById', uploadedById));
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
  async archive(organizationId: string, id: string): Promise<Attachment> {
    return this.prisma.$transaction(async (tx) => {
      const before = toAttachment(await this.find(tx, organizationId, id));
      if (before.archivedAt !== null) {
        return before;
      }
      const attachment = toAttachment(
        await tx.attachment.update({ where: { id }, data: { archivedAt: new Date() } }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'attachment',
        verb: 'archived',
        entityId: id,
        before,
        after: attachment,
      });
      return attachment;
    });
  }

  private async find(db: Db, organizationId: string, id: string): Promise<AttachmentRow> {
    const row = await db.attachment.findFirst({ where: { id, organizationId } });
    if (!row) {
      throw ApiException.notFound('Attachment', id);
    }
    return row;
  }

  private async findWorkLog(
    db: Db,
    organizationId: string,
    workLogId: string,
  ): Promise<{ archivedAt: Date | null }> {
    const workLog = await db.workLog.findFirst({
      where: { id: workLogId, organizationId },
      select: { archivedAt: true },
    });
    if (!workLog) {
      throw ApiException.notFound('Work log', workLogId);
    }
    return workLog;
  }
}
