import type { AddressInfo } from 'node:net';
import { Body, Controller, Get, Global, type INestApplication, Module, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, DEV_USER_HEADER, REQUEST_ID_HEADER } from '@ops/shared';
import { PrismaService } from '../prisma/prisma.service';
import { buildApiDocument, setupApiDocs } from './docs/api-docs.setup';
import { Public, requireActor } from './http';
import { PlatformModule } from './platform.module';
import { RequestContext } from './request-context/request-context';
import { createRequestContextMiddleware } from './request-context/request-context.middleware';

// Smoke test of the HTTP wiring PlatformModule registers, over a real socket, with a fake
// database and fake configuration. No PostgreSQL and no .env needed.

const USER_ID = '0190f3a2-7c1e-7000-8000-000000000001';
const ARCHIVED_USER_ID = '0190f3a2-7c1e-7000-8000-000000000002';
const ORG_ID = '0190f3a2-7c1e-7000-8000-0000000000aa';

@Controller('probe')
class ProbeController {
  @Get('whoami')
  whoami() {
    return { actor: requireActor(), correlationId: RequestContext.correlationId() };
  }

  @Post('echo')
  echo(@Body() body: unknown) {
    return { actor: requireActor(), correlationId: RequestContext.correlationId(), body };
  }

  @Public()
  @Get('open')
  open() {
    return { actor: RequestContext.actor() };
  }
}

function fakePrisma() {
  return {
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        if (where.id === USER_ID) {
          return Promise.resolve({ id: USER_ID, organizationId: ORG_ID, archivedAt: null });
        }
        if (where.id === ARCHIVED_USER_ID) {
          return Promise.resolve({
            id: ARCHIVED_USER_ID,
            organizationId: ORG_ID,
            archivedAt: new Date(),
          });
        }
        return Promise.resolve(null);
      }),
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
}

async function startApp(config: Record<string, unknown>, earlyMiddleware = false, docs = false) {
  const prisma = fakePrisma();

  @Global()
  @Module({
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: { get: (key: string) => config[key] } },
    ],
    exports: [PrismaService, ConfigService],
  })
  class HostModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [HostModule, PlatformModule],
    controllers: [ProbeController],
  }).compile();
  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  if (earlyMiddleware) {
    app.use(createRequestContextMiddleware());
  }
  if (docs) {
    setupApiDocs(app, { title: 'Test API', devUserHeader: DEV_USER_HEADER });
  }
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, prisma, url: `http://127.0.0.1:${port}` };
}

