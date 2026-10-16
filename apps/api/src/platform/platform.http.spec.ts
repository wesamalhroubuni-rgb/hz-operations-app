import type { AddressInfo } from 'node:net';
import {
  Body,
  Controller,
  Get,
  Global,
  type INestApplication,
  Module,
  Post,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, AUTH_ACCESS_COOKIE, CSRF_HEADER, REQUEST_ID_HEADER } from '@ops/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenService } from './auth/access-token';
import { CsrfTokens } from './auth/csrf';
import { Authenticated, Policy, REQUEST_AUTHORIZER, type AuthorizationRequest } from './authz';
import { buildApiDocument, setupApiDocs } from './docs/api-docs.setup';
import { ApiException, Public, requireActor } from './http';
import { PlatformModule } from './platform.module';
import { RequestContext } from './request-context/request-context';
import { createRequestContextMiddleware } from './request-context/request-context.middleware';

// Smoke test of the HTTP wiring PlatformModule registers (the guard above all), over a real
// socket, with a fake database and fake configuration. No PostgreSQL and no .env needed.
// Example values only: nothing here is a real secret.

const SECRET = 'platform-http-spec-signing-key-0123456789';
const ORIGIN = 'http://localhost:3000';
const ORG_ID = '0190f3a2-7c1e-7000-8000-0000000000aa';
const OTHER_ORG_ID = '0190f3a2-7c1e-7000-8000-0000000000ab';
const USER_ID = '0190f3a2-7c1e-7000-8000-000000000001';
const ARCHIVED_USER_ID = '0190f3a2-7c1e-7000-8000-000000000002';
const MOBILE_SESSION = '0190f3a2-7c1e-7000-8000-0000000000b1';
const WEB_SESSION = '0190f3a2-7c1e-7000-8000-0000000000b2';
const REVOKED_SESSION = '0190f3a2-7c1e-7000-8000-0000000000b3';
const EXPIRED_SESSION = '0190f3a2-7c1e-7000-8000-0000000000b4';
const ARCHIVED_USER_SESSION = '0190f3a2-7c1e-7000-8000-0000000000b5';
const UNKNOWN_SESSION = '0190f3a2-7c1e-7000-8000-0000000000bf';
const GENERIC_401 = 'Sign in to continue';

@Controller('probe')
class ProbeController {
  @Authenticated()
  @Get('whoami')
  whoami() {
    return { actor: requireActor(), correlationId: RequestContext.correlationId() };
  }

  @Authenticated()
  @Post('echo')
  echo(@Body() body: unknown) {
    return { actor: requireActor(), correlationId: RequestContext.correlationId(), body };
  }

  @Public()
  @Get('open')
  open() {
    return { actor: RequestContext.actor() };
  }

  @Get('undeclared')
  undeclared() {
    return { reached: true };
  }

  @Policy('thing.read')
  @Get('governed')
  governed() {
    return { reached: true };
  }

  @Public()
  @Get('limited')
  limited() {
    throw ApiException.rateLimited(undefined, 41.2);
  }
}

