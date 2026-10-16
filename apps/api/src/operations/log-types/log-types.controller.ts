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
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createLogTypeSchema,
  idSchema,
  listLogTypesQuerySchema,
  logTypeListSchema,
  logTypeSchema,
  updateLogTypeSchema,
  type CreateLogType,
  type ListLogTypesQuery,
  type LogType,
  type Paginated,
  type UpdateLogType,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { LogTypesService } from './log-types.service';

@ApiTags('log-types')
@Controller('log-types')
export class LogTypesController {
  constructor(private readonly logTypes: LogTypesService) {}

  @Get()
  @Policy('log_type.read')
  @ApiDocs({
    summary: 'List log types (kinds of work log with their custom fields)',
    query: listLogTypesQuerySchema,
    response: logTypeListSchema,
  })
  list(
    @Query(new ZodPipe(listLogTypesQuerySchema)) query: ListLogTypesQuery,
  ): Promise<Paginated<LogType>> {
    return this.logTypes.list(query);
  }

  @Get(':id')
  @Policy('log_type.read')
  @ApiDocs({
    summary: 'Get a log type',
    response: logTypeSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<LogType> {
    return this.logTypes.get(id);
  }

  @Post()
  @Policy('log_type.manage')
  @ApiDocs({
    summary: 'Create a log type',
    body: createLogTypeSchema,
    response: logTypeSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.CONFLICT],
  })
  create(@Body(new ZodPipe(createLogTypeSchema)) body: CreateLogType): Promise<LogType> {
    return this.logTypes.create(body);
  }

  @Patch(':id')
  @Policy('log_type.manage')
  @ApiDocs({
    summary: 'Update a log type',
    description: 'Sending a different `fields` list increments `version`.',
    body: updateLogTypeSchema,
    response: logTypeSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateLogTypeSchema)) body: UpdateLogType,
  ): Promise<LogType> {
    return this.logTypes.update(id, body);
  }

  @Post(':id/archive')
  @Policy('log_type.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a log type',
    response: logTypeSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<LogType> {
    return this.logTypes.archive(id);
  }
}
