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
  bulkWorkLogStatusResultSchema,
  bulkWorkLogStatusSchema,
  changeWorkLogStatusSchema,
  createWorkLogSchema,
  idSchema,
  listWorkLogsQuerySchema,
  recordHistorySchema,
  updateWorkLogSchema,
  workLogListSchema,
  workLogMapQuerySchema,
  workLogMapSchema,
  workLogSchema,
  type BulkWorkLogStatus,
  type BulkWorkLogStatusResult,
  type ChangeWorkLogStatus,
  type CreateWorkLog,
  type ListWorkLogsQuery,
  type Paginated,
  type RecordHistory,
  type UpdateWorkLog,
  type WorkLog,
  type WorkLogMap,
  type WorkLogMapQuery,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, toOpenApiSchema, ZodPipe } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RecordHistoryService } from '../history/record-history.service';
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
  constructor(
    private readonly workLogs: WorkLogsService,
    private readonly histories: RecordHistoryService,
  ) {}

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

  // Declared before `:id` so that `map` is not read as an id.
  @Get('map')
  @Policy('work_log.read')
  @ApiDocs({
    summary: 'The visible work logs with a location, for the map',
    description:
      'Newest `occurredAt` first, at most `limit` (default 500, at most 1,000). The same ' +
      'filters as the list; without `occurredFrom` the last 7 days up to `occurredTo` or now. ' +
      '`total` counts every matching located log; `truncated` says whether the cap cut it.',
    query: workLogMapQuerySchema,
    response: workLogMapSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  map(@Query(new ZodPipe(workLogMapQuerySchema)) query: WorkLogMapQuery): Promise<WorkLogMap> {
    return this.workLogs.map(query);
  }

  @Post('bulk-status')
  @Policy('work_log.review')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Approve or reject many work logs',
    description:
      'At most 100 logs. Each is processed exactly like `PATCH /work-logs/:id/status`, in its ' +
      'own transaction with its own audit event and notification, so one refusal never undoes ' +
      'another. The caller’s own logs are refused per item (403). Always 200 once the body is ' +
      'valid; `results` keep the item order and carry the log or the error of each item.',
    body: bulkWorkLogStatusSchema,
    response: bulkWorkLogStatusResultSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  bulkChangeStatus(
    @Body(new ZodPipe(bulkWorkLogStatusSchema)) body: BulkWorkLogStatus,
  ): Promise<BulkWorkLogStatusResult> {
    return this.workLogs.bulkChangeStatus(body);
  }

  @Get(':id/history')
  @Policy('work_log.read')
  @ApiDocs({
    summary: "A work log's history",
    description:
      'The audit events of the log and of its photos, oldest first, at most 200: the action, ' +
      'the time, who (a name only for users the caller may see), the changed fields among a ' +
      'fixed list, and whether it came from the offline queue. A log the caller may not see ' +
      'answers 404.',
    response: recordHistorySchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  history(@Param('id', new ZodPipe(idSchema)) id: string): Promise<RecordHistory> {
    return this.histories.workLog(id);
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
