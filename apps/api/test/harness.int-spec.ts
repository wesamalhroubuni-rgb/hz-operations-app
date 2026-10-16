import { createOrganization, createTenant } from './support/factories';
import { AuthAdminService } from '../src/platform/auth';
import { startTestApp, type TestApp } from './support/test-app';
import {
  ORIGINAL_DATABASE_URL_KEY,
  redirectDatabaseUrl,
  resolveTestDatabase,
  truncateAll,
  UnsafeTestDatabaseError,
} from './support/test-database';

// The harness deletes all data of its database between tests. These tests prove it cannot be
// aimed at the development database. Example credentials only.

const DEV = 'postgresql://ops:example@localhost:5432/operations_app?schema=public';
const TEST = 'postgresql://ops:example@localhost:5432/operations_app_test?schema=public';

describe('test database guard (resolveTestDatabase)', () => {
  it('accepts a database whose name ends in _test and differs from DATABASE_URL', () => {
    expect(resolveTestDatabase({ DATABASE_URL: DEV, DATABASE_URL_TEST: TEST })).toEqual({
      url: TEST,
      database: 'operations_app_test',
      maintenanceUrl: 'postgresql://ops:example@localhost:5432/postgres?schema=public',
    });
  });

  it('accepts a _test database when DATABASE_URL is not set at all', () => {
    expect(resolveTestDatabase({ DATABASE_URL_TEST: TEST }).database).toBe('operations_app_test');
  });

  it.each([
    ['is missing', undefined],
    ['is empty', ''],
    ['is blank', '   '],
  ])('refuses to run when DATABASE_URL_TEST %s', (_name, value) => {
    expect(() => resolveTestDatabase({ DATABASE_URL: DEV, DATABASE_URL_TEST: value })).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it.each([
    ['the development database', DEV],
    ['a name that only contains "test"', 'postgresql://ops:example@localhost:5432/test_operations'],
    [
      'a name ending in "test" without the underscore',
      'postgresql://ops:example@localhost/apptest',
    ],
    ['a name ending in _TEST in upper case', 'postgresql://ops:example@localhost/operations_TEST'],
    ['the maintenance database', 'postgresql://ops:example@localhost:5432/postgres'],
    ['no database name', 'postgresql://ops:example@localhost:5432/'],
    ['a name with characters that need quoting', 'postgresql://ops:example@localhost/a%22b_test'],
    ['_test in the query string only', 'postgresql://ops:example@localhost/app?schema=x_test'],
    ['_test in the user name only', 'postgresql://ops_test:example@localhost/app'],
  ])('refuses %s', (_name, url) => {
    expect(() => resolveTestDatabase({ DATABASE_URL_TEST: url })).toThrow('must end in "_test"');
  });

  it('refuses a target that is the DATABASE_URL database, even when its name ends in _test', () => {
    expect(() => resolveTestDatabase({ DATABASE_URL: TEST, DATABASE_URL_TEST: TEST })).toThrow(
      'name the same database',
    );
  });

  it('refuses the same database written differently (other host spelling, port, parameters)', () => {
    expect(() =>
      resolveTestDatabase({
        DATABASE_URL: 'postgres://ops:example@127.0.0.1/operations_app_test',
        DATABASE_URL_TEST: TEST,
      }),
    ).toThrow('name the same database');
  });

  it.each([
    ['not a URL', 'operations_app_test'],
    ['another protocol', 'mysql://ops:example@localhost:3306/operations_app_test'],
  ])('refuses a DATABASE_URL_TEST that is %s', (_name, url) => {
    expect(() => resolveTestDatabase({ DATABASE_URL_TEST: url })).toThrow(UnsafeTestDatabaseError);
  });

  it('never repeats the connection string, which holds a password, in its message', () => {
    const secret = 'postgresql://ops:hunter2-example@localhost:5432/operations_app';
    for (const env of [
      { DATABASE_URL_TEST: secret },
      { DATABASE_URL_TEST: 'hunter2-example' },
      { DATABASE_URL_TEST: TEST, DATABASE_URL: 'hunter2-example' },
    ]) {
      let message = '';
      try {
        resolveTestDatabase(env);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('Refusing to run the integration tests');
      expect(message).not.toContain('hunter2-example');
    }
  });
});

describe('redirectDatabaseUrl', () => {
  it('points DATABASE_URL at the test database and remembers the original', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: DEV, DATABASE_URL_TEST: TEST };
    expect(redirectDatabaseUrl(env).database).toBe('operations_app_test');
    expect(env.DATABASE_URL).toBe(TEST);
    expect(env[ORIGINAL_DATABASE_URL_KEY]).toBe(DEV);
  });

  it('can be called again, and still checks against the original DATABASE_URL', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: DEV, DATABASE_URL_TEST: TEST };
    redirectDatabaseUrl(env);
    expect(redirectDatabaseUrl(env).url).toBe(TEST);

    // Somebody repoints the test variable at the development database half-way through.
    env.DATABASE_URL_TEST = DEV;
    expect(() => redirectDatabaseUrl(env)).toThrow(UnsafeTestDatabaseError);
  });

  it('refuses identical variables and leaves the environment untouched', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL: TEST, DATABASE_URL_TEST: TEST };
    expect(() => redirectDatabaseUrl(env)).toThrow('name the same database');
    expect(env).toEqual({ DATABASE_URL: TEST, DATABASE_URL_TEST: TEST });
  });

  it('works when the process has no DATABASE_URL, also on a second call', () => {
    const env: Record<string, string | undefined> = { DATABASE_URL_TEST: TEST };
    redirectDatabaseUrl(env);
    expect(redirectDatabaseUrl(env).url).toBe(TEST);
    expect(env.DATABASE_URL).toBe(TEST);
  });
});

