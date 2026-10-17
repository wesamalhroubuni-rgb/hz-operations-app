import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  attachmentListSchema,
  attachmentSchema,
  attachmentUploadSchema,
  idSchema,
  listAttachmentsQuerySchema,
  startAttachmentUploadSchema,
  type Attachment,
  type AttachmentUpload,
  type ListAttachmentsQuery,
  type Paginated,
  type StartAttachmentUpload,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { AttachmentsService } from './attachments.service';

const CHANGE_RULE =
  "Allowed to the work log's author while they may still change the log (inside the edit " +
  'window, not approved), and to a supervisor, manager or admin who can see the log and did ' +
  'not write it.';

const URL_NOTE =
  'A ready, not archived attachment carries short-lived signed `url` and `thumbnailUrl` ' +
  '(until `urlsExpireAt`); fetch it again for fresh ones. A pending attachment is visible only ' +
  'to the person uploading it.';

/**
 * Photos on work logs. Routes live under both the work log and `/attachments`. Attachments follow
 * their work log: a log the caller may not see answers 404 here too. Upload flow: start (POST on
 * the work log), PUT the bytes to the returned URL, then `complete`.
 */
@ApiTags('attachments')
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('work-logs/:workLogId/attachments')
  @Policy('attachment.read')
  @ApiDocs({
    summary: "List a work log's attachments",
    description: URL_NOTE,
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
    summary: 'Start uploading a photo to a work log',
    description:
      'Creates a `pending` attachment (the uploader is the signed-in user; the API chooses ' +
      'where the file is stored) and answers with a short-lived URL: PUT exactly `sizeBytes` ' +
      'bytes there with the given headers, then call `POST /attachments/{id}/complete`. JPEG ' +
      `and PNG only; larger than the server limit is a 400; at most 20 attachments per log ` +
      `(409). ${CHANGE_RULE} Answers 503 when the file storage is unreachable.`,
    body: startAttachmentUploadSchema,
    response: attachmentUploadSchema,
    status: HttpStatus.CREATED,
    errors: [
      HttpStatus.FORBIDDEN,
      HttpStatus.NOT_FOUND,
      HttpStatus.CONFLICT,
      HttpStatus.TOO_MANY_REQUESTS,
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  startUpload(
    @Param('workLogId', new ZodPipe(idSchema)) workLogId: string,
    @Body(new ZodPipe(startAttachmentUploadSchema)) body: StartAttachmentUpload,
  ): Promise<AttachmentUpload> {
    return this.attachments.startUpload(workLogId, body);
  }

  @Post('attachments/:id/complete')
  @Policy('attachment.create')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Finish an upload',
    description:
      'Verifies the uploaded file by its content (a real JPEG or PNG of the declared type), ' +
      'stores a re-encoded copy without metadata (the copy is what `url` serves; the uploaded ' +
      'object is deleted), records its size and dimensions, makes a thumbnail and marks the ' +
      'attachment `ready`. Rate-limited per user (429 with `Retry-After`). ' +
      'Completing a ready attachment returns it unchanged. 409 when nothing has been uploaded ' +
      'yet; 422 when the file is not a valid image of the declared type (the file is deleted, ' +
      `the attachment stays pending and may be uploaded again). ${CHANGE_RULE}`,
    response: attachmentSchema,
    errors: [
      HttpStatus.FORBIDDEN,
      HttpStatus.NOT_FOUND,
      HttpStatus.CONFLICT,
      HttpStatus.UNPROCESSABLE_ENTITY,
      HttpStatus.TOO_MANY_REQUESTS,
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  complete(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Attachment> {
    return this.attachments.complete(id);
  }

  @Post('attachments/:id/upload-url')
  @Policy('attachment.create')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Get a fresh upload URL for a pending attachment',
    description:
      'For a pending attachment whose upload URL expired or whose upload failed. 409 when the ' +
      `attachment is already ready or archived. ${CHANGE_RULE}`,
    response: attachmentUploadSchema,
    errors: [
      HttpStatus.FORBIDDEN,
      HttpStatus.NOT_FOUND,
      HttpStatus.CONFLICT,
      HttpStatus.TOO_MANY_REQUESTS,
      HttpStatus.SERVICE_UNAVAILABLE,
    ],
  })
  renewUpload(@Param('id', new ZodPipe(idSchema)) id: string): Promise<AttachmentUpload> {
    return this.attachments.renewUpload(id);
  }

  @Get('attachments/:id')
  @Policy('attachment.read')
  @ApiDocs({
    summary: 'Get an attachment',
    description: URL_NOTE,
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
    description: `${CHANGE_RULE} The stored file of a ready attachment is kept.`,
    response: attachmentSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Attachment> {
    return this.attachments.archive(id);
  }
}
