import type { AddressInfo } from 'node:net';
import { Global, type INestApplication, type LoggerService, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import {
  AUTH_ACCESS_COOKIE,
  AUTH_REFRESH_COOKIE,
  CSRF_HEADER,
  REQUEST_ID_HEADER,
  type AuthClient,
} from '@ops/shared';
import { HealthModule } from '../../src/health/health.module';
import { AccessClock } from '../../src/operations/access/clock';
import { OperationsModule } from '../../src/operations/operations.module';
import {
  AccessTokenService,
  AUTH_CLOCK,
  AUTH_RANDOM,
  AUTH_SETTINGS,
  checkNewPassword,
  InMemoryRateLimiter,
  PasswordHasher,
  RATE_LIMITER,
  SessionService,
  systemRandom,
  type AuthSettings,
  type Clock,
} from '../../src/platform/auth';
import {
  NOTIFICATION_SENDER,
  type NotificationSender,
  type OneTimeCodeNotification,
} from '../../src/platform/notifications/notification-sender';
import { PlatformModule } from '../../src/platform/platform.module';
import { createRequestContextMiddleware } from '../../src/platform/request-context/request-context.middleware';
import { FILE_STORAGE, type FileStorage } from '../../src/platform/storage/file-storage';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeFileStorage } from './fake-file-storage';
import { redirectDatabaseUrl, truncateAll, type TestDatabaseTarget } from './test-database';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are JSON of many shapes; each test asserts the fields it reads
export type Json = any;

/** The origin the fake configuration allows, and the one `browser()` sends by default. */
export const TEST_WEB_ORIGIN = 'http://localhost:3000';

/** Signing secret of the test app. Not a real secret: it exists only in this file. */
export const TEST_AUTH_SECRET = 'integration-tests-only-signing-key-0123456789';

export interface ApiResponse {
  status: number;
  body: Json;
  /** The raw response text, for bodies that are not JSON. */
  text: string;
  headers: Headers;
  /** The `x-request-id` response header. */
  requestId: string | null;
  /** Every `Set-Cookie` header of the response, unparsed. */
  setCookies: string[];
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

export interface LoginOptions {
  /** Defaults to `mobile` for `loginAs` and is always `web` for `browser().login`. */
  client?: AuthClient;
  organizationSlug?: string;
  deviceName?: string;
  /** `Origin` header to send. `loginAs` sends none for `mobile` and the web origin for `web`. */
  origin?: string | null;
}

export interface BrowserOptions {
  /** `Origin` header of every request. Null sends none. Defaults to {@link TEST_WEB_ORIGIN}. */
  origin?: string | null;
  /**
   * The `x-csrf-token` header of state-changing requests: `true` (default) sends the token the
   * API last returned, `false` sends none, a string sends exactly that.
   */
  csrf?: boolean | string;
}

/**
 * A caller that behaves like a browser tab of the web app: it keeps the cookies the API sets
 * (honouring their path and deletion), sends them back, sends an `Origin` header, and sends the
 * CSRF token it learned from login, refresh or `/auth/me` on every request that is not a GET.
 */
export interface BrowserCaller extends ApiCaller {
  /** Signs in with `client: 'web'`. The raw response is returned; cookies are kept. */
  login(identifier: string, password: string, options?: LoginOptions): Promise<ApiResponse>;
  /** `POST /auth/refresh` with an empty body (the cookie is used). */
  refresh(): Promise<ApiResponse>;
  /** The cookies currently held, by name. */
  readonly cookies: ReadonlyMap<string, string>;
  /** The CSRF token last returned by the API, or null. */
  readonly csrfToken: string | null;
  /** Puts a cookie in the jar (to replay an old token, ...). */
  setCookie(name: string, value: string, path?: string): void;
  /** Another caller on the SAME cookie jar with other options (a foreign origin, no CSRF). */
  with(options: BrowserOptions): BrowserCaller;
}

/** A clock the tests can move. It starts at the real time and runs with it. */
export class TestClock implements Clock {
  private offsetMs = 0;
  private frozenAt: number | null = null;

