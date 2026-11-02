import { Module } from '@nestjs/common';
import { CaptureRetentionService } from './capture-retention.service';
import { SmartCaptureController } from './smart-capture.controller';
import { SmartCaptureService } from './smart-capture.service';

/**
 * Smart capture (Phase 7, ADR-0010 section 6): the `/ai/capture` routes and the retention of
 * capture inputs and AI traces. The confirmation is part of `POST /work-logs`
 * (`capture-confirmation.ts`). The AI runner and prompt loader come from the global `AiModule`.
 */
@Module({
  controllers: [SmartCaptureController],
  providers: [SmartCaptureService, CaptureRetentionService],
  exports: [SmartCaptureService, CaptureRetentionService],
})
export class SmartCaptureModule {}
