import { createdUserSchema, loginResponseSchema } from '@ops/shared';
import { GENERIC_CODE_FAILURE, GENERIC_SIGN_IN_FAILURE } from '../src/platform/auth';
import {
  createMembership,
  createOrganization,
  createTenant,
  createUser,
  type Tenant,
} from './support/factories';
import { startTestApp, type ApiResponse, type Json, type TestApp } from './support/test-app';

// Sign-in, the one-time code flows (activation, reset) and password changes, over HTTP on the
// real database. Example passwords only; none of them is used anywhere real.

const PASSWORD = 'correct horse battery';
const OTHER_PASSWORD = 'staple orbit lantern';
const NEW_PASSWORD = 'violet harbour engine';
const MINUTE = 60_000;

/** The parts of an error answer that must not differ between two failures. */
function failureShape(response: ApiResponse) {
  const { correlationId: _c, timestamp: _t, ...rest } = response.body as Record<string, unknown>;
  return { status: response.status, body: rest, contentType: response.headers.get('content-type') };
}

describe('sign-in', () => {
  let ctx: TestApp;
  let tenant: Tenant;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma, 'Alpha');
  });
  afterAll(() => ctx.close());

  async function member(data: Record<string, unknown>) {
    const user = await createUser(ctx.prisma, tenant.organization.id, data);
    await createMembership(ctx.prisma, tenant.organization.id, user.id, 'worker');
    await ctx.setPassword(user.id, PASSWORD);
    return user;
  }

  describe('identifiers', () => {
    it('signs in with the email, the phone or the username of the same user', async () => {
      const user = await member({
        email: 'deniz@example.test',
        phone: '+905325550102',
        username: 'deniz.y',
        displayName: 'Deniz Y',
      });
      for (const identifier of ['deniz@example.test', '+905325550102', 'deniz.y']) {
        const response = await ctx.loginAs(identifier, PASSWORD);
        expect([identifier, response.status]).toEqual([identifier, 200]);
        expect(loginResponseSchema.safeParse(response.body).success).toBe(true);
        expect(response.body.user.id).toBe(user.id);
      }
      const kinds = (
        await ctx.prisma.auditEvent.findMany({
          where: { action: 'auth.login_succeeded' },
          orderBy: { occurredAt: 'asc' },
        })
      ).map((event) => (event.after as Json).kind);
      expect(kinds).toEqual(['email', 'phone', 'username']);
    });

    it.each([
      ['an upper-case email with spaces around it', '  DENIZ@Example.TEST '],
      ['a phone with spaces', '+90 532 555 01 02'],
      ['a phone with dashes', '+90-532-555-01-02'],
      ['a phone with parentheses after the +', '+90 (532) 555-01-02'],
      ['an upper-case username', ' Deniz.Y '],
    ])('normalises %s', async (_name, typed) => {
      await member({ email: 'deniz@example.test', phone: '+905325550102', username: 'deniz.y' });
      expect((await ctx.loginAs(typed, PASSWORD)).status).toBe(200);
    });

    /** A user whose phone an admin typed as "(+90) 532 555 01 03"; stored as +905325550103. */
    async function userWithParenthesisedPhone() {
      const created = await ctx.as(tenant.admin.id).post('/users', {
        displayName: 'Ece K',
        phone: '(+90) 532 555 01 03',
      });
      expect(created.status).toBe(201);
      expect(created.body.phone).toBe('+905325550103');
      await createMembership(ctx.prisma, tenant.organization.id, created.body.id, 'worker');
      await ctx.setPassword(created.body.id, PASSWORD);
    }

    it('finds a user whose phone was typed with a leading parenthesis, by the stored form', async () => {
      await userWithParenthesisedPhone();
      expect((await ctx.loginAs('+905325550103', PASSWORD)).status).toBe(200);
      expect((await ctx.loginAs('+90 532 555 01 03', PASSWORD)).status).toBe(200);
    });

    // BUG: the user management stores "(+90) 532 555 01 03" as "+905325550103" (shared
    // `normalizePhone` strips spaces, dashes and parentheses and keeps the +), but sign-in
    // normalises the same text to "905325550103" (`normalizePhone` in
    // apps/api/src/platform/auth/identifiers.ts keeps the + only when the input STARTS with it),
    // so typing the phone exactly as the admin did fails with the generic 401. Remove `.failing`
    // once the two normalisers agree.
    it('finds that user when the phone is typed exactly as the admin typed it', async () => {
      await userWithParenthesisedPhone();
      expect((await ctx.loginAs('(+90) 532 555 01 03', PASSWORD)).status).toBe(200);
    });

    it('refuses a sign-in without the slug once a second organization exists, even for a unique identifier', async () => {
      await member({ email: 'only-here@example.test' });
      expect((await ctx.loginAs('only-here@example.test', PASSWORD)).status).toBe(200);

      const other = await createOrganization(ctx.prisma, { name: 'Gamma', slug: 'gamma-works' });
      const withoutSlug = await ctx.loginAs('only-here@example.test', PASSWORD);
      const wrong = await ctx.loginAs('nobody-at-all@example.test', PASSWORD);
      expect(failureShape(withoutSlug)).toEqual(failureShape(wrong));
      expect(
        (
          await ctx.loginAs('only-here@example.test', PASSWORD, {
            organizationSlug: tenant.organization.slug,
          })
        ).status,
      ).toBe(200);

      // An archived organization does not count.
      await ctx.prisma.organization.update({
        where: { id: other.id },
        data: { archivedAt: new Date() },
      });
      expect((await ctx.loginAs('only-here@example.test', PASSWORD)).status).toBe(200);
    });

    it('treats an identifier found in two organizations as unknown without the slug', async () => {
      const other = await createOrganization(ctx.prisma, { name: 'Beta', slug: 'beta-works' });
      const mine = await member({ email: 'shared@example.test' });
      const theirs = await createUser(ctx.prisma, other.id, { email: 'shared@example.test' });
      await ctx.setPassword(theirs.id, OTHER_PASSWORD);

      const ambiguous = await ctx.loginAs('shared@example.test', PASSWORD);
      const wrong = await ctx.loginAs('nobody-at-all@example.test', PASSWORD);
      expect(failureShape(ambiguous)).toEqual(failureShape(wrong));
      expect(ambiguous.body.message).toBe(GENERIC_SIGN_IN_FAILURE);

      const alpha = await ctx.loginAs('shared@example.test', PASSWORD, {
        organizationSlug: tenant.organization.slug,
      });
      expect(alpha.status).toBe(200);
      expect(alpha.body.user.id).toBe(mine.id);
      const beta = await ctx.loginAs('shared@example.test', OTHER_PASSWORD, {
        organizationSlug: ' BETA-WORKS ',
      });
      expect(beta.status).toBe(200);
      expect(beta.body.user.id).toBe(theirs.id);
      // The right slug with the other organization's password: a plain failure.
      const crossed = await ctx.loginAs('shared@example.test', OTHER_PASSWORD, {
        organizationSlug: tenant.organization.slug,
      });
      expect(failureShape(crossed)).toEqual(failureShape(wrong));
      const unknownSlug = await ctx.loginAs('shared@example.test', PASSWORD, {
        organizationSlug: 'no-such-org',
      });
      expect(failureShape(unknownSlug)).toEqual(failureShape(wrong));
    });
  });

  describe('every failure looks the same', () => {
    it('wrong password, unknown user, not activated, archived and locked: same status and body', async () => {
      const ok = await member({ email: 'ok@example.test' });
      await createUser(ctx.prisma, tenant.organization.id, { email: 'new@example.test' });
      const archived = await member({ email: 'gone@example.test' });
      await ctx.prisma.user.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });
      const locked = await member({ email: 'locked@example.test' });
      await ctx.prisma.authCredential.update({
        where: { userId: locked.id },
        data: { lockedUntil: new Date(Date.now() + 10 * MINUTE) },
      });

      const cases = {
        wrongPassword: await ctx.loginAs('ok@example.test', 'not the password at all'),
        unknownUser: await ctx.loginAs('nobody@example.test', PASSWORD),
        notActivated: await ctx.loginAs('new@example.test', PASSWORD),
        archived: await ctx.loginAs('gone@example.test', PASSWORD),
        lockedRightPassword: await ctx.loginAs('locked@example.test', PASSWORD),
        unknownUsername: await ctx.loginAs('nobody.here', PASSWORD),
        unknownPhone: await ctx.loginAs('+10000000000', PASSWORD),
      };
      const reference = failureShape(cases.wrongPassword);
      expect(reference).toEqual({
        status: 401,
        body: { statusCode: 401, code: 'unauthenticated', message: GENERIC_SIGN_IN_FAILURE },
        contentType: expect.stringContaining('application/json'),
      });
      for (const [name, response] of Object.entries(cases)) {
        expect([name, failureShape(response)]).toEqual([name, reference]);
        expect(response.setCookies).toEqual([]);
      }
      // And the user who is fine still gets in.
      expect((await ctx.loginAs('ok@example.test', PASSWORD)).body.user.id).toBe(ok.id);
    });

    it('records each failure for its organization, and an unknown identifier for nobody', async () => {
      const user = await member({ email: 'ok@example.test' });
      await ctx.loginAs('ok@example.test', 'not the password at all');
      await ctx.loginAs('who@example.test', PASSWORD);
      const events = await ctx.prisma.auditEvent.findMany({
        where: { action: 'auth.login_failed' },
        orderBy: { occurredAt: 'asc' },
      });
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        organizationId: tenant.organization.id,
        entityType: 'auth',
        entityId: user.id,
        after: { reason: 'bad_password', kind: 'email' },
      });
      expect(events[1]).toMatchObject({ organizationId: null, entityId: 'unknown' });
      expect(Object.keys(events[1]!.after as object).sort()).toEqual([
        'identifierFingerprint',
        'kind',
        'reason',
      ]);
      expect(JSON.stringify(events)).not.toContain('who@example.test');
    });
  });

  describe('lockout', () => {
    const max = () => ctx.authSettings.maxFailedLogins;
    const lockMs = () => ctx.authSettings.lockoutMs;

    it('locks after the configured number of failures, then unlocks when the time is up', async () => {
      const user = await member({ email: 'ok@example.test' });
      for (let attempt = 1; attempt < max(); attempt += 1) {
        expect((await ctx.loginAs('ok@example.test', 'wrong password!!')).status).toBe(401);
      }
      // One short of the limit: not locked.
      expect(
        await ctx.prisma.authCredential.findUniqueOrThrow({ where: { userId: user.id } }),
      ).toMatchObject({ failedAttempts: max() - 1, lockedUntil: null });
      expect((await ctx.loginAs('ok@example.test', 'wrong password!!')).status).toBe(401);
      // That was failure number max: locked, the right password is refused.
      expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(401);
      const locks = await ctx.prisma.auditEvent.findMany({ where: { action: 'auth.locked_out' } });
      expect(locks).toHaveLength(1);
      expect(locks[0]).toMatchObject({ entityId: user.id, after: { failedAttempts: max() } });

      ctx.clock.advance(lockMs() - 1000);
      expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(401);
      ctx.clock.advance(2000);
      expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(200);
    });

    it('a burst of concurrent wrong passwords cannot undo the lock', async () => {
      const user = await member({ email: 'burst@example.test' });
      for (let round = 0; round < 3; round += 1) {
        // More attempts than the limit, all in flight at once: requests that checked the lock
        // before it was set must not clear it when they record their failure.
        const burst = await Promise.all(
          Array.from({ length: max() + 4 }, () =>
            ctx.loginAs('burst@example.test', 'wrong password!!'),
          ),
        );
        expect(burst.every((response) => response.status === 401)).toBe(true);
        const credential = await ctx.prisma.authCredential.findUniqueOrThrow({
          where: { userId: user.id },
        });
        expect(credential.lockedUntil).not.toBeNull();
        expect(credential.lockedUntil!.getTime()).toBeGreaterThan(ctx.clock.now().getTime());
        await ctx.rateLimiter.reset();
        expect((await ctx.loginAs('burst@example.test', PASSWORD)).status).toBe(401);
        ctx.clock.advance(lockMs() + 1000);
        await ctx.rateLimiter.reset();
      }
    });

    it('a success resets the count of failures', async () => {
      await member({ email: 'ok@example.test' });
      for (let round = 0; round < 3; round += 1) {
        for (let attempt = 1; attempt < max(); attempt += 1) {
          expect((await ctx.loginAs('ok@example.test', 'wrong password!!')).status).toBe(401);
        }
        expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(200);
        // Keep under the per-identifier rate limit, which is not what this test is about.
        await ctx.rateLimiter.reset();
      }
    });

    it('attempts during the lock neither count nor extend it', async () => {
      const user = await member({ email: 'ok@example.test' });
      for (let attempt = 0; attempt < max(); attempt += 1) {
        await ctx.loginAs('ok@example.test', 'wrong password!!');
      }
      const lockedUntil = (
        await ctx.prisma.authCredential.findUniqueOrThrow({ where: { userId: user.id } })
      ).lockedUntil!;
      ctx.clock.advance(lockMs() / 2);
      for (const password of ['wrong password!!', PASSWORD, 'wrong password!!']) {
        expect((await ctx.loginAs('ok@example.test', password)).status).toBe(401);
      }
      const after = await ctx.prisma.authCredential.findUniqueOrThrow({
        where: { userId: user.id },
      });
      expect(after.lockedUntil).toEqual(lockedUntil);
      expect(after.failedAttempts).toBe(0);
      expect(await ctx.prisma.auditEvent.count({ where: { action: 'auth.locked_out' } })).toBe(1);
      const reasons = (
        await ctx.prisma.auditEvent.findMany({
          where: { action: 'auth.login_failed' },
          orderBy: { occurredAt: 'asc' },
        })
      ).map((event) => (event.after as Json).reason);
      expect(reasons.slice(-3)).toEqual(['locked', 'locked', 'locked']);

      ctx.clock.freeze(new Date(lockedUntil.getTime() + 1000));
      expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(200);
    });
  });

  describe('activation', () => {
    async function createThroughApi(body: Record<string, unknown>) {
      const response = await ctx.as(tenant.admin.id).post('/users', body);
      expect(response.status).toBe(201);
      expect(createdUserSchema.safeParse(response.body).success).toBe(true);
      await createMembership(ctx.prisma, tenant.organization.id, response.body.id, 'worker');
      return response.body as Json;
    }

    it('admin creates a user -> code (shown in development) -> set password -> sign in', async () => {
      const user = await createThroughApi({ displayName: 'Ece K', username: 'ece.k' });
      expect(user.activated).toBe(false);
      expect(user.activation.purpose).toBe('activation');
      expect(user.activation.code).toBe(ctx.notifications.lastCode(user.id));
      expect(user.activation.link).toContain('/activate?code=');
      expect(new Date(user.activation.expiresAt).getTime() - Date.now()).toBeGreaterThan(
        71 * 60 * MINUTE,
      );
      expect((await ctx.loginAs('ece.k', PASSWORD)).status).toBe(401);

      const set = await ctx
        .as()
        .post('/auth/set-password', { code: user.activation.code, password: PASSWORD });
      expect(set.status).toBe(204);
      const login = await ctx.loginAs('ece.k', PASSWORD);
      expect(login.status).toBe(200);
      expect((await ctx.as(tenant.admin.id).get(`/users/${user.id}`)).body.activated).toBe(true);
      expect(
        await ctx.prisma.auditEvent.count({
          where: { action: 'auth.activated', entityId: user.id },
        }),
      ).toBe(1);
    });

    it('works once, in any letter case and with or without the dashes', async () => {
      const user = await createThroughApi({ displayName: 'Ece K', username: 'ece.k' });
      const code: string = user.activation.code;
      const typed = ` ${code.toLowerCase().replaceAll('-', ' ')} `;
      expect(
        (await ctx.as().post('/auth/set-password', { code: typed, password: PASSWORD })).status,
      ).toBe(204);
      const again = await ctx.as().post('/auth/set-password', { code, password: OTHER_PASSWORD });
      expect(again.status).toBe(422);
      expect(again.body.message).toBe(GENERIC_CODE_FAILURE);
      expect((await ctx.loginAs('ece.k', OTHER_PASSWORD)).status).toBe(401);
    });

    it('expires: refused one second after the configured lifetime', async () => {
      const user = await createThroughApi({ displayName: 'Ece K', username: 'ece.k' });
      const lifetime = ctx.authSettings.activationCodeTtlMs;
      ctx.clock.advance(lifetime + 1000);
      const response = await ctx
        .as()
        .post('/auth/set-password', { code: user.activation.code, password: PASSWORD });
      expect(response.status).toBe(422);
      expect(response.body.message).toBe(GENERIC_CODE_FAILURE);
    });

    it('a new code cancels the previous one', async () => {
      const user = await createThroughApi({ displayName: 'Ece K', username: 'ece.k' });
      const first: string = user.activation.code;
      const reissued = await ctx.as(tenant.admin.id).post(`/users/${user.id}/activation-code`);
      expect(reissued.status).toBe(200);
      expect(reissued.body.code).not.toBe(first);
      expect(
        (await ctx.as().post('/auth/set-password', { code: first, password: PASSWORD })).status,
      ).toBe(422);
      expect(
        (
          await ctx
            .as()
            .post('/auth/set-password', { code: reissued.body.code, password: PASSWORD })
        ).status,
      ).toBe(204);
      // Once activated, another activation code is refused; a reset is the way.
      expect((await ctx.as(tenant.admin.id).post(`/users/${user.id}/activation-code`)).status).toBe(
        409,
      );
    });

    it.each([
      ['too short', 'short1', 'password'],
      ['containing the username', 'my ece.k forever', 'password'],
      ['containing the display name', 'hello Ecekaya there', 'password'],
      ['well known', 'password123', 'password'],
      ['one character repeated', 'aaaaaaaaaaaa', 'password'],
    ])('refuses a password %s (400) and leaves the code usable', async (_name, password, path) => {
      const user = await createThroughApi({ displayName: 'Ece Kaya', username: 'ece.k' });
      const refused = await ctx
        .as()
        .post('/auth/set-password', { code: user.activation.code, password });
      expect(refused.status).toBe(400);
      expect(refused.body.details[0].path).toBe(path);
      expect(refused.text).not.toContain(password);
      expect(
        (
          await ctx
            .as()
            .post('/auth/set-password', { code: user.activation.code, password: PASSWORD })
        ).status,
      ).toBe(204);
    });

    it('is refused for a user archived after the code was issued', async () => {
      const user = await createThroughApi({ displayName: 'Ece K', username: 'ece.k' });
      await ctx.prisma.user.update({ where: { id: user.id }, data: { archivedAt: new Date() } });
      const response = await ctx
        .as()
        .post('/auth/set-password', { code: user.activation.code, password: PASSWORD });
      expect(response.status).toBe(422);
      expect(response.body.message).toBe(GENERIC_CODE_FAILURE);
    });
  });

  describe('password reset and change', () => {
    it('a reset code sets a new password and ends every existing session', async () => {
      const user = await member({ email: 'ok@example.test' });
      const phone = await ctx.loginAs('ok@example.test', PASSWORD);
      const browser = ctx.browser();
      expect((await browser.login('ok@example.test', PASSWORD)).status).toBe(200);
      const bearer = ctx.bearer(phone.body.tokens.accessToken);
      expect((await bearer.get('/auth/me')).status).toBe(200);

      const issued = await ctx.as(tenant.admin.id).post(`/users/${user.id}/password-reset`);
      expect(issued.status).toBe(200);
      expect(issued.body.purpose).toBe('password_reset');
      // Issuing alone ends nothing.
      expect((await bearer.get('/auth/me')).status).toBe(200);

      const set = await ctx
        .as()
        .post('/auth/set-password', { code: issued.body.code, password: NEW_PASSWORD });
      expect(set.status).toBe(204);
      expect((await bearer.get('/auth/me')).status).toBe(401);
      expect((await browser.get('/auth/me')).status).toBe(401);
      expect(
        (await ctx.as().post('/auth/refresh', { refreshToken: phone.body.tokens.refreshToken }))
          .status,
      ).toBe(401);
      expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(401);
      expect((await ctx.loginAs('ok@example.test', NEW_PASSWORD)).status).toBe(200);
      const reset = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'auth.password_reset' },
      });
      expect(reset.after).toEqual({ purpose: 'password_reset', sessionsEnded: 2 });
    });

    it('a reset code expires after its (shorter) lifetime', async () => {
      const user = await member({ email: 'ok@example.test' });
      const issued = await ctx.as(tenant.admin.id).post(`/users/${user.id}/password-reset`);
      ctx.clock.advance(ctx.authSettings.resetCodeTtlMs + 1000);
      expect(
        (
          await ctx
            .as()
            .post('/auth/set-password', { code: issued.body.code, password: NEW_PASSWORD })
        ).status,
      ).toBe(422);
    });

    it('a reset of a user who never activated is refused (409)', async () => {
      const user = await createUser(ctx.prisma, tenant.organization.id);
      expect((await ctx.as(tenant.admin.id).post(`/users/${user.id}/password-reset`)).status).toBe(
        409,
      );
    });

    it('change-password needs the current password and ends the other sessions only', async () => {
      await member({ email: 'ok@example.test' });
      const first = await ctx.loginAs('ok@example.test', PASSWORD);
      const second = await ctx.loginAs('ok@example.test', PASSWORD);
      const current = ctx.bearer(first.body.tokens.accessToken);
      const other = ctx.bearer(second.body.tokens.accessToken);

      const wrong = await current.post('/auth/change-password', {
        currentPassword: 'not my password',
        newPassword: NEW_PASSWORD,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.details).toEqual([{ path: 'currentPassword', message: 'is not correct' }]);
      expect((await other.get('/auth/me')).status).toBe(200);

      const same = await current.post('/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: PASSWORD,
      });
      expect(same.status).toBe(400);

      const changed = await current.post('/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(changed.status).toBe(204);
      expect((await current.get('/auth/me')).status).toBe(200);
      expect((await other.get('/auth/me')).status).toBe(401);
      expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(401);
      expect((await ctx.loginAs('ok@example.test', NEW_PASSWORD)).status).toBe(200);
      expect(
        (
          await ctx.prisma.auditEvent.findFirstOrThrow({
            where: { action: 'auth.password_changed' },
          })
        ).after,
      ).toEqual({ sessionsEnded: 1 });
    });

    it('change-password needs a session (401 without one)', async () => {
      const response = await ctx.as().post('/auth/change-password', {
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });
      expect(response.status).toBe(401);
    });
  });
});