  now(): Date {
    return new Date((this.frozenAt ?? Date.now()) + this.offsetMs);
  }

  /** Moves the time forward (or back, with a negative value). */
  advance(milliseconds: number): void {
    this.offsetMs += milliseconds;
  }

  advanceSeconds(seconds: number): void {
    this.advance(seconds * 1000);
  }

  advanceMinutes(minutes: number): void {
    this.advance(minutes * 60_000);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }

  /** Stops the clock at the given moment (or at the current one) until `reset`. */
  freeze(at: Date = this.now()): void {
    this.frozenAt = at.getTime();
    this.offsetMs = 0;
  }

  /** Back to the real time. */
  reset(): void {
    this.offsetMs = 0;
    this.frozenAt = null;
  }
}

/** Stands in for email and SMS: it keeps what would have been sent, code included. */
export class FakeNotificationSender implements NotificationSender {
  readonly sent: OneTimeCodeNotification[] = [];

  sendOneTimeCode(notification: OneTimeCodeNotification): Promise<void> {
    this.sent.push(notification);
    return Promise.resolve();
  }

  /** The most recent notification, optionally of one user. */
  last(userId?: string): OneTimeCodeNotification | null {
    const matching = userId ? this.sent.filter((item) => item.user.id === userId) : this.sent;
    return matching.at(-1) ?? null;
  }

  /** The most recent code issued, optionally for one user. Throws when there is none. */
  lastCode(userId?: string): string {
    const notification = this.last(userId);
    if (!notification) {
      throw new Error('No one-time code has been issued');
    }
    return notification.code;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  target: TestDatabaseTarget;
  url: string;
  /**
   * Calls made as the given user, or anonymously when no id is given. The user is really
   * authenticated: the harness opens a `mobile` session for them through `SessionService` (no
   * password needed, no audit event written) and sends its access token as a bearer token. The
   * session is reused within a test and replaced when it has ended, so `as(id)` always acts as
   * that user for as long as the user is allowed in at all (an archived user gets 401). To test
   * that a session really ended, use `loginAs` + `bearer`, or `browser()`.
   */
  as(userId?: string | null): ApiCaller;
  /** Calls made with exactly this access token as the bearer token. */
  bearer(accessToken: string): ApiCaller;
  /** `POST /auth/login` (as `mobile` unless told otherwise). Returns the raw response. */
  loginAs(identifier: string, password: string, options?: LoginOptions): Promise<ApiResponse>;
  /** A new browser-like caller with its own, empty cookie jar. */
  browser(options?: BrowserOptions): BrowserCaller;
  /** Gives a user a password directly (policy applied, no code, no audit event). */
  setPassword(userId: string, password: string): Promise<void>;
  /**
   * The clock of the auth module and of the access rules: token, code, lockout, rate-limit and
   * work-log edit windows follow it. (Rows written by the database or by services through
   * `new Date()`, such as `createdAt`, keep the real time.)
   */
  clock: TestClock;
  /** What the notification sender was asked to send; `lastCode(userId)` gives the code. */
  notifications: FakeNotificationSender;
  /**
   * The in-memory file storage bound to `FILE_STORAGE` (unless `options.storage` replaced it):
   * `storage.uploadTo(upload.url, bytes)` plays the client's PUT; `storage.fail = true` makes
   * the storage unreachable.
   */
  storage: FakeFileStorage;
  /** The rate limiter of the app. `reset()` empties it; it is also emptied by `reset()` below. */
  rateLimiter: InMemoryRateLimiter;
  /** The settings the auth module runs with (TTL values, limits, allowed origins). */
  authSettings: AuthSettings;
  /** Empties every table of the test database, and the harness's sessions, clock and fakes (storage included). */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  /**
   * Configuration the fake ConfigService answers with, on top of the defaults. Auth settings
   * are plain keys here (`AUTH_MAX_FAILED_LOGINS: 3`, `AUTH_LOCKOUT_MINUTES: 1`,
   * `AUTH_REFRESH_REUSE_GRACE_SECONDS: 0`, `AUTH_RATE_LIMITS: { loginPerIp: {...} }`,
   * `NODE_ENV: 'production'`, ...). Numbers, not strings: nothing parses them.
   */
  config?: Record<string, unknown>;
  /**
   * Hook to override providers before the module compiles. It runs after the harness's own
   * overrides, so it may replace any of them (`builder.overrideProvider(FILE_STORAGE)...`).
   */
  configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  /** File storage to bind instead of the in-memory fake (for example a real `S3FileStorage`). */
  storage?: FileStorage;
  /** Logger of the application (default: none). To capture what the API logs. */
  logger?: LoggerService;
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

type HeaderSource = (
  method: string,
  path: string,
) => Record<string, string> | Promise<Record<string, string>>;

function createCaller(
  baseUrl: string,
  extraHeaders: HeaderSource,
  onResponse?: (path: string, response: ApiResponse) => void,
): ApiCaller {
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
        ...(await extraHeaders(method.toUpperCase(), url.pathname)),
        ...options.headers,
      },
      body:
        options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
    });
    const text = await response.text();
    const result: ApiResponse = {
      status: response.status,
      body: parseJson(text),
      text,
      headers: response.headers,
      requestId: response.headers.get(REQUEST_ID_HEADER),
      setCookies: response.headers.getSetCookie(),
    };
    onResponse?.(url.pathname, result);
    return result;
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

interface JarCookie {
  value: string;
  path: string;
}

/** The shared state of every `BrowserCaller` made from one `browser()` call. */
class CookieJar {
  readonly cookies = new Map<string, JarCookie>();
  csrfToken: string | null = null;

