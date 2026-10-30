import { Module } from '@nestjs/common';
import { AccessModule } from './access/access.module';
import { AttachmentsModule } from './attachments/attachments.module';
import { OperationsCommonModule } from './common/operations-common.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ExportsModule } from './exports/exports.module';
import { LogTypesModule } from './log-types/log-types.module';
import { MembershipsModule } from './memberships/memberships.module';
import { OperationsNotificationsModule } from './notifications/operations-notifications.module';
import { OrganizationModule } from './organization/organization.module';
import { ReportsModule } from './reports/reports.module';
import { ScopeModule } from './scope/scope.module';
import { SitesModule } from './sites/sites.module';
import { SyncModule } from './sync/sync.module';
import { TasksModule } from './tasks/tasks.module';
import { TeamsModule } from './teams/teams.module';
import { UsersModule } from './users/users.module';
import { WorkLogsModule } from './work-logs/work-logs.module';

/** The Operations domain: organization structure and work data. Imports platform, never the reverse. */
@Module({
  imports: [
    OperationsCommonModule,
    AccessModule,
    OrganizationModule,
    UsersModule,
    MembershipsModule,
    SitesModule,
    TeamsModule,
    LogTypesModule,
    TasksModule,
    WorkLogsModule,
    AttachmentsModule,
    ScopeModule,
    SyncModule,
    DashboardModule,
    ExportsModule,
    ReportsModule,
    OperationsNotificationsModule,
  ],
})
export class OperationsModule {}
