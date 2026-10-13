import { Controller, Get, HttpStatus, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  auditEventListSchema,
  auditEventSchema,
  idSchema,
  listAuditEventsQuerySchema,
  type AuditEvent,
  type ListAuditEventsQuery,
  type Paginated,
} from '@ops/shared';
import { ApiDocs, ZodPipe } from '../http';
import { AuditQueryService } from './audit-query.service';

/** Read-only by design: audit events are written only through `AuditService.record`. */
@ApiTags('audit-events')
@Controller('audit-events')
export class AuditEventsController {
  constructor(private readonly audit: AuditQueryService) {}

  @Get()
  @ApiDocs({
    summary: 'List audit events of your organization',
    description:
      'Append-only log of who changed what. `action` matches exactly, or as a prefix when it ' +
      'ends with a dot or an asterisk (`task.` matches every task action). `from` (inclusive) and `to` ' +
      '(exclusive) bound `occurredAt`. Sort: `occurredAt:desc` (default) or `occurredAt:asc`.',
    query: listAuditEventsQuerySchema,
    response: auditEventListSchema,
  })
  list(
    @Query(new ZodPipe(listAuditEventsQuerySchema)) query: ListAuditEventsQuery,
  ): Promise<Paginated<AuditEvent>> {
    return this.audit.list(query);
  }

  @Get(':id')
  @ApiDocs({
    summary: 'Get one audit event',
    params: { id: idSchema },
    response: auditEventSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<AuditEvent> {
    return this.audit.get(id);
  }
}
