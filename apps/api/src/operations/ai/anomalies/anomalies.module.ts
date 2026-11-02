import { Module } from '@nestjs/common';
import { AnomaliesController } from './anomalies.controller';
import { AnomaliesService } from './anomalies.service';

/** Anomaly flags v1 (Phase 7, ADR-0011 section 4): the rules, their storage and `GET /ai/anomalies`. */
@Module({
  controllers: [AnomaliesController],
  providers: [AnomaliesService],
  exports: [AnomaliesService],
})
export class AiAnomaliesModule {}
