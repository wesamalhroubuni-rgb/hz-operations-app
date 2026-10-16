import { Injectable } from '@nestjs/common';
import {
  customFieldDefinitionsSchema,
  type CreateLogType,
  type CustomFieldDefinition,
  type ListLogTypesQuery,
  type LogType,
  type Paginated,
  type UpdateLogType,
} from '@ops/shared';
import type { LogType as LogTypeRow, Prisma } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, contains, iso, isoOrNull, isUniqueViolation, type Db } from '../common/db';

/**
 * The field definitions stored on a log type. They were validated when written; a row that
 * somehow holds something else is treated as having no fields rather than crashing a read.
 */
export function fieldsOf(row: Pick<LogTypeRow, 'fields'>): CustomFieldDefinition[] {
  const parsed = customFieldDefinitionsSchema.safeParse(row.fields);
  return parsed.success ? parsed.data : [];
}

export function toLogType(row: LogTypeRow): LogType {
  return {
    id: row.id,
    organizationId: row.organizationId,
    key: row.key,
    name: row.name,
    description: row.description,
    fields: fieldsOf(row),
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/**
 * Every signed-in user of the organization reads log types (they are needed to write a log).
 * Managing them is for managers and admins (route policy `log_type.manage`).
 */
@Injectable()
export class LogTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
  ) {}

  async list(query: ListLogTypesQuery): Promise<Paginated<LogType>> {
    const { organizationId } = await this.access.context();
    const where: Prisma.LogTypeWhereInput = {
      organizationId,
      ...activeUnless(query.includeArchived),
      ...(query.search
        ? { OR: [{ name: contains(query.search) }, { key: contains(query.search) }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.logType.findMany({ where, orderBy: orderByArgs(query.sort), ...pageArgs(query) }),
      this.prisma.logType.count({ where }),
    ]);
    return paginated(rows.map(toLogType), total, query);
  }

  async get(id: string): Promise<LogType> {
    const { organizationId } = await this.access.context();
    return toLogType(await this.find(this.prisma, organizationId, id));
  }

  async create(input: CreateLogType): Promise<LogType> {
    const { organizationId } = await this.access.context();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const logType = toLogType(await tx.logType.create({ data: { ...input, organizationId } }));
        await this.changes.record(tx, {
          organizationId,
          entityType: 'log_type',
          verb: 'created',
          entityId: logType.id,
          after: logType,
        });
        return logType;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiException.conflict(`A log type with key "${input.key}" already exists`, [
          { path: 'key', message: 'is already in use' },
        ]);
      }
      throw error;
    }
  }

  /**
   * Updates the log type. When `fields` is sent and differs from the stored definition, the
   * version goes up by one; work logs written earlier keep the version they were checked against.
   */
  async update(id: string, input: UpdateLogType): Promise<LogType> {
    const { organizationId } = await this.access.context();
    return this.prisma.$transaction(async (tx) => {
      const row = await this.find(tx, organizationId, id);
      if (row.archivedAt) {
        throw ApiException.conflict(`Log type ${id} is archived and cannot be changed`);
      }
      const before = toLogType(row);
      const fieldsChanged =
        input.fields !== undefined &&
        JSON.stringify(input.fields) !== JSON.stringify(before.fields);
      const logType = toLogType(
        await tx.logType.update({
          where: { id },
          data: {
            name: input.name,
            description: input.description,
            ...(fieldsChanged ? { fields: input.fields, version: { increment: 1 } } : {}),
          },
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'log_type',
        verb: 'updated',
        entityId: id,
        before,
        after: logType,
      });
      return logType;
    });
  }

  /** Archiving an archived log type changes and records nothing. Existing logs keep their type. */
  async archive(id: string): Promise<LogType> {
    const { organizationId } = await this.access.context();
    return this.prisma.$transaction(async (tx) => {
      const before = toLogType(await this.find(tx, organizationId, id));
      if (before.archivedAt !== null) {
        return before;
      }
      const logType = toLogType(
        await tx.logType.update({ where: { id }, data: { archivedAt: new Date() } }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'log_type',
        verb: 'archived',
        entityId: id,
        before,
        after: logType,
      });
      return logType;
    });
  }

  private async find(db: Db, organizationId: string, id: string): Promise<LogTypeRow> {
    const row = await db.logType.findFirst({ where: { id, organizationId } });
    if (!row) {
      throw ApiException.notFound('Log type', id);
    }
    return row;
  }
}
