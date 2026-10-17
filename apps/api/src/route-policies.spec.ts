import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Global,
  type INestApplication,
  type LoggerService,
  Module,
  RequestMethod,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { HealthModule } from './health/health.module';
import { listPolicies } from './operations/access/policies';
import { OperationsModule } from './operations/operations.module';
import { AccessTokenService } from './platform/auth/access-token';
import { AUTHENTICATED_POLICY, POLICY_KEY, Policy } from './platform/authz';
import { IS_PUBLIC_KEY } from './platform/http/public.decorator';
import { PlatformModule } from './platform/platform.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

// "No route without a policy": boots the real application modules (with a fake database and
// fake configuration: no PostgreSQL, no .env), enumerates every registered route, and checks the
// declaration of each one against the policy registry. Example values only.

/** Nest's route metadata keys (`PATH_METADATA`, `METHOD_METADATA` in @nestjs/common/constants). */
const PATH_METADATA = 'path';
const METHOD_METADATA = 'method';

/**
 * Policies in the registry that no route uses, on purpose. Empty: every policy governs at
 * least one route. Add a name here only with a reason next to it.
 */
const INTENTIONALLY_UNUSED_POLICIES: readonly string[] = [];

const SECRET = 'route-policies-spec-signing-key-0123456789';
const ORG_ID = '0190f3a2-7c1e-7000-8000-0000000000aa';
const USER_ID = '0190f3a2-7c1e-7000-8000-000000000001';
const SESSION_ID = '0190f3a2-7c1e-7000-8000-0000000000b1';

/** A throwaway controller: one route forgot its policy, one names a policy nobody defined. */
@Controller('throwaway')
class ThrowawayController {
  @Get('undeclared')
  undeclared() {
    return { reached: true };
  }

  @Policy('nothing.registered')
  @Get('unregistered')
  unregistered() {
    return { reached: true };
  }
}

interface RouteInfo {
  method: string;
  path: string;
  handler: string;
  isPublic: boolean;
  policy: unknown;
}

class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  log(message: unknown) {
    this.lines.push(String(message));
  }
  error(message: unknown) {
    this.lines.push(String(message));
  }
  warn(message: unknown) {
    this.lines.push(String(message));
  }
  debug() {}
  verbose() {}
}

function fakePrisma() {
  const session = {
    id: SESSION_ID,
    userId: USER_ID,
    organizationId: ORG_ID,
    client: 'mobile',
    deviceName: null,
    userAgent: null,
    ipAddress: null,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    revokedReason: null,
  };
  const user = {
    id: USER_ID,
    organizationId: ORG_ID,
    archivedAt: null,
    email: null,
    phone: null,
    username: 'probe.user',
    displayName: 'Probe',
  };
  return {
    $transaction: jest.fn(),
    $disconnect: jest.fn(),
    authSession: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === SESSION_ID ? session : null),
      ),
    },
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === USER_ID ? user : null),
      ),
    },
  };
}

/** The modules of `AppModule`, with the configuration module replaced (it reads process.env). */
const APPLICATION_MODULES = [PrismaModule, PlatformModule, HealthModule, OperationsModule];

async function boot(extraControllers: Array<new (...args: never[]) => unknown> = []) {
  const config: Record<string, unknown> = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
    DATABASE_CONNECT_TIMEOUT_MS: 1000,
    AUTH_ACCESS_TOKEN_SECRET: SECRET,
    CORS_ORIGINS: ['http://localhost:3000'],
    WEB_APP_URL: 'http://localhost:3000',
  };

  @Global()
  @Module({
    providers: [{ provide: ConfigService, useValue: { get: (key: string) => config[key] } }],
    exports: [ConfigService],
  })
  class FakeConfigModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [FakeConfigModule, DiscoveryModule, ...APPLICATION_MODULES],
    controllers: extraControllers,
  })
    .overrideProvider(PrismaService)
    .useValue(fakePrisma())
    .compile();
  const logger = new CapturingLogger();
  const app: INestApplication = moduleRef.createNestApplication({ logger });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, logger, url: `http://127.0.0.1:${port}` };
}

