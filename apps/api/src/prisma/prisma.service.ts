import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The single Prisma client for the API.
 *
 * It does not connect when the application starts: the connection pool opens
 * lazily on the first query. That lets the API boot and report its own health
 * even when PostgreSQL is unreachable.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService<Env, true>) {
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
        connectionTimeoutMillis: config.get('DATABASE_CONNECT_TIMEOUT_MS', { infer: true }),
      }),
    });
  }

  /** Runs a trivial query to prove a real round-trip to the database works. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
