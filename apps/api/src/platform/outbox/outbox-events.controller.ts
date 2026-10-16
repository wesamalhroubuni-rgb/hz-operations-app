import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  idSchema,
  listOutboxEventsQuerySchema,
  outboxEventListSchema,
  outboxEventSchema,
  type ListOutboxEventsQuery,
  type OutboxEvent,
  type Paginated,
} from '@ops/shared';
import { DevelopmentOnly, Policy } from '../authz/policy.decorator';
import { ApiDocs, ZodPipe } from '../http';
import { OutboxQueryService } from './outbox-query.service';

/** Read-only view of the outbox, for internal and testing use. Events are written in services. */
@ApiTags('outbox-events (internal)')
@Controller('outbox-events')
@Policy('outbox.read')
@DevelopmentOnly()
export class OutboxEventsController {
  constructor(private readonly outbox: OutboxQueryService) {}

  @Get()
  @ApiDocs({
    summary: 'List domain events of your organization (internal/testing)',
    description:
      'INTERNAL / TESTING ONLY: not a product API and subject to change. Domain events are ' +
      'written in the same transaction as the change they describe. `eventType` matches ' +
      'exactly, or as a prefix when it ends with a dot or an asterisk (`task.`). ' +
      '`afterSequence` is the consumer cursor: only events with a greater sequence are ' +
      'returned. `sequence` is a 64-bit integer sent as a string. Sort: `sequence:asc` ' +
      '(default), `sequence:desc`, `occurredAt:asc`, `occurredAt:desc`.',
    query: listOutboxEventsQuerySchema,
    response: outboxEventListSchema,
  })
  list(
    @Query(new ZodPipe(listOutboxEventsQuerySchema)) query: ListOutboxEventsQuery,
  ): Promise<Paginated<OutboxEvent>> {
    return this.outbox.list(query);
  }

  @Get(':id')
  @ApiDocs({
    summary: 'Get one domain event (internal/testing)',
    description: 'INTERNAL / TESTING ONLY: not a product API and subject to change.',
    params: { id: idSchema },
    response: outboxEventSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<OutboxEvent> {
    return this.outbox.get(id);
  }
}
