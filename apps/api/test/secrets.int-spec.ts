import { createHash } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { AUTH_ACCESS_COOKIE, AUTH_REFRESH_COOKIE } from '@ops/shared';
import {
  LoggingNotificationSender,
  NOTIFICATION_SENDER,
  type NotificationSender,
  type OneTimeCodeNotification,
} from '../src/platform/notifications/notification-sender';
import { createMembership, createTenant, type Tenant } from './support/factories';
import { startTestApp, type Json, type TestApp } from './support/test-app';

// No password, one-time code, token, cookie value, CSRF token or password hash may appear in a
// log line, an audit row or an outbox row. A full sign-in life cycle is run, every secret it
// produces is collected, and the actual values are searched for. Example passwords only.

const ADMIN_PASSWORD = 'boss example passphrase';
const FIRST_PASSWORD = 'first example passphrase';
const SECOND_PASSWORD = 'second example passphrase';
const THIRD_PASSWORD = 'third example passphrase';
const WRONG_PASSWORD = 'wrong example passphrase';

interface LogLine {
  level: string;
  context: string;
  text: string;
}

/** Captures everything the application logs, with the context (the logger's name). */
class CapturingLogger implements LoggerService {
  readonly lines: LogLine[] = [];
  private push(level: string, message: unknown, rest: unknown[]) {
    const context = typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : '';
    this.lines.push({
      level,
      context,
      text: [message, ...rest]
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
        .join(' '),
    });
  }
  log(message: unknown, ...rest: unknown[]) {
    this.push('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.push('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.push('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.push('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.push('verbose', message, rest);
  }
}

/** The real development sender (it logs), plus a record of the codes for the test to use. */
class RecordingRealSender implements NotificationSender {
  readonly sent: OneTimeCodeNotification[] = [];
  private readonly real: LoggingNotificationSender;
  constructor(nodeEnv: string) {
    this.real = new LoggingNotificationSender(nodeEnv);
  }
  sendOneTimeCode(notification: OneTimeCodeNotification): Promise<void> {
    this.sent.push(notification);
    return this.real.sendOneTimeCode(notification);
  }
  lastCode(): string {
    return this.sent.at(-1)!.code;
  }
}

/** The fields each security audit event may carry (in `after`), and nothing else. */
const DOCUMENTED_FIELDS: Record<string, string[][]> = {
  'auth.login_succeeded': [['client', 'kind', 'userId']],
  'auth.login_failed': [
    ['kind', 'reason'],
    ['identifierFingerprint', 'kind', 'reason'],
  ],
  'auth.locked_out': [['failedAttempts', 'lockedUntil']],
  'auth.logout': [['client', 'userId']],
  'auth.logout_all': [['sessions']],
  'auth.session_revoked': [
    ['client', 'reason', 'userId'],
    ['reason', 'sessions'],
  ],
  'auth.refresh_reuse_detected': [['client', 'userId']],
  'auth.code_issued': [['expiresAt', 'issueId', 'purpose']],
  'auth.activated': [['purpose', 'sessionsEnded']],
  'auth.password_reset': [['purpose', 'sessionsEnded']],
  'auth.password_changed': [['sessionsEnded']],
};

async function startCapturing(nodeEnv: string) {
  const logger = new CapturingLogger();
  const sender = new RecordingRealSender(nodeEnv);
  const ctx = await startTestApp({
    logger,
    config: { NODE_ENV: nodeEnv },
    configure: (builder) => builder.overrideProvider(NOTIFICATION_SENDER).useValue(sender),
  });
  return { ctx, logger, sender };
}

describe('no secrets in logs, audit or outbox: a full life cycle in development', () => {
  let ctx: TestApp;
  let logger: CapturingLogger;
  let sender: RecordingRealSender;
  let tenant: Tenant;
  const secrets = new Map<string, string>();
  const codes: string[] = [];
  let userId = '';
  let email = '';

  const keep = (label: string, value: unknown) => {
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeGreaterThan(5);
    secrets.set(label, value as string);
  };
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

  beforeAll(async () => {
    ({ ctx, logger, sender } = await startCapturing('development'));
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    await ctx.setPassword(tenant.admin.id, ADMIN_PASSWORD);
    for (const [label, password] of Object.entries({
      ADMIN_PASSWORD,
      FIRST_PASSWORD,
      SECOND_PASSWORD,
      THIRD_PASSWORD,
      WRONG_PASSWORD,
    })) {
      keep(label, password);
    }
    keep(
      'admin password hash',
      (await ctx.prisma.authCredential.findUniqueOrThrow({ where: { userId: tenant.admin.id } }))
        .passwordHash,
    );

    // The admin signs in on the web and creates a user: the activation code.
    const admin = ctx.browser();
    const adminLogin = await admin.login(tenant.admin.email!, ADMIN_PASSWORD);
    expect(adminLogin.status).toBe(200);
    keep('admin csrf token', adminLogin.body.csrfToken);
    keep('admin access cookie', admin.cookies.get(AUTH_ACCESS_COOKIE));
    keep('admin refresh cookie', admin.cookies.get(AUTH_REFRESH_COOKIE));
    const created = await admin.post('/users', {
      displayName: 'Ece K',
      email: 'ece.k@example.test',
    });
    expect(created.status).toBe(201);
    userId = created.body.id;
    email = created.body.email;
    await createMembership(ctx.prisma, tenant.organization.id, userId, 'worker');
    codes.push(created.body.activation.code);
    expect(sender.lastCode()).toBe(created.body.activation.code);

    // Activation.
    expect(
      (await ctx.as().post('/auth/set-password', { code: codes[0], password: FIRST_PASSWORD }))
        .status,
    ).toBe(204);
    keep(
      'first password hash',
      (await ctx.prisma.authCredential.findUniqueOrThrow({ where: { userId } })).passwordHash,
    );

    // Mobile and web sign-ins, and a refresh of each.
    const phone = await ctx.loginAs(email, FIRST_PASSWORD);
    keep('mobile access token 1', phone.body.tokens.accessToken);
    keep('mobile refresh token 1', phone.body.tokens.refreshToken);
    const web = ctx.browser();
    const webLogin = await web.login(email, FIRST_PASSWORD);
    keep('web csrf token', webLogin.body.csrfToken);
    keep('web access cookie 1', web.cookies.get(AUTH_ACCESS_COOKIE));
    keep('web refresh cookie 1', web.cookies.get(AUTH_REFRESH_COOKIE));
    const renewed = await ctx
      .as()
      .post('/auth/refresh', { refreshToken: phone.body.tokens.refreshToken });
    expect(renewed.status).toBe(200);
    keep('mobile access token 2', renewed.body.tokens.accessToken);
    keep('mobile refresh token 2', renewed.body.tokens.refreshToken);
    expect((await web.refresh()).status).toBe(200);
    keep('web access cookie 2', web.cookies.get(AUTH_ACCESS_COOKIE));
    keep('web refresh cookie 2', web.cookies.get(AUTH_REFRESH_COOKIE));

    // Reuse of the first refresh token after the grace: the session is revoked.
    ctx.clock.advanceSeconds(ctx.authSettings.refreshReuseGraceMs / 1000 + 1);
    expect(
      (await ctx.as().post('/auth/refresh', { refreshToken: phone.body.tokens.refreshToken }))
        .status,
    ).toBe(401);

    // Change of password on a new mobile session.
    const again = await ctx.loginAs(email, FIRST_PASSWORD);
    keep('mobile access token 3', again.body.tokens.accessToken);
    keep('mobile refresh token 3', again.body.tokens.refreshToken);
    expect(
      (
        await ctx.bearer(again.body.tokens.accessToken).post('/auth/change-password', {
          currentPassword: FIRST_PASSWORD,
          newPassword: SECOND_PASSWORD,
        })
      ).status,
    ).toBe(204);
    keep(
      'second password hash',
      (await ctx.prisma.authCredential.findUniqueOrThrow({ where: { userId } })).passwordHash,
    );

    // A reset by the admin.
    const reset = await admin.post(`/users/${userId}/password-reset`);
    expect(reset.status).toBe(200);
    codes.push(reset.body.code);
    expect(
      (
        await ctx
          .as()
          .post('/auth/set-password', { code: reset.body.code, password: THIRD_PASSWORD })
      ).status,
    ).toBe(204);
    keep(
      'third password hash',
      (await ctx.prisma.authCredential.findUniqueOrThrow({ where: { userId } })).passwordHash,
    );

    // Lockout.
    for (let attempt = 0; attempt < ctx.authSettings.maxFailedLogins; attempt += 1) {
      expect((await ctx.loginAs(email, WRONG_PASSWORD)).status).toBe(401);
    }
    expect((await ctx.loginAs(email, THIRD_PASSWORD)).status).toBe(401);
    expect(await ctx.prisma.auditEvent.count({ where: { action: 'auth.locked_out' } })).toBe(1);

    codes.forEach((code, index) => {
      keep(`one-time code ${index + 1}`, code);
      keep(`one-time code ${index + 1} without dashes`, code.replaceAll('-', ''));
    });
    // The stored hashes of tokens and codes must not travel either.
    for (const row of await ctx.prisma.authRefreshToken.findMany()) {
      keep(`refresh token hash ${row.id}`, row.tokenHash);
    }
    for (const row of await ctx.prisma.authOneTimeCode.findMany()) {
      keep(`code hash ${row.id}`, row.codeHash);
    }
    for (const [label, value] of [...secrets]) {
      if (label.includes('token') && !label.includes('hash')) {
        keep(`${label} (sha256)`, sha256(value));
      }
    }
  });
  afterAll(() => ctx.close());

  /** Every place a value could leak to, as one text each. */
  async function stores() {
    const text = (rows: unknown) =>
      JSON.stringify(rows, (_key, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
    return {
      audit: text(await ctx.prisma.auditEvent.findMany()),
      outbox: text(await ctx.prisma.outboxEvent.findMany()),
      sessions: text(await ctx.prisma.authSession.findMany()),
    };
  }

  it('ran the whole life cycle and collected the secrets it produced', () => {
    expect(codes).toHaveLength(2);
    expect(secrets.size).toBeGreaterThan(30);
    const contexts = new Set(logger.lines.map((line) => line.context));
    expect(contexts.has('Http')).toBe(true);
    expect(contexts.has('Notifications')).toBe(true);
  });

  it('writes none of them into an audit row, an outbox row or a session row', async () => {
    const found: string[] = [];
    for (const [where, text] of Object.entries(await stores())) {
      for (const [label, value] of secrets) {
        if (text.includes(value)) {
          found.push(`${label} in ${where}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('logs none of them, except the development sender logging the code itself', () => {
    const found: string[] = [];
    for (const line of logger.lines) {
      for (const [label, value] of secrets) {
        const isCode = label.startsWith('one-time code');
        if (line.text.includes(value) && !(isCode && line.context === 'Notifications')) {
          found.push(`${label} in a ${line.context} ${line.level} line`);
        }
      }
    }
    expect(found).toEqual([]);
    // Nor the sign-in identifier: the request log has methods, paths and ids only.
    expect(logger.lines.filter((line) => line.text.includes(email))).toEqual([]);
  });

  it('the development sender is the one place a code is logged, once per code', () => {
    for (const code of codes) {
      const lines = logger.lines.filter((line) => line.text.includes(code));
      expect(lines.map((line) => line.context)).toEqual(['Notifications']);
      expect(lines[0]!.text).toContain('[development only]');
    }
  });

  it('gives every auth.* audit event only its documented fields', async () => {
    const events = await ctx.prisma.auditEvent.findMany({ where: { entityType: 'auth' } });
    const actions = new Set(events.map((event) => event.action));
    for (const expected of [
      'auth.code_issued',
      'auth.activated',
      'auth.login_succeeded',
      'auth.login_failed',
      'auth.locked_out',
      'auth.refresh_reuse_detected',
      'auth.password_changed',
      'auth.password_reset',
    ]) {
      expect(actions.has(expected)).toBe(true);
    }
    for (const event of events) {
      expect(event.action.startsWith('auth.')).toBe(true);
      const allowed = DOCUMENTED_FIELDS[event.action];
      expect([event.action, allowed !== undefined]).toEqual([event.action, true]);
      const keys = Object.keys((event.after ?? {}) as Json).sort();
      expect([event.action, allowed!.some((set) => set.join() === keys.join())]).toEqual([
        event.action,
        true,
      ]);
      expect(event.before).toBeNull();
      expect(event.changes).toBeNull();
    }
  });

  it('keeps security events out of the outbox', async () => {
    expect(
      await ctx.prisma.outboxEvent.count({
        where: { OR: [{ eventType: { startsWith: 'auth.' } }, { aggregateType: 'auth' }] },
      }),
    ).toBe(0);
    // The outbox has the business events of the flow, so the check above is not vacuous.
    expect(await ctx.prisma.outboxEvent.count({ where: { eventType: 'user.created' } })).toBe(1);
  });

  it('serves none of them through the audit and outbox routes either', async () => {
    const admin = ctx.browser();
    expect((await admin.login(tenant.admin.email!, ADMIN_PASSWORD)).status).toBe(200);
    const audit = await admin.get('/audit-events', { pageSize: 100 });
    const outbox = await admin.get('/outbox-events', { pageSize: 100 });
    expect([audit.status, outbox.status]).toEqual([200, 200]);
    expect(audit.body.total).toBeGreaterThan(15);
    for (const [label, value] of secrets) {
      expect([label, audit.text.includes(value) || outbox.text.includes(value)]).toEqual([
        label,
        false,
      ]);
    }
  });
});

describe('no code in the logs in production', () => {
  let ctx: TestApp;
  let logger: CapturingLogger;
  let sender: RecordingRealSender;

  beforeAll(async () => {
    ({ ctx, logger, sender } = await startCapturing('production'));
    await ctx.reset();
  });
  afterAll(() => ctx.close());

  it('logs that a code was issued (by user id), warns that nobody received it, never the code', async () => {
    const { admin } = await createTenant(ctx.prisma);
    const created = await ctx
      .as(admin.id)
      .post('/users', { displayName: 'Ece K', username: 'ece.k' });
    expect(created.status).toBe(201);
    const reissued = await ctx.as(admin.id).post(`/users/${created.body.id}/activation-code`);
    expect(reissued.status).toBe(200);
    expect(sender.sent).toHaveLength(2);
    for (const notification of sender.sent) {
      for (const value of [
        notification.code,
        notification.code.replaceAll('-', ''),
        notification.link,
      ]) {
        expect(logger.lines.filter((line) => line.text.includes(value))).toEqual([]);
      }
    }
    const notices = logger.lines.filter((line) => line.context === 'Notifications');
    expect(notices.some((line) => line.text.includes(created.body.id))).toBe(true);
    expect(
      notices.some((line) => line.level === 'warn' && line.text.includes('NOT delivered')),
    ).toBe(true);
  });
});