function session(id: string, userId: string, client: 'web' | 'mobile', overrides = {}) {
  const now = Date.now();
  return {
    id,
    userId,
    organizationId: ORG_ID,
    client,
    deviceName: null,
    userAgent: null,
    ipAddress: null,
    createdAt: new Date(now - 60_000),
    lastUsedAt: new Date(now - 60_000),
    expiresAt: new Date(now + 86_400_000),
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function fakePrisma() {
  const sessions = [
    session(MOBILE_SESSION, USER_ID, 'mobile'),
    session(WEB_SESSION, USER_ID, 'web'),
    session(REVOKED_SESSION, USER_ID, 'mobile', { revokedAt: new Date(), revokedReason: 'logout' }),
    session(EXPIRED_SESSION, USER_ID, 'mobile', { expiresAt: new Date(Date.now() - 1000) }),
    session(ARCHIVED_USER_SESSION, ARCHIVED_USER_ID, 'mobile'),
  ];
  const users = [
    { id: USER_ID, organizationId: ORG_ID, archivedAt: null },
    { id: ARCHIVED_USER_ID, organizationId: ORG_ID, archivedAt: new Date() },
  ].map((user) => ({ ...user, email: null, phone: null, username: null, displayName: 'Someone' }));

  const client = {
    $transaction: <Result>(callback: (tx: unknown) => Promise<Result>): Promise<Result> =>
      callback(client),
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(users.find((user) => user.id === where.id) ?? null),
      ),
    },
    authRefreshToken: { findUnique: jest.fn().mockResolvedValue(null) },
    authSession: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(sessions.find((item) => item.id === where.id) ?? null),
      ),
    },
    auditEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    outboxEvent: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: '0190f3a2-7c1e-7000-8000-0000000000e1',
          sequence: 9007199254740993n,
          organizationId: ORG_ID,
          eventType: 'thing.created',
          aggregateType: 'thing',
          aggregateId: 't-1',
          payload: { a: 1 },
          actorId: USER_ID,
          correlationId: 'c-1',
          occurredAt: new Date('2026-10-13T10:00:00.000Z'),
          processedAt: null,
        },
      ]),
      count: jest.fn().mockResolvedValue(1),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  return client;
}

interface StartOptions {
  earlyMiddleware?: boolean;
  docs?: boolean;
  /** Provide a RequestAuthorizer: `allow` lets every policy through, `deny` refuses with 403. */
  authorizer?: 'allow' | 'deny';
  config?: Record<string, unknown>;
}