  store(setCookies: string[]): void {
    for (const header of setCookies) {
      const [pair = '', ...attributes] = header.split(';').map((part) => part.trim());
      const index = pair.indexOf('=');
      if (index <= 0) {
        continue;
      }
      const name = pair.slice(0, index);
      const value = decodeURIComponent(pair.slice(index + 1));
      let path = '/';
      let deleted = value === '';
      for (const attribute of attributes) {
        const [key = '', attributeValue = ''] = attribute.split('=');
        if (key.toLowerCase() === 'path') {
          path = attributeValue || '/';
        }
        if (key.toLowerCase() === 'max-age' && Number(attributeValue) <= 0) {
          deleted = true;
        }
      }
      if (deleted) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, { value, path });
      }
    }
  }

  headerFor(path: string): string {
    return [...this.cookies]
      .filter(
        ([, cookie]) =>
          path === cookie.path || path.startsWith(`${cookie.path.replace(/\/$/, '')}/`),
      )
      .map(([name, cookie]) => `${name}=${encodeURIComponent(cookie.value)}`)
      .join('; ');
  }
}

function createBrowser(baseUrl: string, jar: CookieJar, options: BrowserOptions): BrowserCaller {
  const origin = options.origin === undefined ? TEST_WEB_ORIGIN : options.origin;
  const csrf = options.csrf ?? true;

  const caller = createCaller(
    baseUrl,
    (method, path) => {
      const headers: Record<string, string> = {};
      const cookie = jar.headerFor(path);
      if (cookie) {
        headers.Cookie = cookie;
      }
      if (origin !== null) {
        headers.Origin = origin;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        const token = typeof csrf === 'string' ? csrf : csrf ? jar.csrfToken : null;
        if (token) {
          headers[CSRF_HEADER] = token;
        }
      }
      return headers;
    },
    (_path, response) => {
      jar.store(response.setCookies);
      const token: unknown = response.body?.csrfToken;
      if (response.status < 300 && typeof token === 'string') {
        jar.csrfToken = token;
      }
    },
  );

  return {
    ...caller,
    login: (identifier, password, login = {}) =>
      caller.post('/auth/login', {
        identifier,
        password,
        client: 'web',
        ...(login.organizationSlug ? { organizationSlug: login.organizationSlug } : {}),
        ...(login.deviceName ? { deviceName: login.deviceName } : {}),
      }),
    refresh: () => caller.post('/auth/refresh', {}),
    get cookies() {
      return new Map([...jar.cookies].map(([name, cookie]) => [name, cookie.value]));
    },
    get csrfToken() {
      return jar.csrfToken;
    },
    setCookie: (name, value, path) =>
      void jar.cookies.set(name, {
        value,
        path: path ?? (name === AUTH_REFRESH_COOKIE ? '/auth' : '/'),
      }),
    with: (other) => createBrowser(baseUrl, jar, { origin, csrf, ...other }),
  };
}

