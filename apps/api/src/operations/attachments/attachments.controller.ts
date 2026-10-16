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
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { AttachmentsService } from './attachments.service';

const CHANGE_RULE =
  "Allowed to the work log's author while they may still change the log (inside the edit " +
  'window, not approved), and to a supervisor, manager or admin who can see the log and did ' +
  'not write it.';

/**
 * Attachment metadata. Routes live under both the work log and `/attachments`. Attachments
 * follow their work log: a log the caller may not see answers 404 here too.
 */
@ApiTags('attachments')
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('work-logs/:workLogId/attachments')
  @Policy('attachment.read')
  @ApiDocs({
    summary: "List a work log's attachments",
    query: listAttachmentsQuerySchema,
    response: attachmentListSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  list(
    @Param('workLogId', new ZodPipe(idSchema)) workLogId: string,
    @Query(new ZodPipe(listAttachmentsQuerySchema)) query: ListAttachmentsQuery,
  ): Promise<Paginated<Attachment>> {
    return this.attachments.listForWorkLog(workLogId, query);
  }

  @Post('work-logs/:workLogId/attachments')
  @Policy('attachment.create')
  @ApiDocs({
    summary: 'Record the metadata of a file attached to a work log',
    description:
      `Metadata only: uploading the file itself arrives in Phase 4. The uploader is the ` +
      `signed-in user. ${CHANGE_RULE}`,
    body: createAttachmentSchema,
    response: attachmentSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  create(
    @Param('workLogId', new ZodPipe(idSchema)) workLogId: string,
    @Body(new ZodPipe(createAttachmentSchema)) body: CreateAttachment,
  ): Promise<Attachment> {
    return this.attachments.create(workLogId, body);
  }

  @Get('attachments/:id')
  @Policy('attachment.read')
  @ApiDocs({
    summary: 'Get an attachment',
    response: attachmentSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Attachment> {
    return this.attachments.get(id);
  }

  @Post('attachments/:id/archive')
  @Policy('attachment.archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive an attachment',
    description: CHANGE_RULE,
    response: attachmentSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Attachment> {
    return this.attachments.archive(id);
  }
}