/** Every controller route, read from Nest's own metadata through the discovery service. */
function discoverRoutes(app: INestApplication): RouteInfo[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const routes: RouteInfo[] = [];
  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (!instance || !metatype) {
      continue;
    }
    const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
    const controllerPaths = [Reflect.getMetadata(PATH_METADATA, metatype) as string | string[]]
      .flat()
      .filter((path) => path !== undefined);
    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = prototype[name] as object;
      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      if (method === undefined) {
        continue;
      }
      const handlerPaths = [
        Reflect.getMetadata(PATH_METADATA, handler) as string | string[],
      ].flat();
      const targets = [handler as () => unknown, metatype];
      for (const base of controllerPaths.length > 0 ? controllerPaths : ['']) {
        for (const sub of handlerPaths) {
          const path = `/${[base, sub].filter((part) => part && part !== '/').join('/')}`
            .replace(/\/+/g, '/')
            .replace(/(.)\/$/, '$1');
          routes.push({
            method: RequestMethod[method],
            path,
            handler: `${metatype.name}.${name}`,
            isPublic: reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true,
            policy: reflector.getAllAndOverride<unknown>(POLICY_KEY, targets),
          });
        }
      }
    }
  }
  return routes;
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

/** Every route the HTTP server really serves, read from the Express router. */
function expressRoutes(app: INestApplication): string[] {
  const instance = app.getHttpAdapter().getInstance() as {
    router?: { stack: ExpressLayer[] };
    _router?: { stack: ExpressLayer[] };
  };
  const stack = (instance.router ?? instance._router)?.stack ?? [];
  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) =>
      Object.keys(layer.route!.methods)
        .filter((method) => method !== '_all')
        .map((method) => `${method.toUpperCase()} ${layer.route!.path}`),
    );
}

const key = (route: Pick<RouteInfo, 'method' | 'path'>) => `${route.method} ${route.path}`;

