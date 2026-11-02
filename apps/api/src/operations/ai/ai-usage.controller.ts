import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AI_USAGE_MAX_DAYS,
  aiUsageQuerySchema,
  aiUsageReportSchema,
  type AiUsageQuery,
  type AiUsageReport,
} from '@ops/shared';
import { AiUsageReportService } from '../../platform/ai';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { AccessClock, AccessService } from '../access';

@ApiTags('ai')
@Controller('ai')
export class AiUsageController {
  constructor(
    private readonly reports: AiUsageReportService,
    private readonly access: AccessService,
    private readonly clock: AccessClock,
  ) {}

  @Get('usage')
  @Policy('ai_usage.read')
  @ApiDocs({
    summary: "The organization's AI usage",
    description:
      'Admins only. Calls, outcomes, tokens, audio seconds and estimated cost per UTC day, ' +
      'feature, provider and model; today against the daily limits in force; the providers ' +
      `configured now. \`from\` and \`to\` are inclusive UTC days (at most ${AI_USAGE_MAX_DAYS} ` +
      'days); the default is the last 30 days up to today.',
    query: aiUsageQuerySchema,
    response: aiUsageReportSchema,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.FORBIDDEN],
  })
  async usage(@Query(new ZodPipe(aiUsageQuerySchema)) query: AiUsageQuery): Promise<AiUsageReport> {
    const context = await this.access.context();
    return this.reports.report(context.organizationId, query, this.clock.now());
  }
}