interface HarnessSession {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: number;
}

/**
 * Boots the API in-process, the way `main.ts` does, on an ephemeral port of 127.0.0.1, with:
 * - the real PrismaService connected to the test database (DATABASE_URL_TEST);
 * - a fake ConfigService (Jest runs with NODE_ENV=test and without the auth variables of
 *   `.env`); it answers `NODE_ENV: 'development'` unless a test says otherwise;
 * - the auth module's replaceable parts swapped for controllable ones: a `TestClock`, a
 *   `FakeNotificationSender`, an in-memory rate limiter on the test clock, and a password hasher
 *   with cheap parameters (still argon2id) so suites stay fast.
 *
 * `AppConfigModule` is the only module of `AppModule` that is replaced.
 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const target = redirectDatabaseUrl();
  const config: Record<string, unknown> = {
    NODE_ENV: 'development',
    DATABASE_URL: target.url,
    DATABASE_CONNECT_TIMEOUT_MS: 5000,
    CORS_ORIGINS: [TEST_WEB_ORIGIN],
    WEB_APP_URL: TEST_WEB_ORIGIN,
    AUTH_ACCESS_TOKEN_SECRET: TEST_AUTH_SECRET,
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
    AUTH_REFRESH_TOKEN_TTL_DAYS: 30,
    AUTH_SESSION_ABSOLUTE_TTL_DAYS: 90,
    AUTH_REFRESH_REUSE_GRACE_SECONDS: 10,
    AUTH_ACTIVATION_CODE_TTL_HOURS: 72,
    AUTH_RESET_CODE_TTL_MINUTES: 60,
    AUTH_MAX_FAILED_LOGINS: 5,
    AUTH_LOCKOUT_MINUTES: 15,
    // File storage: the fake below ignores the connection settings; the limits are real.
    STORAGE_ENDPOINT: 'http://127.0.0.1:9',
    STORAGE_PUBLIC_ENDPOINT: 'http://127.0.0.1:9',
    STORAGE_REGION: 'us-east-1',
    STORAGE_BUCKET: 'hz-attachments-test',
    STORAGE_ACCESS_KEY_ID: 'integration-tests',
    STORAGE_SECRET_ACCESS_KEY: 'integration-tests-only-not-a-secret',
    STORAGE_FORCE_PATH_STYLE: true,
    UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
    UPLOAD_URL_TTL_SECONDS: 300,
    DOWNLOAD_URL_TTL_SECONDS: 300,
    // Background work stays off unless a test turns it on.
    OUTBOX_CONSUMER_ENABLED: false,
    OUTBOX_POLL_INTERVAL_MS: 200,
    PUSH_ENABLED: false,
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

  const clock = new TestClock();
  const notifications = new FakeNotificationSender();
  const rateLimiter = new InMemoryRateLimiter(clock);
  const storage = new FakeFileStorage();

  const builder = Test.createTestingModule({
    imports: [TestConfigModule, PrismaModule, PlatformModule, HealthModule, OperationsModule],
  })
    .overrideProvider(AUTH_CLOCK)
    .useValue(clock)
    .overrideProvider(AUTH_RANDOM)
    .useValue(systemRandom)
    .overrideProvider(NOTIFICATION_SENDER)
    .useValue(notifications)
    .overrideProvider(RATE_LIMITER)
    .useValue(rateLimiter)
    .overrideProvider(PasswordHasher)
    .useValue(new PasswordHasher({ memoryCost: 1024, timeCost: 1 }))
    // The access rules (the work-log edit window) run on the same test clock.
    .overrideProvider(AccessClock)
    .useValue(clock)
    .overrideProvider(FILE_STORAGE)
    .useValue(options.storage ?? storage);
  const moduleRef = await (options.configure ? options.configure(builder) : builder).compile();

  const app: INestApplication = moduleRef.createNestApplication({
    logger: options.logger ?? false,
  });
  app.use(createRequestContextMiddleware());
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const prisma = app.get(PrismaService);
  const sessions = app.get(SessionService);
  const accessTokens = app.get(AccessTokenService);
  const hasher = app.get(PasswordHasher);
  const authSettings = app.get<AuthSettings>(AUTH_SETTINGS);

  const harnessSessions = new Map<string, HarnessSession>();

  /** A bearer token of a live session of the user; 'invalid' when there is no such user. */
  async function accessTokenFor(userId: string): Promise<string> {
    const now = clock.now().getTime();
    const cached = harnessSessions.get(userId);
    if (cached) {
      const live = await sessions.findActive(prisma, cached.sessionId);
      if (live) {
        if (cached.accessTokenExpiresAt - now > 5000) {
          return cached.accessToken;
        }
        const renewed = accessTokens.sign({
          sub: live.userId,
          org: live.organizationId,
          sid: live.id,
        });
        harnessSessions.set(userId, {
          sessionId: live.id,
          accessToken: renewed.token,
          accessTokenExpiresAt: renewed.expiresAt.getTime(),
        });
        return renewed.token;
      }
    }
    const user = await prisma.user
      .findUnique({ where: { id: userId }, select: { id: true, organizationId: true } })
      .catch(() => null);
    if (!user) {
      return 'invalid';
    }
    const grant = await sessions.create(prisma, {
      userId: user.id,
      organizationId: user.organizationId,
      client: 'mobile',
      deviceName: 'integration test',
    });
    harnessSessions.set(userId, {
      sessionId: grant.session.id,
      accessToken: grant.accessToken,
      accessTokenExpiresAt: grant.accessTokenExpiresAt.getTime(),
    });
    return grant.accessToken;
  }

  return {
    app,
    prisma,
    target,
    url,
    as: (userId) =>
      createCaller(url, async (): Promise<Record<string, string>> =>
        userId ? { Authorization: `Bearer ${await accessTokenFor(userId)}` } : {},
      ),
    bearer: (accessToken) => createCaller(url, () => ({ Authorization: `Bearer ${accessToken}` })),
    loginAs: (identifier, password, login = {}) => {
      const client = login.client ?? 'mobile';
      const origin =
        login.origin === undefined ? (client === 'web' ? TEST_WEB_ORIGIN : null) : login.origin;
      return createCaller(url, (): Record<string, string> =>
        origin ? { Origin: origin } : {},
      ).post('/auth/login', {
        identifier,
        password,
        client,
        ...(login.organizationSlug ? { organizationSlug: login.organizationSlug } : {}),
        ...(login.deviceName ? { deviceName: login.deviceName } : {}),
      });
    },
    browser: (browserOptions = {}) => createBrowser(url, new CookieJar(), browserOptions),
    setPassword: async (userId, password) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const problems = checkNewPassword(password, user);
      if (problems.length > 0) {
        throw new Error(`Test password refused by the policy: ${problems[0]?.message}`);
      }
      const passwordHash = await hasher.hash(password);
      const passwordChangedAt = clock.now();
      await prisma.authCredential.upsert({
        where: { userId },
        create: { userId, organizationId: user.organizationId, passwordHash, passwordChangedAt },
        update: { passwordHash, passwordChangedAt, failedAttempts: 0, lockedUntil: null },
      });
    },
    clock,
    notifications,
    storage,
    rateLimiter,
    authSettings,
    reset: async () => {
      harnessSessions.clear();
      clock.reset();
      notifications.clear();
      storage.clear();
      await rateLimiter.reset();
      await truncateAll(prisma, target);
    },
    close: () => app.close(),
  };
}

export { AUTH_ACCESS_COOKIE, AUTH_REFRESH_COOKIE };