describe('every route declares how it is governed', () => {
  let app: INestApplication;
  let url: string;
  let routes: RouteInfo[];

  beforeAll(async () => {
    ({ app, url } = await boot());
    routes = discoverRoutes(app);
  });
  afterAll(() => app.close());

  it('tests the same modules as AppModule (only the configuration module is replaced)', () => {
    // AppModule cannot be imported here: its configuration module validates process.env when it
    // loads. Its source is read instead.
    const source = readFileSync(join(__dirname, 'app.module.ts'), 'utf8');
    const imports = /imports:\s*\[([^\]]*)\]/
      .exec(source)?.[1]
      ?.split(',')
      .map((s) => s.trim());
    expect(imports?.filter((name) => name && name !== 'AppConfigModule')).toEqual(
      APPLICATION_MODULES.map((module) => module.name),
    );
  });

  it('finds every route the HTTP server serves, and nothing else', () => {
    // A cross-check of the enumeration itself: if the metadata keys were wrong, or a route were
    // registered some other way, the two lists would differ.
    // (Route-scoped middleware, such as the no-store header of /auth, adds router entries for
    // the same method and path; the comparison is of distinct routes.)
    expect(routes.length).toBeGreaterThanOrEqual(45);
    expect(new Set(routes.map(key)).size).toBe(routes.length);
    expect(routes.map(key).sort()).toEqual([...new Set(expressRoutes(app))].sort());
  });

  it('gives each route @Public(), @Authenticated() or a @Policy that is in the registry', () => {
    const registered = new Set(listPolicies().map((policy) => policy.name as string));
    const undeclared = routes.filter(
      (route) =>
        !route.isPublic &&
        route.policy !== AUTHENTICATED_POLICY &&
        !(typeof route.policy === 'string' && registered.has(route.policy)),
    );
    expect(undeclared.map((route) => `${key(route)} (${route.handler})`)).toEqual([]);
  });

  it('declares exactly one of them: a public route names no policy', () => {
    const both = routes.filter((route) => route.isPublic && route.policy !== undefined);
    expect(both.map(key)).toEqual([]);
  });

  it('uses every policy of the registry on at least one route', () => {
    const used = new Set(routes.map((route) => route.policy));
    const unused = listPolicies()
      .map((policy) => policy.name as string)
      .filter((name) => !used.has(name) && !INTENTIONALLY_UNUSED_POLICIES.includes(name));
    expect(unused).toEqual([]);
    // The exception list stays honest: a name in it must really be unused and registered.
    for (const name of INTENTIONALLY_UNUSED_POLICIES) {
      expect(used.has(name)).toBe(false);
      expect(listPolicies().some((policy) => policy.name === name)).toBe(true);
    }
  });

  it('keeps the public surface to health and the sign-in routes', () => {
    expect(
      routes
        .filter((route) => route.isPublic)
        .map(key)
        .sort(),
    ).toEqual([
      'GET /health',
      'POST /auth/login',
      'POST /auth/logout',
      'POST /auth/refresh',
      'POST /auth/set-password',
    ]);
    expect(
      routes
        .filter((route) => route.policy === AUTHENTICATED_POLICY)
        .map(key)
        .sort(),
    ).toEqual([
      'DELETE /auth/sessions/:id',
      'DELETE /notifications/push-tokens/:token',
      'GET /auth/me',
      'GET /auth/sessions',
      'GET /notifications',
      'GET /scope/me',
      'POST /auth/change-password',
      'POST /auth/logout-all',
      'POST /notifications/:id/read',
      'POST /notifications/push-tokens',
      'POST /notifications/read-all',
    ]);
  });

  it('answers 401 on every non-public route without credentials, before validating anything', async () => {
    const id = '0190f3a2-7c1e-7000-8000-00000000ffff';
    const results: string[] = [];
    for (const route of routes.filter((item) => !item.isPublic)) {
      const path = route.path.replace(/:[A-Za-z]+/g, id);
      const response = await fetch(`${url}${path}`, {
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
        body: route.method === 'GET' ? undefined : '{"not":"valid"}',
      });
      if (response.status !== 401) {
        results.push(`${key(route)} -> ${response.status}`);
      }
    }
    expect(results).toEqual([]);
  });
});

describe('the guard fails closed (throwaway controller, real authorizer)', () => {
  let app: INestApplication;
  let url: string;
  let logger: CapturingLogger;
  let token: string;

  beforeAll(async () => {
    ({ app, url, logger } = await boot([ThrowawayController]));
    token = app.get(AccessTokenService).sign({ sub: USER_ID, org: ORG_ID, sid: SESSION_ID }).token;
  });
  afterAll(() => app.close());

  const call = (path: string, authorization?: string) =>
    fetch(`${url}${path}`, { headers: authorization ? { Authorization: authorization } : {} });

  it('authenticates first: without a session the route is 401', async () => {
    expect((await call('/throwaway/undeclared')).status).toBe(401);
  });

  it('refuses a signed-in user on a route that declares no policy (403) and logs a programming error', async () => {
    const response = await call('/throwaway/undeclared', `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'forbidden' });
    expect(logger.lines.some((line) => line.includes('ThrowawayController.undeclared'))).toBe(true);
  });

  it('refuses a route whose policy is not in the registry (403) and logs it', async () => {
    const response = await call('/throwaway/unregistered', `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(logger.lines.some((line) => line.includes('nothing.registered'))).toBe(true);
  });

  it('lists the throwaway routes as undeclared: the registry check above would catch them', () => {
    const registered = new Set(listPolicies().map((policy) => policy.name as string));
    const offenders = discoverRoutes(app).filter(
      (route) =>
        !route.isPublic &&
        route.policy !== AUTHENTICATED_POLICY &&
        !(typeof route.policy === 'string' && registered.has(route.policy)),
    );
    expect(offenders.map(key).sort()).toEqual([
      'GET /throwaway/undeclared',
      'GET /throwaway/unregistered',
    ]);
  });
});
