import { Global, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEventsController } from './audit/audit-events.controller';
import { AuditQueryService } from './audit/audit-query.service';
import { AuditService } from './audit/audit.service';
import { AccessTokenService } from './auth/access-token';
import { AuthAdminService } from './auth/auth-admin.service';
import { AUTH_DATABASE, type AuthDatabase } from './auth/auth-db';
import { AUTH_PROFILE_PROVIDER, type AuthProfileProvider } from './auth/auth-profile';
import { AUTH_SETTINGS, authSettingsFromConfig, type AuthSettings } from './auth/auth-settings';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { AUTH_CLOCK, AUTH_RANDOM, systemClock, systemRandom } from './auth/clock';
import type { Clock, RandomSource } from './auth/clock';
import { CsrfTokens } from './auth/csrf';
import { OneTimeCodes } from './auth/one-time-codes';
import { PasswordHasher } from './auth/password-hasher';
import { InMemoryRateLimiter, RATE_LIMITER, type RateLimiter } from './auth/rate-limiter';
import { SessionService } from './auth/sessions';
import { ApiExceptionFilter } from './http/api-exception.filter';
import {
  LoggingNotificationSender,
  NOTIFICATION_SENDER,
} from './notifications/notification-sender';
import { OutboxEventsController } from './outbox/outbox-events.controller';
import { OutboxQueryService } from './outbox/outbox-query.service';
import { OutboxService } from './outbox/outbox.service';
import { NotificationsModule } from './notifications/notifications.module';
import { createRequestContextMiddleware } from './request-context/request-context.middleware';
import { StorageModule } from './storage/storage.module';

interface NoStoreResponse {
  setHeader(name: string, value: string): unknown;
}

/** Sign-in answers carry tokens and personal data: no cache may keep them. */
function noStore(_request: unknown, response: NoStoreResponse, next: () => void): void {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  next();
}

/**
 * Reusable platform components (sign-in and sessions, the request guard, audit log, event
 * outbox, request context, HTTP conventions). Nothing under src/platform may import from
 * src/operations: these modules are meant to be lifted into shared Kaneri packages later.
 *
 * Importing this module is all a host does. It registers, for the whole application:
 * - the request context middleware (correlation id, `x-request-id`, one log line per request);
 * - the standard error body for every thrown error (`ApiExceptionFilter`);
 * - `AuthGuard`, the one global guard: it authenticates every non-public request, checks the
 *   session in the database, enforces CSRF for cookie sessions and applies the route's policy;
 * - the `/auth/*` endpoints, and the read-only `/audit-events` and `/outbox-events` endpoints.
 *
 * Host requirements:
 * - a global `PrismaService` (src/prisma) whose client has the tables listed in
 *   ./auth/auth-db.ts, plus `auditEvent` and `outboxEvent`;
 * - a global `ConfigService` answering the keys listed in ./auth/auth-settings.ts;
 * - optionally, from a GLOBAL module of the host: `REQUEST_AUTHORIZER` (./authz; without it
 *   every route with a named policy is refused) and `AUTH_PROFILE_PROVIDER` (./auth; without it
 *   users are described with no roles).
 *
 * Replaceable parts, by providing another value under the token: `NOTIFICATION_SENDER` (how a
 * one-time code reaches a person), `RATE_LIMITER` (a shared store when there are several API
 * instances), `AUTH_CLOCK` and `AUTH_RANDOM` (tests).
 */
@Global()
@Module({
  imports: [StorageModule, NotificationsModule],
  controllers: [AuthController, AuditEventsController, OutboxEventsController],
  providers: [
    AuditService,
    AuditQueryService,
    OutboxService,
    OutboxQueryService,
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },

    // The structural check that the host's database client has what the auth module needs
    // happens here, at compile time.
    {
      provide: AUTH_DATABASE,
      useFactory: (prisma: PrismaService): AuthDatabase => prisma,
      inject: [PrismaService],
    },
    {
      provide: AUTH_SETTINGS,
      useFactory: (config: ConfigService): AuthSettings =>
        authSettingsFromConfig((key) => config.get<unknown>(key)),
      inject: [ConfigService],
    },
    { provide: AUTH_CLOCK, useValue: systemClock },
    { provide: AUTH_RANDOM, useValue: systemRandom },
    {
      provide: RATE_LIMITER,
      useFactory: (clock: Clock): RateLimiter => new InMemoryRateLimiter(clock),
      inject: [AUTH_CLOCK],
    },
    {
      provide: NOTIFICATION_SENDER,
      useFactory: (settings: AuthSettings) => new LoggingNotificationSender(settings.nodeEnv),
      inject: [AUTH_SETTINGS],
    },
    { provide: PasswordHasher, useFactory: () => new PasswordHasher() },
    {
      provide: AccessTokenService,
      useFactory: (settings: AuthSettings, clock: Clock) =>
        new AccessTokenService(settings.secret, settings.accessTokenTtlSeconds, clock),
      inject: [AUTH_SETTINGS, AUTH_CLOCK],
    },
    {
      provide: CsrfTokens,
      useFactory: (settings: AuthSettings) => new CsrfTokens(settings.secret),
      inject: [AUTH_SETTINGS],
    },
    {
      provide: OneTimeCodes,
      useFactory: (clock: Clock, random: RandomSource, settings: AuthSettings) =>
        new OneTimeCodes(clock, random, settings),
      inject: [AUTH_CLOCK, AUTH_RANDOM, AUTH_SETTINGS],
    },
    {
      provide: SessionService,
      useFactory: (
        clock: Clock,
        random: RandomSource,
        settings: AuthSettings,
        accessTokens: AccessTokenService,
      ) => new SessionService(clock, random, settings, accessTokens),
      inject: [AUTH_CLOCK, AUTH_RANDOM, AUTH_SETTINGS, AccessTokenService],
    },
    {
      provide: AuthService,
      useFactory: (
        db: AuthDatabase,
        settings: AuthSettings,
        clock: Clock,
        hasher: PasswordHasher,
        accessTokens: AccessTokenService,
        sessions: SessionService,
        codes: OneTimeCodes,
        audit: AuditService,
        limiter: RateLimiter,
        profiles?: AuthProfileProvider,
      ) =>
        new AuthService({
          db,
          settings,
          clock,
          hasher,
          accessTokens,
          sessions,
          codes,
          audit,
          limiter,
          profiles: profiles ?? null,
        }),
      inject: [
        AUTH_DATABASE,
        AUTH_SETTINGS,
        AUTH_CLOCK,
        PasswordHasher,
        AccessTokenService,
        SessionService,
        OneTimeCodes,
        AuditService,
        RATE_LIMITER,
        { token: AUTH_PROFILE_PROVIDER, optional: true },
      ],
    },
    AuthAdminService,
  ],
  exports: [
    AuditService,
    AuditQueryService,
    OutboxService,
    OutboxQueryService,
    AuthAdminService,
    AuthService,
    SessionService,
    AccessTokenService,
    CsrfTokens,
    OneTimeCodes,
    PasswordHasher,
    AUTH_SETTINGS,
    AUTH_CLOCK,
    AUTH_RANDOM,
    AUTH_DATABASE,
    RATE_LIMITER,
    NOTIFICATION_SENDER,
  ],
})
export class PlatformModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createRequestContextMiddleware()).forRoutes('{*splat}');
    consumer.apply(noStore).forRoutes(AuthController);
  }
}
