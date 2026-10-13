import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  attachmentListSchema,
  attachmentSchema,
  createAttachmentSchema,
  idSchema,
  listAttachmentsQuerySchema,
  type Attachment,
  type CreateAttachment,
  type ListAttachmentsQuery,
  type Paginated,
} from '@ops/shared';
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { AttachmentsService } from './attachments.service';

/** Attachment metadata. Routes live under both the work log and `/attachments`. */
@ApiTags('attachments')
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('work-logs/:workLogId/attachments')
  @ApiDocs({
    summary: "List a work log's attachments",
    query: listAttachmentsQuerySchema,
    response: attachmentListSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  list(
    @Param('workLogId', new ZodPipe(idSchema)) workLogId: string,
    @Query(new ZodPipe(listAttachmentsQuerySchema)) query: ListAttachmentsQuery,
  ): Promise<Paginated<Attachment>> {
    return this.attachments.listForWorkLog(requireActor().organizationId, workLogId, query);
  }

  @Post('work-logs/:workLogId/attachments')
  @ApiDocs({
    summary: 'Record the metadata of a file attached to a work log',
    description: 'Metadata only: uploading the file itself arrives in Phase 4.',
    body: createAttachmentSchema,
    response: attachmentSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  create(
    @Param('workLogId', new ZodPipe(idSchema)) workLogId: string,
    @Body(new ZodPipe(createAttachmentSchema)) body: CreateAttachment,
  ): Promise<Attachment> {
    const actor = requireActor();
    return this.attachments.create(actor.organizationId, actor.userId, workLogId, body);
  }

  @Get('attachments/:id')
  @ApiDocs({
    summary: 'Get an attachment',
    response: attachmentSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Attachment> {
    return this.attachments.get(requireActor().organizationId, id);
  }

  @Post('attachments/:id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive an attachment',
    response: attachmentSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Attachment> {
    return this.attachments.archive(requireActor().organizationId, id);
  }
}
