import { Injectable, Logger } from '@nestjs/common';
import type { HealthResponse } from '@ops/shared';
import { PrismaService } from '../prisma/prisma.service';

/** Anything that looks like a connection URL is removed before an error is logged. */
const CONNECTION_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Reports whether the API can complete a real round-trip to the database. */
  async check(): Promise<HealthResponse> {
    const timestamp = new Date().toISOString();

    try {
      await this.prisma.ping();
      return { status: 'ok', database: 'up', timestamp };
    } catch (error) {
      this.logger.error(`Database health check failed: ${describeError(error)}`);
      return { status: 'error', database: 'down', timestamp };
    }
  }
}

/** Short, credential-free description of a failure, safe to write to the logs. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown error';
  }
  const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';
  const message = error.message
    .replace(CONNECTION_URL_PATTERN, '[redacted-url]')
    .replace(/\s+/g, ' ')
    .trim();
  return `${error.name}${code}${message ? `: ${message}` : ''}`;
}
