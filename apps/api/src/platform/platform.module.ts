import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditEventsController } from './audit/audit-events.controller';
import { AuditQueryService } from './audit/audit-query.service';
import { AuditService } from './audit/audit.service';
import { DevActorGuard } from './dev-auth/dev-actor.guard';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { OutboxEventsController } from './outbox/outbox-events.controller';
import { OutboxQueryService } from './outbox/outbox-query.service';
import { OutboxService } from './outbox/outbox.service';
import { createRequestContextMiddleware } from './request-context/request-context.middleware';

/**
 * Reusable platform components (audit log, event outbox, request context, HTTP conventions).
 * Nothing under src/platform may import from src/operations: these modules are meant to be
 * lifted into shared Kaneri packages later.
 *
 * Importing this module is all a host does. It registers, for the whole application:
 * - the request context middleware (correlation id, `x-request-id`, one log line per request);
 * - the standard error body for every thrown error (`ApiExceptionFilter`);
 * - TEMPORARY, until Phase 3: `DevActorGuard`, which gives each non-public request its actor;
 * - the read-only `/audit-events` and `/outbox-events` endpoints.
 *
 * Host requirements: a global `PrismaService` (src/prisma) and a global `ConfigService`
 * answering `NODE_ENV` and `DEV_AUTH_ENABLED`.
 */
@Global()
@Module({
  controllers: [AuditEventsController, OutboxEventsController],
  providers: [
    AuditService,
    AuditQueryService,
    OutboxService,
    OutboxQueryService,
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_GUARD, useClass: DevActorGuard },
  ],
  exports: [AuditService, AuditQueryService, OutboxService, OutboxQueryService],
})
export class PlatformModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createRequestContextMiddleware()).forRoutes('{*splat}');
  }
}
