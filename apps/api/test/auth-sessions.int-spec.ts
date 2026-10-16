import { randomUUID } from 'node:crypto';
import { AUTH_ACCESS_COOKIE, AUTH_REFRESH_COOKIE, CSRF_HEADER } from '@ops/shared';
import {
  createMembership,
  createSite,
  createTenant,
  createUser,
  type Tenant,
} from './support/factories';
import {
  startTestApp,
  TEST_WEB_ORIGIN,
  type ApiResponse,
  type Json,
  type TestApp,
} from './support/test-app';

// Sessions (rotation, reuse detection, sign-out, revocation, expiry) and the web cookie mode with
// its CSRF protection, over HTTP on the real database. Example passwords only.

const PASSWORD = 'correct horse battery';
const DAY = 86_400_000;

interface Person {
  id: string;
  email: string;
  membershipId: string;
  siteId: string;
}

async function person(
  ctx: TestApp,
  tenant: Tenant,
  role: 'worker' | 'supervisor' = 'worker',
): Promise<Person> {
  const site = await createSite(ctx.prisma, tenant.organization.id);
  const user = await createUser(ctx.prisma, tenant.organization.id);
  const membership = await createMembership(ctx.prisma, tenant.organization.id, user.id, role, {
    siteIds: [site.id],
  });
  await ctx.setPassword(user.id, PASSWORD);
  return { id: user.id, email: user.email!, membershipId: membership.id, siteId: site.id };
}

/** A mobile sign-in: returns the tokens and a bearer caller. */
async function mobile(ctx: TestApp, who: Person) {
  const login = await ctx.loginAs(who.email, PASSWORD);
  expect(login.status).toBe(200);
  const tokens = login.body.tokens as { accessToken: string; refreshToken: string };
  return {
    ...tokens,
    sessionId: login.body.session.id as string,
    api: ctx.bearer(tokens.accessToken),
  };
}

const refresh = (ctx: TestApp, refreshToken: string) =>
  ctx.as().post('/auth/refresh', { refreshToken });

