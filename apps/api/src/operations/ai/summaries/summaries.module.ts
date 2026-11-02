import { Module } from '@nestjs/common';
import { AiAnomaliesModule } from '../anomalies/anomalies.module';
import { SummariesController } from './summaries.controller';
import { SummariesService } from './summaries.service';
import { SummaryNarrativeService } from './summary-narrative.service';
import { SummaryNotificationsService } from './summary-notifications.service';
import { SummaryScheduler } from './summary-scheduler';
import { SummaryStatsService } from './summary-stats.service';

/**
 * Daily summaries (Phase 7, ADR-0011): the scheduler, the per-recipient facts, the narrative
 * (model or template), the routes and the notification of a new summary.
 */
@Module({
  imports: [AiAnomaliesModule],
  controllers: [SummariesController],
  providers: [
    SummariesService,
    SummaryStatsService,
    SummaryNarrativeService,
    SummaryNotificationsService,
    SummaryScheduler,
  ],
  exports: [SummariesService, SummaryScheduler],
})
export class AiSummariesModule {}
