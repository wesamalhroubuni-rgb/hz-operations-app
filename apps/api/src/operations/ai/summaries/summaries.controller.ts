import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AI_DAY_RANGE_MAX_DAYS,
  AI_SUMMARY_GENERATE_MAX_DAYS_BACK,
  dailySummaryListSchema,
  dailySummarySchema,
  generateDailySummariesResultSchema,
  generateDailySummariesSchema,
  idSchema,
  listDailySummariesQuerySchema,
  type DailySummary,
  type GenerateDailySummaries,
  type GenerateDailySummariesResult,
  type ListDailySummariesQuery,
  type Paginated,
} from '@ops/shared';
import { Policy } from '../../../platform/authz';
import { ApiDocs, ZodPipe } from '../../../platform/http';
import { SummariesService } from './summaries.service';

@ApiTags('ai')
@Controller('ai/summaries')
export class SummariesController {
  constructor(private readonly summaries: SummariesService) {}

  @Get()
  @Policy('ai_summary.read')
  @ApiDocs({
    summary: 'My daily summaries',
    description:
      "The caller's own daily summaries (the caller is the recipient), newest day first. " +
      '`from` / `to` are inclusive org-local days (both given: at most ' +
      `${AI_DAY_RANGE_MAX_DAYS} days). A summary was computed for its recipient's scope only; ` +
      'nobody else can read it.',
    query: listDailySummariesQuerySchema,
    response: dailySummaryListSchema,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.FORBIDDEN],
  })
  list(
    @Query(new ZodPipe(listDailySummariesQuerySchema)) query: ListDailySummariesQuery,
  ): Promise<Paginated<DailySummary>> {
    return this.summaries.list(query);
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @Policy('ai_summary.generate')
  @ApiDocs({
    summary: 'Generate the daily summaries of one day now',
    description:
      "Admins. Generates the missing summaries of `day` (default today in the organization's " +
      `time zone, at most ${AI_SUMMARY_GENERATE_MAX_DAYS_BACK} days back, never in the future) ` +
      'for every recipient by the settings, or for `recipientId`. Idempotent: an existing ' +
      'summary is kept and counted as skipped. 403 `ai_disabled` while daily summaries are off.',
    body: generateDailySummariesSchema,
    response: generateDailySummariesResultSchema,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  generate(
    @Body(new ZodPipe(generateDailySummariesSchema)) body: GenerateDailySummaries,
  ): Promise<GenerateDailySummariesResult> {
    return this.summaries.generateNow(body);
  }

  @Get(':id')
  @Policy('ai_summary.read')
  @ApiDocs({
    summary: 'One of my daily summaries',
    description: "One of the caller's own summaries; anyone else's answers 404.",
    response: dailySummarySchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<DailySummary> {
    return this.summaries.get(id);
  }
}