describe('sessions', () => {
  let ctx: TestApp;
  let tenant: Tenant;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
  });
  afterAll(() => ctx.close());

  describe('refresh-token rotation and reuse (default grace of 10 s)', () => {
    it('gives a new refresh token on every use; the old one is single use', async () => {
      const who = await person(ctx, tenant);
      const first = await mobile(ctx, who);
      const second = await refresh(ctx, first.refreshToken);
      expect(second.status).toBe(200);
      expect(second.body.tokens.refreshToken).not.toBe(first.refreshToken);
      expect(second.body.session.id).toBe(first.sessionId);
      expect((await ctx.bearer(second.body.tokens.accessToken).get('/auth/me')).status).toBe(200);

      // Replayed at once (inside the grace): refused, nothing revoked.
      const replay = await refresh(ctx, first.refreshToken);
      expect(replay.status).toBe(401);
      expect(
        (await ctx.prisma.authSession.findUniqueOrThrow({ where: { id: first.sessionId } }))
          .revokedAt,
      ).toBeNull();
      const third = await refresh(ctx, second.body.tokens.refreshToken);
      expect(third.status).toBe(200);
      expect(
        await ctx.prisma.auditEvent.count({ where: { action: 'auth.refresh_reuse_detected' } }),
      ).toBe(0);
    });

    it('a used token presented after the grace revokes the whole session family, and is audited', async () => {
      const who = await person(ctx, tenant);
      const first = await mobile(ctx, who);
      const second = await refresh(ctx, first.refreshToken);
      const newest = second.body.tokens as { accessToken: string; refreshToken: string };

      ctx.clock.advanceSeconds(ctx.authSettings.refreshReuseGraceMs / 1000 + 1);
      const stolen = await refresh(ctx, first.refreshToken);
      expect(stolen.status).toBe(401);

      // The rightful holder of the newest tokens is out too.
      expect((await refresh(ctx, newest.refreshToken)).status).toBe(401);
      expect((await ctx.bearer(newest.accessToken).get('/auth/me')).status).toBe(401);
      expect(
        await ctx.prisma.authSession.findUniqueOrThrow({ where: { id: first.sessionId } }),
      ).toMatchObject({ revokedReason: 'refresh_reuse' });
      const events = await ctx.prisma.auditEvent.findMany({
        where: { action: 'auth.refresh_reuse_detected' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organizationId: tenant.organization.id,
        entityType: 'auth',
        entityId: first.sessionId,
        after: { userId: who.id, client: 'mobile' },
      });
      // Other sessions of the same user are not part of the family.
      const elsewhere = await mobile(ctx, who);
      expect((await elsewhere.api.get('/auth/me')).status).toBe(200);
    });

    it('two refreshes with the same token at the same moment: exactly one wins', async () => {
      for (let round = 0; round < 5; round += 1) {
        const who = await person(ctx, tenant);
        const first = await mobile(ctx, who);
        const results = await Promise.all([
          refresh(ctx, first.refreshToken),
          refresh(ctx, first.refreshToken),
          refresh(ctx, first.refreshToken),
        ]);
        const winners = results.filter((response) => response.status === 200);
        expect(winners).toHaveLength(1);
        expect(results.filter((response) => response.status === 401)).toHaveLength(2);
        // The winner's tokens keep the session alive: losing a race is not reuse.
        expect((await refresh(ctx, winners[0]!.body.tokens.refreshToken)).status).toBe(200);
        expect(
          await ctx.prisma.authRefreshToken.count({ where: { sessionId: first.sessionId } }),
        ).toBe(3);
      }
    });

    it('an unknown or malformed refresh token is a plain 401', async () => {
      for (const token of ['x', randomUUID(), 'a'.repeat(512)]) {
        expect((await refresh(ctx, token)).status).toBe(401);
      }
      expect((await ctx.as().post('/auth/refresh', { refreshToken: 'a'.repeat(513) })).status).toBe(
        400,
      );
    });
  });

  describe('sign-out', () => {
    it('logout ends this device only', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      const tablet = await mobile(ctx, who);
      expect((await phone.api.post('/auth/logout')).status).toBe(204);
      expect((await phone.api.get('/auth/me')).status).toBe(401);
      expect((await refresh(ctx, phone.refreshToken)).status).toBe(401);
      expect((await tablet.api.get('/auth/me')).status).toBe(200);
      expect(await ctx.prisma.auditEvent.count({ where: { action: 'auth.logout' } })).toBe(1);
    });

    it('a mobile client can sign out with its refresh token once the access token has expired', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      ctx.clock.advanceSeconds(ctx.authSettings.accessTokenTtlSeconds + 5);
      expect((await phone.api.get('/auth/me')).status).toBe(401);
      const out = await ctx.as().post('/auth/logout', { refreshToken: phone.refreshToken });
      expect(out.status).toBe(204);
      expect((await refresh(ctx, phone.refreshToken)).status).toBe(401);
      expect(
        (await ctx.prisma.authSession.findUniqueOrThrow({ where: { id: phone.sessionId } }))
          .revokedReason,
      ).toBe('logout');
    });

    it('logout-all ends every session: the others get 401 on their very next request', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      const tablet = await mobile(ctx, who);
      const browser = ctx.browser();
      await browser.login(who.email, PASSWORD);
      expect((await phone.api.post('/auth/logout-all')).status).toBe(204);
      expect((await tablet.api.get('/sites')).status).toBe(401);
      expect((await browser.get('/sites')).status).toBe(401);
      expect((await phone.api.get('/sites')).status).toBe(401);
      expect((await refresh(ctx, tablet.refreshToken)).status).toBe(401);
      const event = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'auth.logout_all' },
      });
      expect(event.after).toEqual({ sessions: 3 });
    });

    it('lists one’s own sessions, never a token, and ends one of them by id', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      const tablet = await mobile(ctx, who);
      const list = await phone.api.get('/auth/sessions');
      expect(list.status).toBe(200);
      expect(list.body.items.map((item: Json) => item.id).sort()).toEqual(
        [phone.sessionId, tablet.sessionId].sort(),
      );
      expect(list.body.items.find((item: Json) => item.current).id).toBe(phone.sessionId);
      expect(list.text).not.toContain(phone.refreshToken);
      expect(list.text).not.toContain(tablet.accessToken);

      expect((await phone.api.delete(`/auth/sessions/${tablet.sessionId}`)).status).toBe(204);
      expect((await tablet.api.get('/auth/me')).status).toBe(401);
      expect((await phone.api.get('/auth/me')).status).toBe(200);
    });

    it('another user’s session id is 404, like one that does not exist, and stays alive', async () => {
      const me = await person(ctx, tenant);
      const someone = await person(ctx, tenant);
      const mine = await mobile(ctx, me);
      const theirs = await mobile(ctx, someone);
      const foreign = await mine.api.delete(`/auth/sessions/${theirs.sessionId}`);
      const missing = await mine.api.delete(`/auth/sessions/${randomUUID()}`);
      expect([foreign.status, missing.status]).toEqual([404, 404]);
      expect(foreign.body.code).toBe(missing.body.code);
      expect((await theirs.api.get('/auth/me')).status).toBe(200);
      // Even an admin of the organization cannot end it through this route.
      const admin = ctx.as(tenant.admin.id);
      expect((await admin.delete(`/auth/sessions/${theirs.sessionId}`)).status).toBe(404);
    });
  });

  describe('revocation by user management takes effect on the very next request', () => {
    it('archiving a user: their unexpired access token is refused at once', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      expect((await phone.api.get('/sites')).status).toBe(200);
      expect((await ctx.as(tenant.admin.id).post(`/users/${who.id}/archive`)).status).toBe(200);
      expect((await phone.api.get('/sites')).status).toBe(401);
      expect((await refresh(ctx, phone.refreshToken)).status).toBe(401);
      expect((await ctx.loginAs(who.email, PASSWORD)).status).toBe(401);
      const event = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'auth.session_revoked', entityId: who.id },
      });
      expect(event.after).toEqual({ reason: 'user_archived', sessions: 1 });
      // Restoring does not bring the old session back.
      expect((await ctx.as(tenant.admin.id).post(`/users/${who.id}/restore`)).status).toBe(200);
      expect((await phone.api.get('/sites')).status).toBe(401);
      expect((await ctx.loginAs(who.email, PASSWORD)).status).toBe(200);
    });

    it('archiving a membership: the holder is signed out at once', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      const browser = ctx.browser();
      await browser.login(who.email, PASSWORD);
      expect(
        (await ctx.as(tenant.admin.id).post(`/memberships/${who.membershipId}/archive`)).status,
      ).toBe(200);
      expect((await phone.api.get('/auth/me')).status).toBe(401);
      expect((await browser.get('/auth/me')).status).toBe(401);
      const event = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'auth.session_revoked', entityId: who.id },
      });
      expect(event.after).toEqual({ reason: 'membership_removed', sessions: 2 });
    });

    it.each([
      ['a lower role', { role: 'worker' }],
      ['a site taken away', { siteIds: [] }],
    ])('reducing a membership (%s) signs the holder out at once', async (_name, change) => {
      const who = await person(ctx, tenant, 'supervisor');
      const phone = await mobile(ctx, who);
      const response = await ctx
        .as(tenant.admin.id)
        .patch(`/memberships/${who.membershipId}`, change);
      expect(response.status).toBe(200);
      expect((await phone.api.get('/auth/me')).status).toBe(401);
    });

    it('widening a membership keeps the sessions', async () => {
      const who = await person(ctx, tenant);
      const other = await createSite(ctx.prisma, tenant.organization.id);
      const phone = await mobile(ctx, who);
      const response = await ctx.as(tenant.admin.id).patch(`/memberships/${who.membershipId}`, {
        siteIds: [who.siteId, other.id],
      });
      expect(response.status).toBe(200);
      expect((await phone.api.get('/auth/me')).status).toBe(200);
      // ...and the wider scope applies to the very next request.
      expect((await phone.api.get(`/sites/${other.id}`)).status).toBe(200);
    });
  });

  describe('expiry', () => {
    it('access tokens last their configured lifetime; the refresh token renews them', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      ctx.clock.advanceSeconds(ctx.authSettings.accessTokenTtlSeconds - 30);
      expect((await phone.api.get('/auth/me')).status).toBe(200);
      ctx.clock.advanceSeconds(31);
      expect((await phone.api.get('/auth/me')).status).toBe(401);
      expect((await refresh(ctx, phone.refreshToken)).status).toBe(200);
    });

    it('sliding: a session unused for longer than the refresh lifetime cannot be renewed', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      ctx.clock.advance(ctx.authSettings.refreshTokenTtlMs + 1000);
      expect((await refresh(ctx, phone.refreshToken)).status).toBe(401);
    });

    it('absolute: a session in use still ends at its absolute lifetime', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      const step = ctx.authSettings.refreshTokenTtlMs - DAY; // just inside the sliding window
      const absolute = ctx.authSettings.sessionAbsoluteTtlMs;
      let token = phone.refreshToken;
      let accessToken = phone.accessToken;
      let elapsed = 0;
      while (elapsed + step < absolute) {
        ctx.clock.advance(step);
        elapsed += step;
        const renewed = await refresh(ctx, token);
        expect([elapsed / DAY, renewed.status]).toEqual([elapsed / DAY, 200]);
        token = renewed.body.tokens.refreshToken;
        accessToken = renewed.body.tokens.accessToken;
        // No refresh token outlives the session.
        expect(new Date(renewed.body.tokens.refreshTokenExpiresAt).getTime()).toBeLessThanOrEqual(
          new Date(renewed.body.session.expiresAt).getTime(),
        );
      }
      expect((await ctx.bearer(accessToken).get('/auth/me')).status).toBe(200);
      ctx.clock.advance(absolute - elapsed + 1000);
      expect((await refresh(ctx, token)).status).toBe(401);
    });

    it('an access token is refused once its session passed the absolute expiry, even if fresh', async () => {
      const who = await person(ctx, tenant);
      const phone = await mobile(ctx, who);
      await ctx.prisma.authSession.update({
        where: { id: phone.sessionId },
        data: { expiresAt: new Date(ctx.clock.now().getTime() + 60_000) },
      });
      expect((await phone.api.get('/auth/me')).status).toBe(200);
      ctx.clock.advanceSeconds(61);
      expect((await phone.api.get('/auth/me')).status).toBe(401);
    });
  });

  describe('a session is used the way it was started', () => {
    it('a web session is refused as a bearer token; a mobile one is refused as a cookie', async () => {
      const who = await person(ctx, tenant);
      const browser = ctx.browser();
      await browser.login(who.email, PASSWORD);
      const webAccess = browser.cookies.get(AUTH_ACCESS_COOKIE)!;
      const webRefresh = browser.cookies.get(AUTH_REFRESH_COOKIE)!;
      expect((await browser.get('/auth/me')).status).toBe(200);
      expect((await ctx.bearer(webAccess).get('/auth/me')).status).toBe(401);
      expect((await refresh(ctx, webRefresh)).status).toBe(401);

      const phone = await mobile(ctx, who);
      const thief = ctx.browser();
      thief.setCookie(AUTH_ACCESS_COOKIE, phone.accessToken);
      thief.setCookie(AUTH_REFRESH_COOKIE, phone.refreshToken);
      expect((await thief.get('/auth/me')).status).toBe(401);
      expect((await thief.refresh()).status).toBe(401);
      // Both originals still work the right way.
      expect((await phone.api.get('/auth/me')).status).toBe(200);
      expect((await browser.get('/auth/me')).status).toBe(200);
    });

    it('a request with an unusable Authorization header never falls back to the cookie', async () => {
      const who = await person(ctx, tenant);
      const browser = ctx.browser();
      await browser.login(who.email, PASSWORD);
      const response = await browser.request('GET', '/auth/me', {
        headers: { Authorization: 'Bearer nonsense' },
      });
      expect(response.status).toBe(401);
    });
  });
});

