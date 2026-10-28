import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  changeWorkLogStatusSchema,
  createWorkLogSchema,
  idSchema,
  listWorkLogsQuerySchema,
  updateWorkLogSchema,
  workLogListSchema,
  workLogSchema,
  type ChangeWorkLogStatus,
  type CreateWorkLog,
  type ListWorkLogsQuery,
  type Paginated,
  type UpdateWorkLog,
  type WorkLog,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, toOpenApiSchema, ZodPipe } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { WorkLogsService } from './work-logs.service';

/** The part of the HTTP response this controller touches. */
interface StatusSetter {
  status(code: number): unknown;
}

const CHANGE_ERRORS = [
  HttpStatus.FORBIDDEN,
  HttpStatus.NOT_FOUND,
  HttpStatus.CONFLICT,
  HttpStatus.UNPROCESSABLE_ENTITY,
];

@ApiTags('work-logs')
@Controller('work-logs')
export class WorkLogsController {
  constructor(private readonly workLogs: WorkLogsService) {}

  @Get()
  @Policy('work_log.read')
  @ApiDocs({
    summary: 'List the work logs the caller may see',
    description:
      'A worker sees their own logs; a supervisor also the logs of their sites, teams and ' +
      'people; a manager or admin every log.',
    query: listWorkLogsQuerySchema,
    response: workLogListSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  list(
    @Query(new ZodPipe(listWorkLogsQuerySchema)) query: ListWorkLogsQuery,
  ): Promise<Paginated<WorkLog>> {
    return this.workLogs.list(query);
  }

  @Get(':id')
  @Policy('work_log.read')
  @ApiDocs({
    summary: 'Get a work log',
    description: 'A log the caller may not see answers 404.',
    response: workLogSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<WorkLog> {
    return this.workLogs.get(id);
  }

  @Post()
  @Policy('work_log.create')
  @Idempotent()
  @ApiDocs({
    summary: 'Create a work log of your own (idempotent on clientId)',
    description:
      'The author is the signed-in user. The status is `draft` or `submitted`. Answers 201 for ' +
      'a new log. When the caller already has a log with the same `clientId` it is returned ' +
      'unchanged with 200, so a retried upload is safe; a `clientId` used by somebody else ' +
      'answers 409.',
    body: createWorkLogSchema,
    response: workLogSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The caller already had a log with this clientId; it is returned unchanged.',
    schema: toOpenApiSchema(workLogSchema, 'output'),
  })
  async create(
    @Body(new ZodPipe(createWorkLogSchema)) body: CreateWorkLog,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<WorkLog> {
    const result = await this.workLogs.create(body);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.workLog;
  }

  @Patch(':id')
  @Policy('work_log.update')
  @Idempotent()
  @ApiDocs({
    summary: 'Edit your own work log',
    description:
      "Only the author, inside the organization's edit window (counted from `createdAt`) and " +
      'while the log is not approved: somebody else 403, approved 409 `already_reviewed`, ' +
      'window passed 403 `edit_window_closed`, archived 409 `record_archived`. With ' +
      '`expectedVersion`, a log changed meanwhile answers 409 `version_conflict` unless the ' +
      'edit is already in place (200). `occurredAt` must stay within the backdating limit ' +
      '(422 `occurred_at_out_of_range`).',
    body: updateWorkLogSchema,
    response: workLogSchema,
    errors: CHANGE_ERRORS,
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateWorkLogSchema)) body: UpdateWorkLog,
  ): Promise<WorkLog> {
    return this.workLogs.update(id, body);
  }

  @Patch(':id/status')
  @Policy('work_log.change_status')
  @Idempotent()
  @ApiDocs({
    summary: "Change a work log's status",
    description:
      'The author moves their log between `draft` and `submitted` and resubmits a rejected ' +
      'one, inside the edit window. A supervisor (for logs they can see), manager or admin ' +
      'approves or rejects a submitted log and reopens an approved or rejected one to ' +
      '`submitted`; never their own log (403). A move that does not exist answers 409. `note` ' +
      'is required when rejecting (the reason the author sees), optional when approving, and ' +
      'refused otherwise; approving or rejecting records the reviewer, the time and the note ' +
      'in `review`, which is cleared when the log goes back to submitted or draft.',
    body: changeWorkLogStatusSchema,
    response: workLogSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  changeStatus(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(changeWorkLogStatusSchema)) body: ChangeWorkLogStatus,
  ): Promise<WorkLog> {
    return this.workLogs.changeStatus(id, body);
  }

  @Post(':id/archive')
  @Policy('work_log.archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a work log',
    description:
      'The author under the same rule as an edit, or a supervisor, manager or admin who can ' +
      'see the log and did not write it.',
    response: workLogSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<WorkLog> {
    return this.workLogs.archive(id);
  }
}
