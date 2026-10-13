/**
 * Audit log reader (reusable platform component).
 *
 * Host requirements: `PrismaService` exposing an `auditEvent` table with the columns of
 * `auditEventSchema` in the shared package, and an acting user in `RequestContext`. Every read
 * is limited to the actor's organization.
 */
import { Injectable } from '@nestjs/common';
import type { AuditEvent, ListAuditEventsQuery, Paginated } from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ApiException,
  dateRangeFilter,
  nameFilter,
  orderByArgs,
  pageArgs,
  paginated,
  requireActor,
} from '../http';

/** An audit row as the database client returns it. */
export interface AuditEventRow {
  id: string;
  organizationId: string | null;
  actorType: 'user' | 'system';
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  changes: unknown;
  correlationId: string | null;
  occurredAt: Date;
}

/** The wire form of an audit row. */
export function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    organizationId: row.organizationId,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    before: row.before ?? null,
    after: row.after ?? null,
    changes: (row.changes ?? null) as AuditEvent['changes'],
    correlationId: row.correlationId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

/** Read side of the audit log. There is no update or delete: the log is append-only. */
@Injectable()
export class AuditQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListAuditEventsQuery): Promise<Paginated<AuditEvent>> {
    const where = {
      organizationId: requireActor().organizationId,
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
      action: nameFilter(query.action),
      correlationId: query.correlationId,
      occurredAt: dateRangeFilter(query.from, query.to),
    };
    const [rows, total] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.auditEvent.count({ where }),
    ]);
    return paginated(rows.map(toAuditEvent), total, query);
  }

  async get(id: string): Promise<AuditEvent> {
    const row = await this.prisma.auditEvent.findFirst({
      where: { id, organizationId: requireActor().organizationId },
    });
    if (!row) {
      throw ApiException.notFound('Audit event', id);
    }
    return toAuditEvent(row);
  }
}