describe('PlatformModule HTTP wiring', () => {
  describe('with dev auth enabled', () => {
    let ctx: Awaited<ReturnType<typeof startApp>>;

    beforeAll(async () => {
      ctx = await startApp({ NODE_ENV: 'development', DEV_AUTH_ENABLED: true }, true);
    });
    afterAll(() => ctx.app.close());

    it('sets the actor from the dev header and echoes the correlation id', async () => {
      const response = await fetch(`${ctx.url}/probe/whoami`, {
        headers: { [DEV_USER_HEADER]: USER_ID, [REQUEST_ID_HEADER]: 'corr-1' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get(REQUEST_ID_HEADER)).toBe('corr-1');
      expect(await response.json()).toEqual({
        actor: { userId: USER_ID, organizationId: ORG_ID },
        correlationId: 'corr-1',
      });
    });

    it('keeps the actor and correlation id through a JSON body', async () => {
      const response = await fetch(`${ctx.url}/probe/echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [DEV_USER_HEADER]: USER_ID,
          [REQUEST_ID_HEADER]: 'corr-2',
        },
        body: JSON.stringify({ hello: 'x'.repeat(50_000) }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { actor: unknown; correlationId: string };
      expect(body.actor).toEqual({ userId: USER_ID, organizationId: ORG_ID });
      expect(body.correlationId).toBe('corr-2');
    });

    it.each([
      ['no header', {}],
      ['a value that is not a UUID', { [DEV_USER_HEADER]: 'nope' }],
      ['an unknown user', { [DEV_USER_HEADER]: '0190f3a2-7c1e-7000-8000-0000000000ff' }],
      ['an archived user', { [DEV_USER_HEADER]: ARCHIVED_USER_ID }],
    ])('answers 401 in the standard body for %s', async (_name, headers) => {
      const response = await fetch(`${ctx.url}/probe/whoami`, { headers });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        statusCode: 401,
        code: 'unauthenticated',
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
        headers: { 'Content-Type': 'application/json', [DEV_USER_HEADER]: USER_ID },
        body: '{bad',
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        code: 'validation_failed',
        correlationId: malformed.headers.get(REQUEST_ID_HEADER),
      });

      const tooLarge = await fetch(`${ctx.url}/probe/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [DEV_USER_HEADER]: USER_ID },
        body: JSON.stringify({ big: 'x'.repeat(200_000) }),
      });
      expect(tooLarge.status).toBe(413);
      expect(await tooLarge.json()).toMatchObject({
        statusCode: 413,
        correlationId: tooLarge.headers.get(REQUEST_ID_HEADER),
      });
    });

    it('scopes audit and outbox reads to the organization of the actor', async () => {
      const audit = await fetch(`${ctx.url}/audit-events?action=task.&pageSize=5`, {
        headers: { [DEV_USER_HEADER]: USER_ID },
      });
      expect(audit.status).toBe(200);
      expect(await audit.json()).toEqual({ items: [], page: 1, pageSize: 5, total: 0 });
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
        headers: { [DEV_USER_HEADER]: USER_ID },
      });
      expect(outbox.status).toBe(200);
      const body = (await outbox.json()) as { items: Array<{ sequence: string }> };
      expect(body.items[0]?.sequence).toBe('9007199254740993');
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
      const bad = await fetch(`${ctx.url}/audit-events?sort=name:asc`, {
        headers: { [DEV_USER_HEADER]: USER_ID },
      });
      expect(bad.status).toBe(400);

      const write = await fetch(`${ctx.url}/audit-events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [DEV_USER_HEADER]: USER_ID },
        body: '{}',
      });
      expect(write.status).toBe(404);
    });

    it('documents query parameters and responses from the Zod schemas', () => {
      const document = buildApiDocument(ctx.app, {
        title: 'Test API',
        devUserHeader: DEV_USER_HEADER,
      });
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
      expect(document.components?.securitySchemes).toMatchObject({
        'dev-user': { type: 'apiKey', in: 'header', name: DEV_USER_HEADER },
      });
    });
  });

  describe.each([
    ['production with the flag forced on', { NODE_ENV: 'production', DEV_AUTH_ENABLED: true }],
    ['test with the flag forced on', { NODE_ENV: 'test', DEV_AUTH_ENABLED: true }],
    ['no NODE_ENV with the flag forced on', { DEV_AUTH_ENABLED: true }],
    ['development with the flag off', { NODE_ENV: 'development', DEV_AUTH_ENABLED: false }],
    ['development with the string "true"', { NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true' }],
    ['missing configuration', {}],
  ])('with dev auth not enabled (%s)', (_name, config) => {
    let ctx: Awaited<ReturnType<typeof startApp>>;

    beforeAll(async () => {
      ctx = await startApp(config);
    });
    afterAll(() => ctx.app.close());

    it('answers 401 without ever reading the header or the database', async () => {
      const response = await fetch(`${ctx.url}/probe/whoami`, {
        headers: { [DEV_USER_HEADER]: USER_ID },
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        code: 'unauthenticated',
        message: 'Authentication is not available yet',
      });
      expect(ctx.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('still serves public routes', async () => {
      const response = await fetch(`${ctx.url}/probe/open`);
      expect(response.status).toBe(200);
    });

    it('answers 401 in the standard body, with the correlation id, for a JSON write too', async () => {
      const response = await fetch(`${ctx.url}/probe/echo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [DEV_USER_HEADER]: USER_ID,
          [REQUEST_ID_HEADER]: 'corr-denied',
        },
        body: '{}',
      });
      expect(response.status).toBe(401);
      expect(apiErrorSchema.parse(await response.json())).toMatchObject({
        statusCode: 401,
        code: 'unauthenticated',
        correlationId: 'corr-denied',
      });
      expect(ctx.prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('keeps the audit and outbox reads closed', async () => {
      for (const path of ['/audit-events', '/outbox-events']) {
        const response = await fetch(`${ctx.url}${path}`, {
          headers: { [DEV_USER_HEADER]: USER_ID },
        });
        expect(response.status).toBe(401);
      }
      expect(ctx.prisma.auditEvent.findMany).not.toHaveBeenCalled();
      expect(ctx.prisma.outboxEvent.findMany).not.toHaveBeenCalled();
    });
  });

  // main.ts calls setupApiDocs only when NODE_ENV is development. That `if` lives in the
  // bootstrap function, which cannot be run in-process (it reads process.env, binds API_PORT and
  // calls process.exit), so what is tested here is the other half: the module graph itself
  // registers no documentation route, and the routes exist only once setupApiDocs is called.
  describe('API documentation routes', () => {
    const DOCS_PATHS = ['/docs', '/docs-json', '/docs-yaml'];

    describe('when the host does not call setupApiDocs (every environment but development)', () => {
      let ctx: Awaited<ReturnType<typeof startApp>>;

      beforeAll(async () => {
        ctx = await startApp({ NODE_ENV: 'production', DEV_AUTH_ENABLED: false });
      });
      afterAll(() => ctx.app.close());

      it.each(DOCS_PATHS)('answers 404 in the standard body for %s', async (path) => {
        const response = await fetch(`${ctx.url}${path}`);
        expect(response.status).toBe(404);
        expect(apiErrorSchema.parse(await response.json())).toMatchObject({ code: 'not_found' });
      });
    });

    describe('when the host calls setupApiDocs (development)', () => {
      let ctx: Awaited<ReturnType<typeof startApp>>;

      beforeAll(async () => {
        ctx = await startApp({ NODE_ENV: 'development', DEV_AUTH_ENABLED: true }, true, true);
      });
      afterAll(() => ctx.app.close());

      it('serves the OpenAPI document without an acting user', async () => {
        const response = await fetch(`${ctx.url}/docs-json`);
        expect(response.status).toBe(200);
        const document = (await response.json()) as { paths: Record<string, unknown> };
        expect(Object.keys(document.paths)).toEqual(
          expect.arrayContaining(['/audit-events', '/outbox-events', '/probe/whoami']),
        );
      });

      it('serves the Swagger UI page', async () => {
        const response = await fetch(`${ctx.url}/docs`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/html');
      });
    });
  });
});