describe('the running harness', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('has redirected this process to the test database', () => {
    expect(process.env.DATABASE_URL).toBe(process.env.DATABASE_URL_TEST);
    expect(process.env[ORIGINAL_DATABASE_URL_KEY]).not.toBe(process.env.DATABASE_URL_TEST);
  });

  it('is connected to a database whose name ends in _test', async () => {
    const rows = await ctx.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT current_database() AS name`;
    expect(rows[0]?.name).toBe(ctx.target.database);
    expect(rows[0]?.name).toMatch(/_test$/);
  });

  it('refuses to start the app against another database', async () => {
    await expect(
      startTestApp({ config: { DATABASE_URL: process.env[ORIGINAL_DATABASE_URL_KEY] || DEV } }),
    ).rejects.toThrow('only ever connects to the test database');
  });

  it('refuses to truncate when the connection is not on the resolved test database', async () => {
    await createOrganization(ctx.prisma);
    await expect(
      truncateAll(ctx.prisma, { ...ctx.target, database: 'some_other_test' }),
    ).rejects.toThrow(UnsafeTestDatabaseError);
    expect(await ctx.prisma.organization.count()).toBe(1);
  });

  it('empties every table between tests, the append-only audit log included', async () => {
    const { organization, admin } = await createTenant(ctx.prisma);
    const created = await ctx.as(admin.id).post('/sites', { name: 'Depot' });
    expect(created.status).toBe(201);
    expect(await ctx.prisma.auditEvent.count()).toBe(1);

    await ctx.reset();

    expect(await ctx.prisma.organization.count({ where: { id: organization.id } })).toBe(0);
    expect(await ctx.prisma.site.count()).toBe(0);
    expect(await ctx.prisma.auditEvent.count()).toBe(0);
    expect(await ctx.prisma.outboxEvent.count()).toBe(0);
  });

  it('restarts the outbox sequence, so sequences are predictable in every test', async () => {
    const { admin } = await createTenant(ctx.prisma);
    await ctx.as(admin.id).post('/sites', { name: 'Depot' });
    const [event] = await ctx.prisma.outboxEvent.findMany();
    expect(event?.sequence).toBe(1n);
  });

  it('answers /health from the real database', async () => {
    const response = await ctx.as().get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'up' });
  });
});

// The helpers the other suites authenticate with. Example password only.
describe('the authentication helpers of the harness', () => {
  const PASSWORD = 'harness example passphrase';
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('as(userId) is really authenticated: a session exists, and no audit event is written', async () => {
    const { admin } = await createTenant(ctx.prisma);
    const me = await ctx.as(admin.id).get('/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: admin.id, displayName: 'Admin' });
    expect(me.body.csrfToken).toBeNull();
    expect(await ctx.prisma.authSession.count({ where: { userId: admin.id } })).toBe(1);

    // The same session is reused within a test.
    await ctx.as(admin.id).get('/auth/me');
    expect(await ctx.prisma.authSession.count({ where: { userId: admin.id } })).toBe(1);
    expect(await ctx.prisma.auditEvent.count()).toBe(0);
  });

  it('as() answers 401 for nobody, an unknown user, an archived user, and the old dev header', async () => {
    const { organization, admin } = await createTenant(ctx.prisma);
    const archived = await ctx.prisma.user.create({
      data: { organizationId: organization.id, displayName: 'Gone', archivedAt: new Date() },
    });
    for (const caller of [
      ctx.as(),
      ctx.as('0190f3a2-7c1e-7000-8000-0000000000ff'),
      ctx.as(archived.id),
    ]) {
      expect((await caller.get('/auth/me')).status).toBe(401);
    }
    const header = await ctx
      .as()
      .request('GET', '/auth/me', { headers: { 'x-dev-user-id': admin.id } });
    expect(header.status).toBe(401);
  });

  it('as() keeps acting as the user after their sessions ended and after the token expired', async () => {
    const { admin } = await createTenant(ctx.prisma);
    expect((await ctx.as(admin.id).post('/auth/logout-all')).status).toBe(204);
    expect((await ctx.as(admin.id).get('/auth/me')).status).toBe(200);

    ctx.clock.advanceMinutes(16);
    expect((await ctx.as(admin.id).get('/auth/me')).status).toBe(200);
  });

  it('loginAs signs in as a mobile client: tokens in the body, no cookies', async () => {
    const { admin } = await createTenant(ctx.prisma);
    const email = admin.email ?? '';
    expect((await ctx.loginAs(email, PASSWORD)).status).toBe(401);

    await ctx.setPassword(admin.id, PASSWORD);
    const login = await ctx.loginAs(email.toUpperCase(), PASSWORD);
    expect(login.status).toBe(200);
    expect(login.setCookies).toEqual([]);
    expect(login.headers.get('cache-control')).toBe('no-store');
    expect(login.body.csrfToken).toBeNull();
    expect(login.body.tokens.refreshToken).toEqual(expect.any(String));

    const bearer = ctx.bearer(login.body.tokens.accessToken);
    expect((await bearer.get('/auth/me')).body.session.id).toBe(login.body.session.id);

    // The clock is the auth module's: past the token lifetime the bearer token is refused,
    // and the refresh token still renews the session.
    ctx.clock.advanceSeconds(ctx.authSettings.accessTokenTtlSeconds + 1);
    expect((await bearer.get('/auth/me')).status).toBe(401);
    const refreshed = await ctx
      .as()
      .post('/auth/refresh', { refreshToken: login.body.tokens.refreshToken });
    expect(refreshed.status).toBe(200);
    expect((await ctx.bearer(refreshed.body.tokens.accessToken).get('/auth/me')).status).toBe(200);
  });

  it('browser() keeps httpOnly cookies, and sends Origin and the CSRF token', async () => {
    const { admin } = await createTenant(ctx.prisma);
    await ctx.setPassword(admin.id, PASSWORD);

    const browser = ctx.browser();
    const login = await browser.login(admin.email ?? '', PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body.tokens).toBeNull();
    expect(login.setCookies).toHaveLength(2);
    for (const cookie of login.setCookies) {
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
    }
    expect([...browser.cookies.keys()].sort()).toEqual(['access_token', 'refresh_token']);
    expect(browser.csrfToken).toBe(login.body.csrfToken);
    expect(JSON.stringify(login.body)).not.toContain(browser.cookies.get('access_token'));

    expect((await browser.get('/auth/me')).body.csrfToken).toBe(browser.csrfToken);

    // A write without the token, or from another origin, is refused; the session is untouched.
    expect((await browser.with({ csrf: false }).post('/auth/logout-all')).status).toBe(403);
    expect((await browser.with({ csrf: 'wrong' }).post('/auth/logout-all')).status).toBe(403);
    expect(
      (await browser.with({ origin: 'https://evil.example' }).post('/auth/logout-all')).status,
    ).toBe(403);
    expect((await browser.with({ origin: null }).post('/auth/logout-all')).status).toBe(403);
    expect((await browser.get('/auth/me')).status).toBe(200);

    const refreshed = await browser.refresh();
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.tokens).toBeNull();

    expect((await browser.post('/auth/logout')).status).toBe(204);
    expect(browser.cookies.size).toBe(0);
  });

  it('notifications gives the one-time code that would have been sent', async () => {
    const { organization, admin } = await createTenant(ctx.prisma);
    const issued = await ctx.app.get(AuthAdminService).issueOneTimeCode(ctx.prisma, {
      userId: admin.id,
      organizationId: organization.id,
      purpose: 'activation',
    });
    const code = ctx.notifications.lastCode(admin.id);
    // The harness answers NODE_ENV=development, the one environment that shows the code.
    expect(issued.code).toBe(code);

    const set = await ctx
      .as()
      .post('/auth/set-password', { code: code.toLowerCase(), password: PASSWORD });
    expect(set.status).toBe(204);
    expect((await ctx.loginAs(admin.email ?? '', PASSWORD)).status).toBe(200);
    const again = await ctx.as().post('/auth/set-password', { code, password: PASSWORD });
    expect(again.status).toBe(422);

    const stored = JSON.stringify(await ctx.prisma.auditEvent.findMany());
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(code.replaceAll('-', ''));
    expect(stored).not.toContain(PASSWORD);
  });

  it('reset() empties the rate limiter, the clock and the notifications', async () => {
    const limit = ctx.authSettings.rateLimits.loginPerIdentifier.limit;
    for (let attempt = 0; attempt < limit; attempt += 1) {
      expect((await ctx.loginAs('nobody@example.test', PASSWORD)).status).toBe(401);
    }
    const limited = await ctx.loginAs('nobody@example.test', PASSWORD);
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    ctx.clock.advanceDays(3);
    await ctx.reset();
    expect(Math.abs(ctx.clock.now().getTime() - Date.now())).toBeLessThan(5000);
    expect(ctx.notifications.sent).toHaveLength(0);
    expect((await ctx.loginAs('nobody@example.test', PASSWORD)).status).toBe(401);
  });
});
