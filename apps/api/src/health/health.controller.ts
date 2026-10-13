import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { healthResponseSchema, type HealthResponse } from '@ops/shared';
import { ApiDocs, Public } from '../platform/http';
import { HealthService } from './health.service';

interface StatusSetter {
  status(code: number): unknown;
}

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** 200 when the database answers, 503 (with the same body shape) when it does not. */
  @Get()
  @ApiDocs({
    summary: 'Report whether the API can reach its database',
    description: 'Answers 503 with the same body shape when the database is down.',
    response: healthResponseSchema,
    errors: [HttpStatus.SERVICE_UNAVAILABLE],
  })
  async getHealth(@Res({ passthrough: true }) response: StatusSetter): Promise<HealthResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') {
      response.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
