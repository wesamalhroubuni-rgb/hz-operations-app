import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  AI_DAY_RANGE_MAX_DAYS,
  anomalyFlagListSchema,
  listAnomaliesQuerySchema,
  type AnomalyFlag,
  type ListAnomaliesQuery,
  type Paginated,
} from '@ops/shared';
import { Policy } from '../../../platform/authz';
import { ApiDocs, ZodPipe } from '../../../platform/http';
import { AnomaliesService } from './anomalies.service';

@ApiTags('ai')
@Controller('ai')
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  @Get('anomalies')
  @Policy('ai_anomaly.read')
  @ApiDocs({
    summary: 'Rule-based anomaly flags',
    description:
      'The flags of a range of org-local days (`from` / `to`, inclusive, default today, at ' +
      `most ${AI_DAY_RANGE_MAX_DAYS} days) whose every subject (site, team, person, task, log) ` +
      'the caller may see, newest day and most severe first. Each flag carries the numbers ' +
      'behind it (`params`). Suggestions only: nothing is done automatically.',
    query: listAnomaliesQuerySchema,
    response: anomalyFlagListSchema,
    errors: [HttpStatus.BAD_REQUEST, HttpStatus.FORBIDDEN],
  })
  list(
    @Query(new ZodPipe(listAnomaliesQuerySchema)) query: ListAnomaliesQuery,
  ): Promise<Paginated<AnomalyFlag>> {
    return this.anomalies.list(query);
  }
}