describe('sign-in in production', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await startTestApp({ config: { NODE_ENV: 'production' } });
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('never shows a one-time code or link in an answer; the sender still gets it', async () => {
    const { organization, admin } = await createTenant(ctx.prisma);
    const created = await ctx
      .as(admin.id)
      .post('/users', { displayName: 'Ece K', username: 'ece.k' });
    expect(created.status).toBe(201);
    expect(created.body.activation).toMatchObject({
      purpose: 'activation',
      code: null,
      link: null,
    });
    const code = ctx.notifications.lastCode(created.body.id);
    expect(created.text).not.toContain(code);

    const reissued = await ctx.as(admin.id).post(`/users/${created.body.id}/activation-code`);
    expect(reissued.body).toMatchObject({ code: null, link: null });

    await createMembership(ctx.prisma, organization.id, created.body.id, 'worker');
    const set = await ctx.as().post('/auth/set-password', {
      code: ctx.notifications.lastCode(created.body.id),
      password: PASSWORD,
    });
    expect(set.status).toBe(204);
    const reset = await ctx.as(admin.id).post(`/users/${created.body.id}/password-reset`);
    expect(reset.body).toMatchObject({ purpose: 'password_reset', code: null, link: null });
  });
});

describe('rate limits', () => {
  let ctx: TestApp;
  let tenant: Tenant;

  beforeAll(async () => {
    ctx = await startTestApp({
      config: {
        AUTH_RATE_LIMITS: {
          loginPerIp: { limit: 5, windowSeconds: 60 },
          loginPerIdentifier: { limit: 2, windowSeconds: 300 },
          refreshPerIp: { limit: 5, windowSeconds: 60 },
          refreshPerToken: { limit: 2, windowSeconds: 60 },
          setPasswordPerIp: { limit: 5, windowSeconds: 60 },
          setPasswordPerCode: { limit: 2, windowSeconds: 600 },
        },
      },
    });
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
  });
  afterAll(() => ctx.close());

  function expectLimited(response: ApiResponse) {
    expect(response.status).toBe(429);
    expect(response.body).toMatchObject({ statusCode: 429, code: 'rate_limited' });
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
  }

  it('login: per identifier, also for the right password, until the window has passed', async () => {
    const user = await createUser(ctx.prisma, tenant.organization.id, { email: 'ok@example.test' });
    await createMembership(ctx.prisma, tenant.organization.id, user.id, 'worker');
    await ctx.setPassword(user.id, PASSWORD);
    expect((await ctx.loginAs('ok@example.test', 'wrong password!!')).status).toBe(401);
    expect((await ctx.loginAs('OK@example.test', 'wrong password!!')).status).toBe(401);
    expectLimited(await ctx.loginAs('ok@example.test', PASSWORD));
    // Another identifier from the same address is still answered.
    expect((await ctx.loginAs('other@example.test', PASSWORD)).status).toBe(401);
    ctx.clock.advanceSeconds(301);
    expect((await ctx.loginAs('ok@example.test', PASSWORD)).status).toBe(200);
  });

  it('login: per address, whatever the identifier', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await ctx.loginAs(`user${index}@example.test`, PASSWORD)).status).toBe(401);
    }
    const limited = await ctx.loginAs('fresh@example.test', PASSWORD);
    expectLimited(limited);
    expect(Number(limited.headers.get('retry-after'))).toBeLessThanOrEqual(60);
  });

  it('refresh: per token and per address', async () => {
    expect((await ctx.as().post('/auth/refresh', { refreshToken: 'same-token' })).status).toBe(401);
    expect((await ctx.as().post('/auth/refresh', { refreshToken: 'same-token' })).status).toBe(401);
    expectLimited(await ctx.as().post('/auth/refresh', { refreshToken: 'same-token' }));
    await ctx.rateLimiter.reset();
    for (let index = 0; index < 5; index += 1) {
      expect(
        (await ctx.as().post('/auth/refresh', { refreshToken: `token-${index}` })).status,
      ).toBe(401);
    }
    expectLimited(await ctx.as().post('/auth/refresh', { refreshToken: 'token-new' }));
  });

  it('set-password: per code (in any spelling) and per address', async () => {
    const created = await ctx.as(tenant.admin.id).post('/users', {
      displayName: 'Ece K',
      username: 'ece.k',
    });
    const code: string = created.body.activation.code;
    // Two refused passwords use up the attempts of this code...
    expect(
      (await ctx.as().post('/auth/set-password', { code, password: 'password123' })).status,
    ).toBe(400);
    expect(
      (
        await ctx
          .as()
          .post('/auth/set-password', { code: code.toLowerCase(), password: 'password123' })
      ).status,
    ).toBe(400);
    expectLimited(await ctx.as().post('/auth/set-password', { code, password: PASSWORD }));
    await ctx.rateLimiter.reset();
    for (let index = 0; index < 5; index += 1) {
      expect(
        (await ctx.as().post('/auth/set-password', { code: `NOPE-${index}`, password: PASSWORD }))
          .status,
      ).toBe(422);
    }
    expectLimited(await ctx.as().post('/auth/set-password', { code, password: PASSWORD }));
  });
});
