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
import { ApiDocs, requireActor, toOpenApiSchema, ZodPipe } from '../../platform/http';
import { WorkLogsService } from './work-logs.service';

/** The part of the HTTP response this controller touches. */
interface StatusSetter {
  status(code: number): unknown;
}

const CHANGE_ERRORS = [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY];

@ApiTags('work-logs')
@Controller('work-logs')
export class WorkLogsController {
  constructor(private readonly workLogs: WorkLogsService) {}

  @Get()
  @ApiDocs({
    summary: 'List work logs',
    query: listWorkLogsQuerySchema,
    response: workLogListSchema,
  })
  list(
    @Query(new ZodPipe(listWorkLogsQuerySchema)) query: ListWorkLogsQuery,
  ): Promise<Paginated<WorkLog>> {
    return this.workLogs.list(requireActor().organizationId, query);
  }

  @Get(':id')
  @ApiDocs({ summary: 'Get a work log', response: workLogSchema, errors: [HttpStatus.NOT_FOUND] })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<WorkLog> {
    return this.workLogs.get(requireActor().organizationId, id);
  }

  @Post()
  @ApiDocs({
    summary: 'Create a work log (idempotent on clientId)',
    description:
      'Answers 201 for a new log. When a log with the same `clientId` already exists it is ' +
      'returned unchanged with 200, so a retried upload is safe.',
    body: createWorkLogSchema,
    response: workLogSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.NOT_FOUND, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'A log with this clientId already existed; it is returned unchanged.',
    schema: toOpenApiSchema(workLogSchema, 'output'),
  })
  async create(
    @Body(new ZodPipe(createWorkLogSchema)) body: CreateWorkLog,
    @Res({ passthrough: true }) response: StatusSetter,
  ): Promise<WorkLog> {
    const actor = requireActor();
    const result = await this.workLogs.create(actor.organizationId, actor.userId, body);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.workLog;
  }

  @Patch(':id')
  @ApiDocs({
    summary: 'Update a work log',
    body: updateWorkLogSchema,
    response: workLogSchema,
    errors: CHANGE_ERRORS,
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateWorkLogSchema)) body: UpdateWorkLog,
  ): Promise<WorkLog> {
    return this.workLogs.update(requireActor().organizationId, id, body);
  }

  @Patch(':id/status')
  @ApiDocs({
    summary: "Change a work log's status",
    body: changeWorkLogStatusSchema,
    response: workLogSchema,
    errors: [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  changeStatus(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(changeWorkLogStatusSchema)) body: ChangeWorkLogStatus,
  ): Promise<WorkLog> {
    return this.workLogs.changeStatus(requireActor().organizationId, id, body.status);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a work log',
    response: workLogSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<WorkLog> {
    return this.workLogs.archive(requireActor().organizationId, id);
  }
}
