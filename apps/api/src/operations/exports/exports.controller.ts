import { Controller, Get, HttpStatus, Query, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import {
  CSV_MIME_TYPE,
  exportTasksQuerySchema,
  exportWorkLogsQuerySchema,
  type ExportTasksQuery,
  type ExportWorkLogsQuery,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { ExportsService, type CsvFile } from './exports.service';

/** The part of the HTTP response this controller touches. */
interface HeaderSetter {
  setHeader(name: string, value: string): unknown;
}

const RULES =
  'The rows are exactly those the list with the same filters would show the caller (never ' +
  'more), in its sort order, as `text/csv; charset=utf-8` with a UTF-8 byte order mark, CRLF ' +
  "line ends, and formula-injection-safe cells. Times in the organization's time zone plus " +
  'UTC. More than 10,000 matching rows answers 422 `export_too_large`. Every export is ' +
  'audited (filters and row count).';

function send(response: HeaderSetter, file: CsvFile): string {
  response.setHeader('Content-Type', CSV_MIME_TYPE);
  // The name is built by the API from a fixed prefix and a day: nothing to escape.
  response.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
  response.setHeader('Cache-Control', 'no-store');
  return file.content;
}

@ApiTags('exports')
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Get('work-logs.csv')
  @Policy('export.work_logs')
  @ApiProduces('text/csv')
  @ApiDocs({
    summary: 'Export work logs as CSV',
    description: `The query takes the work-log list filters and sort. ${RULES}`,
    query: exportWorkLogsQuerySchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  async workLogs(
    @Query(new ZodPipe(exportWorkLogsQuerySchema)) query: ExportWorkLogsQuery,
    @Res({ passthrough: true }) response: HeaderSetter,
  ): Promise<string> {
    return send(response, await this.exports.workLogs(query));
  }

  @Get('tasks.csv')
  @Policy('export.tasks')
  @ApiProduces('text/csv')
  @ApiDocs({
    summary: 'Export tasks as CSV',
    description: `The query takes the task list filters and sort. ${RULES}`,
    query: exportTasksQuerySchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  async tasks(
    @Query(new ZodPipe(exportTasksQuerySchema)) query: ExportTasksQuery,
    @Res({ passthrough: true }) response: HeaderSetter,
  ): Promise<string> {
    return send(response, await this.exports.tasks(query));
  }
}