async function startApp(options: StartOptions = {}) {
  const prisma = fakePrisma();
  const config: Record<string, unknown> = {
    NODE_ENV: 'development',
    AUTH_ACCESS_TOKEN_SECRET: SECRET,
    CORS_ORIGINS: [ORIGIN],
    WEB_APP_URL: ORIGIN,
    ...options.config,
  };
  const authorize = jest.fn((request: AuthorizationRequest) =>
    options.authorizer === 'deny'
      ? Promise.reject(ApiException.forbidden(`not allowed: ${request.policy}`))
      : Promise.resolve(),
  );
  const providers: Provider[] = [
    { provide: PrismaService, useValue: prisma },
    { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
  ];
  if (options.authorizer) {
    providers.push({ provide: REQUEST_AUTHORIZER, useValue: { authorize } });
  }

  @Global()
  @Module({
    providers,
    exports: providers.map((provider) => (provider as { provide: unknown }).provide as never),
  })
  class HostModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [HostModule, PlatformModule],
    controllers: [ProbeController],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  if (options.earlyMiddleware) {
    app.use(createRequestContextMiddleware());
  }
  if (options.docs) {
    setupApiDocs(app, { title: 'Test API', accessCookieName: AUTH_ACCESS_COOKIE });
  }
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;

  const tokens = app.get(AccessTokenService);
  const tokenFor = (sid: string, sub = USER_ID, org = ORG_ID): string =>
    tokens.sign({ sub, org, sid }).token;
  const bearer = (sid = MOBILE_SESSION, sub = USER_ID): Record<string, string> => ({
    Authorization: `Bearer ${tokenFor(sid, sub)}`,
  });
  const cookie = (sid = WEB_SESSION): Record<string, string> => ({
    Cookie: `${AUTH_ACCESS_COOKIE}=${tokenFor(sid)}`,
  });

  return {
    app,
    prisma,
    authorize,
    url: `http://127.0.0.1:${port}`,
    tokenFor,
    bearer,
    cookie,
    csrf: app.get(CsrfTokens),
  };
}

type Ctx = Awaited<ReturnType<typeof startApp>>;

describe('PlatformModule HTTP wiring', () => {
  describe('authentication', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await startApp({ earlyMiddleware: true });
    });
    afterAll(() => ctx.app.close());

    it('sets the actor from a bearer token and echoes the correlation id', async () => {
      const response = await fetch(`${ctx.url}/probe/whoami`, {
        headers: { ...ctx.bearer(), [REQUEST_ID_HEADER]: 'corr-1' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(REQUEST_ID_HEADER)).toBe('corr-1');
      expect(await response.json()).toEqual({
        actor: { userId: USER_ID, organizationId: ORG_ID, sessionId: MOBILE_SESSION },
        correlationId: 'corr-1',
      });
    });

    it('checks the session and the user in the database on every request', async () => {
      ctx.prisma.authSession.findUnique.mockClear();
      ctx.prisma.user.findUnique.mockClear();
      await fetch(`${ctx.url}/probe/whoami`, { headers: ctx.bearer() });
      await fetch(`${ctx.url}/probe/whoami`, { headers: ctx.bearer() });
      expect(ctx.prisma.authSession.findUnique).toHaveBeenCalledTimes(2);
      expect(ctx.prisma.user.findUnique).toHaveBeenCalledTimes(2);
    });

    it('keeps the actor and correlation id through a JSON body', async () => {
      const response = await fetch(`${ctx.url}/probe/echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...ctx.bearer(),
          [REQUEST_ID_HEADER]: 'corr-2',
        },
        body: JSON.stringify({ hello: 'x'.repeat(50_000) }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { actor: { userId: string }; correlationId: string };
      expect(body.actor.userId).toBe(USER_ID);
      expect(body.correlationId).toBe('corr-2');
    });

    it('accepts the access cookie of a web session on a read', async () => {
      const response = await fetch(`${ctx.url}/probe/whoami`, { headers: ctx.cookie() });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { actor: unknown }).actor).toEqual({
        userId: USER_ID,
        organizationId: ORG_ID,
        sessionId: WEB_SESSION,
      });
    });

    it.each<[string, (ctx: Ctx) => Record<string, string>]>([
      ['no credentials', () => ({})],
      ['the removed x-dev-user-id header', () => ({ 'x-dev-user-id': USER_ID })],
      ['a bearer value that is not a token', () => ({ Authorization: 'Bearer nope' })],
      ['another authorization scheme', () => ({ Authorization: `Basic ${USER_ID}` })],
      [
        'a token signed with another key',
        () => ({
          Authorization: `Bearer ${new AccessTokenService('some-other-signing-key-0123456789abcdef', 900, { now: () => new Date() }).sign({ sub: USER_ID, org: ORG_ID, sid: MOBILE_SESSION }).token}`,
        }),
      ],
      ['a session that does not exist', (c) => c.bearer(UNKNOWN_SESSION)],
      ['a revoked session', (c) => c.bearer(REVOKED_SESSION)],
      ['an expired session', (c) => c.bearer(EXPIRED_SESSION)],
      ['an archived user', (c) => c.bearer(ARCHIVED_USER_SESSION, ARCHIVED_USER_ID)],
      [
        "a token naming another user than the session's",
        (c) => c.bearer(MOBILE_SESSION, ARCHIVED_USER_ID),
      ],
      [
        "a token naming another organization than the session's",
        (c) => ({ Authorization: `Bearer ${c.tokenFor(MOBILE_SESSION, USER_ID, OTHER_ORG_ID)}` }),
      ],
      ['the token of a web session sent as a bearer token', (c) => c.bearer(WEB_SESSION)],
      ['the token of a mobile session sent as a cookie', (c) => c.cookie(MOBILE_SESSION)],
      [
        'an unusable Authorization header next to a valid cookie (no fallback)',
        (c) => ({ ...c.cookie(), Authorization: 'Bearer nope' }),
      ],
    ])('answers the same 401 for %s', async (_name, headers) => {
      const response = await fetch(`${ctx.url}/probe/whoami`, { headers: headers(ctx) });
      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(await response.json())).toMatchObject({
        statusCode: 401,
        code: 'unauthenticated',
        message: GENERIC_401,
        correlationId: response.headers.get(REQUEST_ID_HEADER),
      });
    });

    it('lets a public route through without an actor', async () => {
      const response = await fetch(`${ctx.url}/probe/open`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ actor: null });
    });

    it('answers unknown routes and malformed JSON in the standard body', async () => {
      const missing = await fetch(`${ctx.url}/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({
        code: 'not_found',
        correlationId: missing.headers.get(REQUEST_ID_HEADER),
      });

      const malformed = await fetch(`${ctx.url}/probe/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ctx.bearer() },
        body: '{bad',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        code: 'validation_failed',
        correlationId: malformed.headers.get(REQUEST_ID_HEADER),
      });

      const tooLarge = await fetch(`${ctx.url}/probe/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ctx.bearer() },
        body: JSON.stringify({ big: 'x'.repeat(200_000) }),
      });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({
        statusCode: 413,
        correlationId: tooLarge.headers.get(REQUEST_ID_HEADER),
      });
    });

    it('answers 429 with Retry-After in the standard body', async () => {
      const response = await fetch(`${ctx.url}/probe/limited`);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('42');
      expect(apiErrorSchema.parse(await response.json())).toMatchObject({
        statusCode: 429,
        code: 'rate_limited',
      });
    });
  });

  describe('CSRF for cookie sessions', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await startApp();
    });
    afterAll(() => ctx.app.close());

    const post = (headers: Record<string, string>) =>
      fetch(`${ctx.url}/probe/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: '{}',
      });

    it('accepts a write with an allowed Origin and the token of the session', async () => {
      const response = await post({
        ...ctx.cookie(),
        Origin: ORIGIN,
        [CSRF_HEADER]: ctx.csrf.tokenFor(WEB_SESSION),
      });
      expect(response.status).toBe(201);
    });

    it.each<[string, (ctx: Ctx) => Record<string, string>]>([
      ['no Origin and no token', () => ({})],
      ['no Origin', (c) => ({ [CSRF_HEADER]: c.csrf.tokenFor(WEB_SESSION) })],
      [
        'a foreign Origin',
        (c) => ({ Origin: 'https://evil.example', [CSRF_HEADER]: c.csrf.tokenFor(WEB_SESSION) }),
      ],
      ['an allowed Origin but no token', () => ({ Origin: ORIGIN })],
      [
        "an allowed Origin and another session's token",
        (c) => ({ Origin: ORIGIN, [CSRF_HEADER]: c.csrf.tokenFor(MOBILE_SESSION) }),
      ],
    ])('refuses a cookie-authenticated write with %s', async (_name, headers) => {
      const response = await post({ ...ctx.cookie(), ...headers(ctx) });
      expect(response.status).toBe(403);
      expect(apiErrorSchema.parse(await response.json())).toMatchObject({ code: 'forbidden' });
    });

    it('needs neither for a bearer-authenticated write', async () => {
      expect((await post(ctx.bearer())).status).toBe(201);
    });
  });

  describe('policies', () => {
    describe('without a RequestAuthorizer', () => {
      let ctx: Ctx;

      beforeAll(async () => {
        ctx = await startApp();
      });
      afterAll(() => ctx.app.close());

      it('refuses a route that declares no policy (fail closed), after authenticating', async () => {
        expect((await fetch(`${ctx.url}/probe/undeclared`)).status).toBe(401);
        const response = await fetch(`${ctx.url}/probe/undeclared`, { headers: ctx.bearer() });
        expect(response.status).toBe(403);
        expect(apiErrorSchema.parse(await response.json())).toMatchObject({ code: 'forbidden' });
      });

      it('refuses every route with a named policy', async () => {
        for (const path of ['/probe/governed', '/audit-events', '/outbox-events']) {
          const response = await fetch(`${ctx.url}${path}`, { headers: ctx.bearer() });
          expect(response.status).toBe(403);
        }
        expect(ctx.prisma.auditEvent.findMany).not.toHaveBeenCalled();
        expect(ctx.prisma.outboxEvent.findMany).not.toHaveBeenCalled();
      });

      it('still serves @Authenticated() routes', async () => {
        expect((await fetch(`${ctx.url}/probe/whoami`, { headers: ctx.bearer() })).status).toBe(
          200,
        );
      });
    });

    describe('with a RequestAuthorizer that allows', () => {
      let ctx: Ctx;

      beforeAll(async () => {
        ctx = await startApp({ authorizer: 'allow' });
      });
      afterAll(() => ctx.app.close());

      it('asks it about named policies only, with the actor', async () => {
        expect((await fetch(`${ctx.url}/probe/governed`, { headers: ctx.bearer() })).status).toBe(
          200,
        );
        expect(ctx.authorize).toHaveBeenCalledTimes(1);
        expect(ctx.authorize).toHaveBeenCalledWith({
          policy: 'thing.read',
          actor: { userId: USER_ID, organizationId: ORG_ID, sessionId: MOBILE_SESSION },
        });

        await fetch(`${ctx.url}/probe/whoami`, { headers: ctx.bearer() });
        await fetch(`${ctx.url}/probe/open`);
        await fetch(`${ctx.url}/probe/governed`);
        expect(ctx.authorize).toHaveBeenCalledTimes(1);
      });

      it('still refuses a route without a policy', async () => {
        const response = await fetch(`${ctx.url}/probe/undeclared`, { headers: ctx.bearer() });
        expect(response.status).toBe(403);
      });

      it('governs the audit and outbox reads and scopes them to the organization of the actor', async () => {
        const audit = await fetch(`${ctx.url}/audit-events?action=task.&pageSize=5`, {
          headers: ctx.bearer(),
        });
        expect(audit.status).toBe(200);
        expect(await audit.json()).toEqual({ items: [], page: 1, pageSize: 5, total: 0 });
        expect(ctx.authorize).toHaveBeenLastCalledWith(
          expect.objectContaining({ policy: 'audit.read' }),
        );
        expect(ctx.prisma.auditEvent.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              organizationId: ORG_ID,
              action: { startsWith: 'task.' },
            }),
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            skip: 0,
            take: 5,
          }),
        );

        const outbox = await fetch(`${ctx.url}/outbox-events?afterSequence=5&processed=false`, {
          headers: ctx.bearer(),
        });
        expect(outbox.status).toBe(200);
        const body = (await outbox.json()) as { items: Array<{ sequence: string }> };
        expect(body.items[0]?.sequence).toBe('9007199254740993');
        expect(ctx.authorize).toHaveBeenLastCalledWith(
          expect.objectContaining({ policy: 'outbox.read' }),
        );
        expect(ctx.prisma.outboxEvent.findMany).toHaveBeenLastCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              organizationId: ORG_ID,
              sequence: { gt: 5n },
              processedAt: null,
            }),
            orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
          }),
        );
      });

      it('rejects a bad query and has no write endpoints', async () => {
        const bad = await fetch(`${ctx.url}/audit-events?sort=name:asc`, { headers: ctx.bearer() });
        expect(bad.status).toBe(400);

        const write = await fetch(`${ctx.url}/audit-events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ctx.bearer() },
          body: '{}',
        });
        expect(write.status).toBe(404);
      });
    });

    describe('with a RequestAuthorizer that refuses', () => {
      let ctx: Ctx;

      beforeAll(async () => {
        ctx = await startApp({ authorizer: 'deny' });
      });
      afterAll(() => ctx.app.close());

      it('answers with what the authorizer threw and never reaches the handler', async () => {
        for (const path of ['/probe/governed', '/audit-events', '/outbox-events']) {
          const response = await fetch(`${ctx.url}${path}`, { headers: ctx.bearer() });
          expect(response.status).toBe(403);
        }
        expect(ctx.prisma.auditEvent.findMany).not.toHaveBeenCalled();
        expect(ctx.prisma.outboxEvent.findMany).not.toHaveBeenCalled();
      });
    });
  });

  describe('the sign-in routes', () => {
    let ctx: Ctx;

    beforeAll(async () => {
      ctx = await startApp();
    });
    afterAll(() => ctx.app.close());

    it('are public, validate their body, and are never cached, errors included', async () => {
      const response = await fetch(`${ctx.url}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: 'someone', client: 'mobile', extra: 1 }),
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(apiErrorSchema.parse(await response.json()).code).toBe('validation_failed');
    });

    it('refuse a web sign-in that does not come from an allowed origin', async () => {
      for (const origin of [undefined, 'https://evil.example']) {
        const response = await fetch(`${ctx.url}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
          body: JSON.stringify({ identifier: 'someone', password: 'whatever', client: 'web' }),
        });
        expect(response.status).toBe(403);
      }
    });

    it('answer 401 on the session routes without a session', async () => {
      for (const [method, path] of [
        ['GET', '/auth/me'],
        ['GET', '/auth/sessions'],
        ['POST', '/auth/logout-all'],
        ['POST', '/auth/change-password'],
        ['DELETE', `/auth/sessions/${MOBILE_SESSION}`],
      ] as const) {
        const response = await fetch(`${ctx.url}${path}`, { method });
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    });

    it('always answer 204 to a sign-out, also without any session', async () => {
      const response = await fetch(`${ctx.url}/auth/logout`, { method: 'POST' });
      expect(response.status).toBe(204);
    });
  });

  // main.ts calls setupApiDocs only when NODE_ENV is development. That `if` lives in the
  // bootstrap function, which cannot be run in-process (it reads process.env, binds API_PORT and
  // calls process.exit), so what is tested here is the other half: the module graph itself
  // registers no documentation route, and the routes exist only once setupApiDocs is called.
  describe('API documentation routes', () => {
    const DOCS_PATHS = ['/docs', '/docs-json', '/docs-yaml'];

    describe('when the host does not call setupApiDocs (every environment but development)', () => {
      let ctx: Ctx;

      beforeAll(async () => {
        ctx = await startApp({ config: { NODE_ENV: 'production' } });
      });
      afterAll(() => ctx.app.close());

      it.each(DOCS_PATHS)('answers 404 in the standard body for %s', async (path) => {
        const response = await fetch(`${ctx.url}${path}`);
        expect(response.status).toBe(404);
        expect(apiErrorSchema.parse(await response.json())).toMatchObject({ code: 'not_found' });
      });
    });

    describe('when the host calls setupApiDocs (development)', () => {
      let ctx: Ctx;

      beforeAll(async () => {
        ctx = await startApp({ earlyMiddleware: true, docs: true });
      });
      afterAll(() => ctx.app.close());

      it('serves the OpenAPI document without an acting user', async () => {
        const response = await fetch(`${ctx.url}/docs-json`);
        expect(response.status).toBe(200);
        const document = (await response.json()) as { paths: Record<string, unknown> };
        expect(Object.keys(document.paths)).toEqual(
          expect.arrayContaining([
            '/audit-events',
            '/outbox-events',
            '/probe/whoami',
            '/auth/login',
            '/auth/refresh',
            '/auth/me',
            '/auth/logout',
            '/auth/logout-all',
            '/auth/sessions',
            '/auth/sessions/{id}',
            '/auth/set-password',
            '/auth/change-password',
          ]),
        );
      });

      it('serves the Swagger UI page', async () => {
        const response = await fetch(`${ctx.url}/docs`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
      });

      it('documents the bearer scheme and cookie sessions, and no development header', () => {
        const document = buildApiDocument(ctx.app, {
          title: 'Test API',
          accessCookieName: AUTH_ACCESS_COOKIE,
        });
        expect(document.components?.securitySchemes).toEqual({
          bearer: expect.objectContaining({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }),
          cookie: expect.objectContaining({
            type: 'apiKey',
            in: 'cookie',
            name: AUTH_ACCESS_COOKIE,
          }),
        });
        expect(JSON.stringify(document)).not.toContain('x-dev-user-id');
      });

      it('documents query parameters and responses from the Zod schemas', () => {
        const document = buildApiDocument(ctx.app, { title: 'Test API' });
        const list = document.paths['/outbox-events']?.get;
        const parameters = (list?.parameters ?? []) as Array<{ name: string; schema: unknown }>;
        const byName = Object.fromEntries(parameters.map((item) => [item.name, item.schema]));
        expect(byName).toMatchObject({
          page: { type: 'integer', minimum: 1, default: 1 },
          pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          processed: { type: 'boolean' },
          sort: { type: 'string' },
          from: { type: 'string', format: 'date-time' },
        });
        expect(JSON.stringify(list?.responses['200'])).toContain('"sequence"');
      });
    });
  });
});