describe('sessions with no reuse grace (AUTH_REFRESH_REUSE_GRACE_SECONDS=0)', () => {
  let ctx: TestApp;
  let tenant: Tenant;

  beforeAll(async () => {
    ctx = await startTestApp({ config: { AUTH_REFRESH_REUSE_GRACE_SECONDS: 0 } });
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
  });
  afterAll(() => ctx.close());

  it('any replay of a used refresh token revokes the session at once', async () => {
    const who = await person(ctx, tenant);
    const first = await mobile(ctx, who);
    const second = await refresh(ctx, first.refreshToken);
    expect(second.status).toBe(200);
    expect((await refresh(ctx, first.refreshToken)).status).toBe(401);
    expect((await refresh(ctx, second.body.tokens.refreshToken)).status).toBe(401);
    expect((await ctx.bearer(second.body.tokens.accessToken).get('/auth/me')).status).toBe(401);
    expect(
      await ctx.prisma.auditEvent.count({ where: { action: 'auth.refresh_reuse_detected' } }),
    ).toBe(1);
  });

  it('concurrent refreshes: one wins the rotation, and the loser counts as reuse', async () => {
    const who = await person(ctx, tenant);
    const first = await mobile(ctx, who);
    const results = await Promise.all([
      refresh(ctx, first.refreshToken),
      refresh(ctx, first.refreshToken),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(
      (await ctx.prisma.authSession.findUniqueOrThrow({ where: { id: first.sessionId } }))
        .revokedReason,
    ).toBe('refresh_reuse');
  });
});

describe('web sessions: cookies and CSRF', () => {
  let ctx: TestApp;
  let tenant: Tenant;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    await ctx.setPassword(tenant.admin.id, PASSWORD);
  });
  afterAll(() => ctx.close());

  const adminEmail = () => tenant.admin.email!;

  function cookieAttributes(response: ApiResponse, name: string): string[] {
    const header = response.setCookies.find((cookie) => cookie.startsWith(`${name}=`));
    expect(header).toBeDefined();
    return header!.split(';').map((part) => part.trim());
  }

  it('login sets two HttpOnly, SameSite=Lax cookies (not Secure in development), returns no token', async () => {
    const browser = ctx.browser();
    const login = await browser.login(adminEmail(), PASSWORD);
    expect(login.status).toBe(200);
    expect(login.body.tokens).toBeNull();
    expect(login.body.csrfToken).toEqual(expect.any(String));
    const access = cookieAttributes(login, AUTH_ACCESS_COOKIE);
    const refreshCookie = cookieAttributes(login, AUTH_REFRESH_COOKIE);
    for (const attributes of [access, refreshCookie]) {
      expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Lax']));
      expect(attributes).not.toContain('Secure');
    }
    expect(access).toContain('Path=/');
    expect(refreshCookie).toContain('Path=/auth');
    for (const value of browser.cookies.values()) {
      expect(login.text).not.toContain(value);
    }
    expect(login.headers.get('cache-control')).toBe('no-store');
  });

  it('a web sign-in needs an allowed Origin', async () => {
    const foreign = await ctx.loginAs(adminEmail(), PASSWORD, {
      client: 'web',
      origin: 'https://evil.example',
    });
    const none = await ctx.loginAs(adminEmail(), PASSWORD, { client: 'web', origin: null });
    expect([foreign.status, none.status]).toEqual([403, 403]);
    expect(foreign.setCookies).toEqual([]);
    expect(await ctx.prisma.authSession.count()).toBe(0);
  });

  it.each([
    ['without x-csrf-token', { csrf: false }],
    ['with a wrong x-csrf-token', { csrf: 'not-the-token' }],
    ['from a foreign Origin', { origin: 'https://evil.example' }],
    ['without an Origin', { origin: null }],
  ] as const)(
    'refuses a cookie-authenticated write %s (403) and changes nothing',
    async (_name, options) => {
      const browser = ctx.browser();
      await browser.login(adminEmail(), PASSWORD);
      const site = await createSite(ctx.prisma, tenant.organization.id, { name: 'Original' });
      const before = await ctx.prisma.auditEvent.count();
      const attacker = browser.with(options);
      const responses = await Promise.all([
        attacker.post('/sites', { name: 'Forged' }),
        attacker.patch(`/sites/${site.id}`, { name: 'Forged' }),
        attacker.post(`/sites/${site.id}/archive`),
        attacker.post('/auth/logout-all'),
        attacker.post('/auth/change-password', {
          currentPassword: PASSWORD,
          newPassword: 'x'.repeat(12),
        }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('forbidden');
      }
      expect(await ctx.prisma.site.findMany()).toEqual([
        expect.objectContaining({ name: 'Original', archivedAt: null }),
      ]);
      expect(await ctx.prisma.auditEvent.count()).toBe(before);
      expect((await browser.get('/auth/me')).status).toBe(200);
    },
  );

  it('a CSRF token of another session does not work', async () => {
    const mine = ctx.browser();
    const other = ctx.browser();
    await mine.login(adminEmail(), PASSWORD);
    await other.login(adminEmail(), PASSWORD);
    expect(mine.csrfToken).not.toBe(other.csrfToken);
    const response = await mine.with({ csrf: other.csrfToken! }).post('/sites', { name: 'X' });
    expect(response.status).toBe(403);
  });

  it('reads need no CSRF token (nor an Origin); writes with both are accepted', async () => {
    const browser = ctx.browser();
    await browser.login(adminEmail(), PASSWORD);
    expect((await browser.with({ csrf: false, origin: null }).get('/sites')).status).toBe(200);
    const created = await browser.post('/sites', { name: 'Legit' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Legit');
  });

  it('the CSRF token survives a refresh and comes back from /auth/me', async () => {
    const browser = ctx.browser();
    const login = await browser.login(adminEmail(), PASSWORD);
    const refreshed = await browser.refresh();
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.csrfToken).toBe(login.body.csrfToken);
    expect((await browser.get('/auth/me')).body.csrfToken).toBe(login.body.csrfToken);
    // A web refresh needs an allowed Origin.
    expect((await browser.with({ origin: 'https://evil.example' }).refresh()).status).toBe(403);
    expect((await browser.with({ origin: null }).refresh()).status).toBe(403);
  });

  it('bearer requests need neither an Origin nor a CSRF token', async () => {
    const login = await ctx.loginAs(adminEmail(), PASSWORD);
    const response = await ctx
      .bearer(login.body.tokens.accessToken)
      .post('/sites', { name: 'Phone' });
    expect(response.status).toBe(201);
  });

  it('logout clears both cookies, and the old cookie values are dead', async () => {
    const browser = ctx.browser();
    await browser.login(adminEmail(), PASSWORD);
    const access = browser.cookies.get(AUTH_ACCESS_COOKIE)!;
    const refreshValue = browser.cookies.get(AUTH_REFRESH_COOKIE)!;
    const out = await browser.post('/auth/logout');
    expect(out.status).toBe(204);
    expect(out.headers.get('cache-control')).toBe('no-store');
    for (const name of [AUTH_ACCESS_COOKIE, AUTH_REFRESH_COOKIE]) {
      expect(cookieAttributes(out, name)).toEqual(expect.arrayContaining(['Max-Age=0']));
    }
    expect(browser.cookies.size).toBe(0);
    const replay = ctx.browser();
    replay.setCookie(AUTH_ACCESS_COOKIE, access);
    replay.setCookie(AUTH_REFRESH_COOKIE, refreshValue);
    expect((await replay.get('/auth/me')).status).toBe(401);
    expect((await replay.refresh()).status).toBe(401);
  });

  // Decided (ADR-0004): sign-out is the one state-changing cookie route that relies on the Origin
  // check alone. It must work with an expired access token, its worst case under forgery is a
  // signed-out user, and a foreign Origin is refused (next test).
  it('logout through the cookies needs only an allowed Origin, not the CSRF token', async () => {
    const browser = ctx.browser();
    await browser.login(adminEmail(), PASSWORD);
    const out = await browser.with({ csrf: false }).post('/auth/logout');
    expect(out.status).toBe(204);
    expect((await browser.get('/auth/me')).status).toBe(401);
  });

  it('logout through the cookies from a foreign Origin is refused (403), the session lives', async () => {
    const browser = ctx.browser();
    await browser.login(adminEmail(), PASSWORD);
    expect(
      (await browser.with({ origin: 'https://evil.example' }).post('/auth/logout')).status,
    ).toBe(403);
    expect((await browser.get('/auth/me')).status).toBe(200);
  });

  it('answers every /auth route with Cache-Control: no-store, errors included', async () => {
    const browser = ctx.browser();
    const responses = [
      await ctx.loginAs('nobody@example.test', PASSWORD),
      await browser.login(adminEmail(), PASSWORD),
      await browser.get('/auth/me'),
      await browser.get('/auth/sessions'),
      await browser.refresh(),
      await ctx.as().get('/auth/me'),
      await ctx
        .as()
        .post('/auth/set-password', { code: 'AAAA-BBBB-CCCC-DDDD', password: PASSWORD }),
    ];
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('sends no CSRF header requirement to bearer sessions even with a stray header', async () => {
    const login = await ctx.loginAs(adminEmail(), PASSWORD);
    const response = await ctx.bearer(login.body.tokens.accessToken).request('POST', '/sites', {
      body: { name: 'Phone' },
      headers: { [CSRF_HEADER]: 'garbage', Origin: 'https://evil.example' },
    });
    expect(response.status).toBe(201);
  });
});

describe('web sessions in production', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await startTestApp({ config: { NODE_ENV: 'production' } });
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('marks both cookies Secure, and clears them with Secure too', async () => {
    const { admin } = await createTenant(ctx.prisma);
    await ctx.setPassword(admin.id, PASSWORD);
    const browser = ctx.browser({ origin: TEST_WEB_ORIGIN });
    const login = await browser.login(admin.email!, PASSWORD);
    expect(login.status).toBe(200);
    expect(login.setCookies).toHaveLength(2);
    for (const cookie of login.setCookies) {
      expect(cookie.split(';').map((part) => part.trim())).toEqual(
        expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Secure']),
      );
    }
    const out = await browser.post('/auth/logout');
    expect(out.setCookies).toHaveLength(2);
    for (const cookie of out.setCookies) {
      expect(cookie).toContain('Secure');
    }
  });
});
