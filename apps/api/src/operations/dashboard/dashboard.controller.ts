import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  dashboardOverviewQuerySchema,
  dashboardOverviewSchema,
  directorySchema,
  type DashboardOverview,
  type DashboardOverviewQuery,
  type Directory,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard/overview')
  @Policy('dashboard.read')
  @ApiDocs({
    summary: "The overview of the caller's scope",
    description:
      "Counts for one day in the organization's time zone (`day`, default today there): logs " +
      'of the day, logs awaiting approval, open, overdue and blocked tasks, activity per site ' +
      'and per team, and the workers the caller supervises without a log that day. Every ' +
      'number counts only what the caller’s lists show, and carries `filter`, the list query ' +
      'that opens it.',
    query: dashboardOverviewQuerySchema,
    response: dashboardOverviewSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  overview(
    @Query(new ZodPipe(dashboardOverviewQuerySchema)) query: DashboardOverviewQuery,
  ): Promise<DashboardOverview> {
    return this.dashboard.overview(query);
  }

  @Get('directory')
  @Policy('directory.read')
  @ApiDocs({
    summary: 'The names behind the ids the caller can see',
    description:
      'Visible users (name and roles only), visible sites and teams, and the log types, ' +
      'archived ones included and flagged; at most 5,000 of each (`truncated`).',
    response: directorySchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  directory(): Promise<Directory> {
    return this.dashboard.directory();
  }
}
