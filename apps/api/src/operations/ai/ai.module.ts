import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { AiModule } from '../../platform/ai';
import { AiUsageController } from './ai-usage.controller';
import { AiAnomaliesModule } from './anomalies/anomalies.module';
import { SmartCaptureModule } from './capture/capture.module';
import { AiKeysModule, AiKeyVaultModule } from './keys/ai-keys.module';
import { OrganizationAiKeys } from './keys/organization-ai-keys';
import { OrganizationAiLimits } from './organization-ai-limits';
import { AiSummariesModule } from './summaries/summaries.module';

/**
 * The folder of HZ's versioned prompt files (`<id>.v<N>.md`, ADR-0010 section 4). The files
 * sit next to this module in the source and are copied next to the compiled code: by the nest
 * build (`assets` in nest-cli.json) and by the seed build (`scripts/copy-prompts.mjs`).
 */
export const OPERATIONS_PROMPTS_DIRECTORY = join(__dirname, 'prompts');

/**
 * The intelligent layer of HZ (Phase 7, ADR-0010, ADR-0011): registers the platform AI module
 * (global: features inject `AI_RUNNER` and `PROMPT_LOADER`) with HZ's prompt folder and the
 * organization's own limits from `settings.ai` and its own provider keys (ADR-0012), and serves
 * `GET /ai/usage`.
 *
 * Feature modules (smart capture, summaries, anomalies) are added to `imports` below.
 */
@Module({
  imports: [
    AiModule.register({
      promptDirectories: [OPERATIONS_PROMPTS_DIRECTORY],
      organizationLimits: OrganizationAiLimits,
      // ADR-0012: an organization's own provider keys, stored encrypted.
      organizationKeys: OrganizationAiKeys,
      imports: [AiKeyVaultModule],
    }),
    AiKeysModule,
    SmartCaptureModule,
    AiAnomaliesModule,
    AiSummariesModule,
  ],
  controllers: [AiUsageController],
})
export class OperationsAiModule {}
