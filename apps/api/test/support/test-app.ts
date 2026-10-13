import type { AddressInfo } from 'node:net';
import { Global, type INestApplication, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { DEV_USER_HEADER, REQUEST_ID_HEADER } from '@ops/shared';
import { HealthModule } from '../../src/health/health.module';
import { OperationsModule } from '../../src/operations/operations.module';
import { PlatformModule } from '../../src/platform/platform.module';
import { createRequestContextMiddleware } from '../../src/platform/request-context/request-context.middleware';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { redirectDatabaseUrl, truncateAll, type TestDatabaseTarget } from './test-database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are JSON of many shapes; each test asserts the fields it reads
export type Json = any;

export interface ApiResponse {
  status: number;
  body: Json;
  /** The raw response text, for bodies that are not JSON. */
  text: string;
  headers: Headers;
  /** The `x-request-id` response header. */
  requestId: string | null;
}

export interface RequestOptions {
  body?: unknown;
  /** Sent as it is, instead of `body` (malformed JSON, ...). */
  rawBody?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

/** A small HTTP client bound to the test app and, optionally, to an acting user. */
export interface ApiCaller {
  request(method: string, path: string, options?: RequestOptions): Promise<ApiResponse>;
  get(path: string, query?: RequestOptions['query']): Promise<ApiResponse>;
  post(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse>;
  patch(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse>;
  put(path: string, body?: unknown, options?: RequestOptions): Promise<ApiResponse>;
  delete(path: string): Promise<ApiResponse>;
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  target: TestDatabaseTarget;
  url: string;
  /** Calls made as the given user (the dev header), or anonymously when no id is given. */
  as(userId?: string | null): ApiCaller;
  /** Empties every table of the test database. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** Configuration the fake ConfigService answers with, on top of the defaults. */
  config?: Record<string, unknown>;
  /** Hook to override providers before the module compiles. */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/** The parsed body, or null when the response is empty or not JSON. */
function parseJson(text: string): Json {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function createCaller(baseUrl: string, userId: string | null): ApiCaller {
  async function request(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse> {
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const hasBody = options.rawBody !== undefined || options.body !== undefined;
    const response = await fetch(url, {
      method,
      headers: {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...(userId ? { [DEV_USER_HEADER]: userId } : {}),
        ...options.headers,
      },
      body:
        options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: parseJson(text),
      text,
      headers: response.headers,
      requestId: response.headers.get(REQUEST_ID_HEADER),
    };
  }

  return {
    request,
    get: (path, query) => request('GET', path, { query }),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    patch: (path, body, options) => request('PATCH', path, { ...options, body }),
    put: (path, body, options) => request('PUT', path, { ...options, body }),
    delete: (path) => request('DELETE', path),
  };
}

/**
 * Boots the API in-process, the way `main.ts` does, on an ephemeral port of 127.0.0.1, with:
 * - the real PrismaService connected to the test database (DATABASE_URL_TEST);
 * - a fake ConfigService that enables the development-only acting-user header, because Jest
 *   runs with NODE_ENV=test and `AppConfigModule` would (rightly) refuse the flag there.
 *
 * `AppConfigModule` is the only module of `AppModule` that is replaced.
 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const target = redirectDatabaseUrl();
  const config: Record<string, unknown> = {
    NODE_ENV: 'development',
    DEV_AUTH_ENABLED: true,
    DATABASE_URL: target.url,
    DATABASE_CONNECT_TIMEOUT_MS: 5000,
    ...options.config,
  };
  if (config.DATABASE_URL !== target.url) {
    throw new Error('The test app only ever connects to the test database.');
  }

  @Global()
  @Module({
    providers: [{ provide: ConfigService, useValue: { get: (key: string) => config[key] } }],
    exports: [ConfigService],
  })
  class TestConfigModule {}

  const builder = Test.createTestingModule({
    imports: [TestConfigModule, PrismaModule, PlatformModule, HealthModule, OperationsModule],
  });
  const moduleRef = await (options.configure ? options.configure(builder) : builder).compile();

  const app: INestApplication = moduleRef.createNestApplication({ logger: false });
  app.use(createRequestContextMiddleware());
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    target,
    url,
    as: (userId) => createCaller(url, userId ?? null),
    reset: () => truncateAll(prisma, target),
    close: () => app.close(),
  };
}
