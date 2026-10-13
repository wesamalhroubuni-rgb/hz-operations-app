/**
 * Event outbox reader for the internal/testing HTTP API (reusable platform component).
 *
 * Host requirements: `PrismaService` exposing an `outboxEvent` table with the columns of
 * `outboxEventSchema` in the shared package, and an acting user in `RequestContext`. Every read
 * is limited to the actor's organization.
 */
import { Injectable } from '@nestjs/common';
import type { ListOutboxEventsQuery, OutboxEvent, Paginated } from '@ops/shared';
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
import type { OutboxEventRow } from './outbox.service';

/** The wire form of an outbox row: the 64-bit `sequence` becomes a decimal string. */
export function toOutboxEvent(row: OutboxEventRow): OutboxEvent {
  return {
    id: row.id,
    sequence: row.sequence.toString(),
    organizationId: row.organizationId,
    eventType: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload ?? null,
    actorId: row.actorId,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
  };
}

/** `processed=true`: handled events only; `processed=false`: events still waiting. */
export function processedFilter(processed: boolean | undefined): null | { not: null } | undefined {
  if (processed === undefined) {
    return undefined;
  }
  return processed ? { not: null } : null;
}

@Injectable()
export class OutboxQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListOutboxEventsQuery): Promise<Paginated<OutboxEvent>> {
    const where = {
      organizationId: requireActor().organizationId,
      eventType: nameFilter(query.eventType),
      aggregateType: query.aggregateType,
      aggregateId: query.aggregateId,
      sequence: query.afterSequence === undefined ? undefined : { gt: BigInt(query.afterSequence) },
      occurredAt: dateRangeFilter(query.from, query.to),
      processedAt: processedFilter(query.processed),
    };
    const [rows, total] = await Promise.all([
      this.prisma.outboxEvent.findMany({
        where,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.outboxEvent.count({ where }),
    ]);
    return paginated(rows.map(toOutboxEvent), total, query);
  }

  async get(id: string): Promise<OutboxEvent> {
    const row = await this.prisma.outboxEvent.findFirst({
      where: { id, organizationId: requireActor().organizationId },
    });
    if (!row) {
      throw ApiException.notFound('Outbox event', id);
    }
    return toOutboxEvent(row);
  }
}
