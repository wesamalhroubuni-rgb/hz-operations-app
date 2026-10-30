import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  workLogReportQuerySchema,
  workLogReportSchema,
  type WorkLogReport,
  type WorkLogReportQuery,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('work-logs')
  @Policy('report.read')
  @ApiDocs({
    summary: 'The printable work-log report of a range',
    description:
      'Totals by status, with photos and with a location; counts per day (in the ' +
      "organization's time zone, empty days included), per site, team, log type and worker; " +
      'and the newest 500 logs. Only the logs the caller may see, non-archived, with ' +
      '`occurredAt` in the range (inclusive start, exclusive end, at most 92 days).',
    query: workLogReportQuerySchema,
    response: workLogReportSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  workLogs(
    @Query(new ZodPipe(workLogReportQuerySchema)) query: WorkLogReportQuery,
  ): Promise<WorkLogReport> {
    return this.reports.workLogs(query);
  }
}
