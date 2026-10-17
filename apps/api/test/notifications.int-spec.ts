import { randomUUID } from 'node:crypto';
import type { LoggerService } from '@nestjs/common';
import { notificationListSchema } from '@ops/shared';
import { NOTIFYING_EVENT_TYPES } from '../src/operations/notifications/notification-rules';
import { OperationsNotificationsService } from '../src/operations/notifications/operations-notifications.service';
import {
  EXPO_PUSH_CLIENT,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from '../src/platform/notifications/expo-push-client';
import {
  EXPO_PUSH_CHANNEL_OPTIONS,
  ExpoPushChannel,
} from '../src/platform/notifications/expo-push.channel';
import { NotificationService } from '../src/platform/notifications/notification.service';
import {
  DEFAULT_OUTBOX_CONSUMER_NAME,
  OutboxConsumer,
} from '../src/platform/outbox/outbox-consumer';
import { OutboxService } from '../src/platform/outbox/outbox.service';
import {
  at,
  createMembership,
  createSite,
  createTask,
  createTenant,
  createUser,
  createWorkLog,
  eventCounts,
  type Tenant,
} from './support/factories';
import { startTestApp, type TestApp } from './support/test-app';

// Notifications end to end on the real database: outbox events become in-app notifications
// for the right people only, push tokens follow their session, and pushes go to a FAKE Expo
// client (nothing leaves the machine). Example values only.

const PASSWORD = 'correct horse battery';
const token = (n: number) => `ExponentPushToken[fake-test-token-${String(n).padStart(4, '0')}]`;

class FakeExpo implements ExpoPushClient {
  readonly sent: ExpoPushMessage[] = [];
  invalid = new Set<string>();
  /** Tokens whose ticket is refused for another reason, quoting the token (Expo does). */
  throttled = new Set<string>();
  /** Tokens whose RECEIPT says DeviceNotRegistered (the ticket was accepted). */
  invalidInReceipt = new Set<string>();
  /** When true, `send` fails as a whole (Expo unreachable). */
  down = false;
  private readonly tickets = new Map<string, string>();
  send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    if (this.down) {
      return Promise.reject(new Error('Expo is unreachable'));
    }
    this.sent.push(...messages);
    return Promise.resolve(
      messages.map((message, index): ExpoPushTicket => {
        if (this.invalid.has(message.to)) {
          return {
            status: 'error',
            message: `"${message.to}" is not a registered push notification recipient`,
            details: { error: 'DeviceNotRegistered' },
          };
        }
        if (this.throttled.has(message.to)) {
          return {
            status: 'error',
            message: `Too many messages for ${message.to}`,
            details: { error: 'MessageRateExceeded' },
          };
        }
        const id = `ticket-${this.sent.length}-${index}`;
        this.tickets.set(id, message.to);
        return { status: 'ok', id };
      }),
    );
  }
  getReceipts(ids: readonly string[]): Promise<Record<string, ExpoPushReceipt>> {
    const receipts: Record<string, ExpoPushReceipt> = {};
    for (const id of ids) {
      const to = this.tickets.get(id);
      receipts[id] =
        to && this.invalidInReceipt.has(to)
          ? {
              status: 'error',
              message: `"${to}" is not a registered push notification recipient`,
              details: { error: 'DeviceNotRegistered' },
            }
          : { status: 'ok' };
    }
    return Promise.resolve(receipts);
  }
  clear(): void {
    this.sent.length = 0;
    this.invalid.clear();
    this.throttled.clear();
    this.invalidInReceipt.clear();
    this.down = false;
    this.tickets.clear();
  }
}

/** Keeps every line the application logs, at every level. */
class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private keep(level: string, message: unknown, rest: unknown[]): void {
    this.lines.push(
      [level, message, ...rest]
        .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
        .join(' '),
    );
  }
  log(message: unknown, ...rest: unknown[]) {
    this.keep('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.keep('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.keep('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.keep('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.keep('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.keep('fatal', message, rest);
  }
}

describe('notifications', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let consumer: OutboxConsumer;
  let notifications: NotificationService;
  const expo = new FakeExpo();
  const logger = new CapturingLogger();

  beforeAll(async () => {
    ctx = await startTestApp({
      config: { PUSH_ENABLED: true, OUTBOX_CONSUMER_ENABLED: false },
      logger,
      configure: (builder) =>
        builder
          .overrideProvider(EXPO_PUSH_CLIENT)
          .useValue(expo)
          // Receipts may be asked for at once (production waits 15 minutes).
          .overrideProvider(EXPO_PUSH_CHANNEL_OPTIONS)
          .useValue({ enabled: true, receiptDelayMs: 0 }),
    });
    consumer = ctx.app.get(OutboxConsumer);
    notifications = ctx.app.get(NotificationService);
  });
  beforeEach(async () => {
    await ctx.reset();
    consumer.resetState();
    expo.clear();
    logger.lines.length = 0;
    tenant = await createTenant(ctx.prisma);
  });
  afterAll(() => ctx.close());

  const orgId = () => tenant.organization.id;

  async function worker() {
    const site = await createSite(ctx.prisma, orgId());
    const user = await createUser(ctx.prisma, orgId());
    await createMembership(ctx.prisma, orgId(), user.id, 'worker', { siteIds: [site.id] });
    return { ...user, siteId: site.id };
  }

  /** Runs the consumer once and waits for the push deliveries it started. */
  async function drain() {
    const result = await consumer.processPending();
    await notifications.whenIdle();
    return result;
  }

  const listOf = async (userId: string) => {
    const response = await ctx.as(userId).get('/notifications');
    expect(response.status).toBe(200);
    expect(notificationListSchema.safeParse(response.body).success).toBe(true);
    return response.body as { items: Array<Record<string, unknown>>; unreadCount: number };
  };

  const tokenRows = () => ctx.prisma.pushToken.findMany({ orderBy: { createdAt: 'asc' } });

  describe('task assigned', () => {
    it('notifies the new assignee (not the admin who assigned) once, with a push', async () => {
      const deniz = await worker();
      expect(
        (
          await ctx
            .as(deniz.id)
            .post('/notifications/push-tokens', { token: token(1), platform: 'android' })
        ).status,
      ).toBe(204);

      const created = await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'Fix the pump', assigneeIds: [deniz.id, tenant.admin.id] });
      expect(created.status).toBe(201);
      expect((await drain()).handled).toBeGreaterThan(0);

      const list = await listOf(deniz.id);
      expect(list.unreadCount).toBe(1);
      expect(list.items).toEqual([
        expect.objectContaining({
          type: 'task.assigned',
          title: 'New task: Fix the pump',
          data: { taskId: created.body.id },
          readAt: null,
        }),
      ]);
      expect((await listOf(tenant.admin.id)).items).toEqual([]);
      // The push is generic: a locked phone shows no task title.
      expect(expo.sent).toEqual([
        expect.objectContaining({
          to: token(1),
          title: 'New task assigned',
          body: 'Open the app to see it.',
          data: expect.objectContaining({ taskId: created.body.id, type: 'task.assigned' }),
        }),
      ]);
      expect(JSON.stringify(expo.sent)).not.toContain('Fix the pump');

      // Re-processing (a restart, a second instance) writes and pushes nothing new.
      consumer.resetState();
      await drain();
      expect((await listOf(deniz.id)).items).toHaveLength(1);
      expect(expo.sent).toHaveLength(1);
    });

    it('notifies only the added assignees when the list changes', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [deniz.id],
      });
      const response = await ctx
        .as(tenant.admin.id)
        .put(`/tasks/${task.id}/assignees`, { assigneeIds: [deniz.id, emre.id] });
      expect(response.status).toBe(200);
      await drain();
      expect((await listOf(emre.id)).items).toHaveLength(1);
      expect((await listOf(deniz.id)).items).toHaveLength(0);
    });

    it('skips somebody no longer assigned, or archived, by the time the event is handled', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'Short-lived', assigneeIds: [deniz.id, emre.id] });
      const task = await ctx.prisma.task.findFirstOrThrow({ where: { title: 'Short-lived' } });
      await ctx.prisma.taskAssignee.deleteMany({ where: { taskId: task.id, userId: deniz.id } });
      await ctx.prisma.user.update({ where: { id: emre.id }, data: { archivedAt: new Date() } });
      await drain();
      expect(await ctx.prisma.notification.count()).toBe(0);
    });
  });

  describe('work log reviewed', () => {
    it('tells the author about a rejection (with the note) and an approval', async () => {
      const deniz = await worker();
      const log = await createWorkLog(ctx.prisma, orgId(), deniz.id, {
        siteId: deniz.siteId,
        status: 'submitted',
      });
      const rejected = await ctx
        .as(tenant.admin.id)
        .patch(`/work-logs/${log.id}/status`, { status: 'rejected', note: 'Photo missing' });
      expect(rejected.status).toBe(200);
      await drain();
      let items = (await listOf(deniz.id)).items;
      expect(items).toEqual([
        expect.objectContaining({
          type: 'work_log.rejected',
          title: 'Work log rejected',
          data: { workLogId: log.id },
        }),
      ]);
      if (rejected.body.review?.note) {
        expect(items[0]!.body).toBe('Your work log was rejected: Photo missing');
      }

      for (const status of ['submitted', 'approved']) {
        expect(
          (await ctx.as(tenant.admin.id).patch(`/work-logs/${log.id}/status`, { status })).status,
        ).toBe(200);
      }
      await drain();
      items = (await listOf(deniz.id)).items;
      expect(items.map((item) => item.type)).toEqual(['work_log.approved', 'work_log.rejected']);
      expect((await listOf(tenant.admin.id)).items).toEqual([]);
    });
  });

  describe('lock-screen privacy and corrected decisions', () => {
    it('the push of a rejection carries no note; the in-app row does', async () => {
      const deniz = await worker();
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      const log = await createWorkLog(ctx.prisma, orgId(), deniz.id, {
        siteId: deniz.siteId,
        status: 'submitted',
      });
      const rejected = await ctx
        .as(tenant.admin.id)
        .patch(`/work-logs/${log.id}/status`, { status: 'rejected', note: 'Wrong site photo' });
      expect(rejected.status).toBe(200);
      await drain();
      expect((await listOf(deniz.id)).items[0]).toMatchObject({
        body: 'Your work log was rejected: Wrong site photo',
      });
      expect(expo.sent).toEqual([
        expect.objectContaining({
          title: 'Work log rejected',
          body: 'Open the app for the reason.',
        }),
      ]);
      expect(JSON.stringify(expo.sent)).not.toContain('Wrong site');
    });

    it('repeating a decision to correct the note notifies again for a rejection, not for an approval', async () => {
      const deniz = await worker();
      const log = await createWorkLog(ctx.prisma, orgId(), deniz.id, {
        siteId: deniz.siteId,
        status: 'submitted',
      });
      const review = (body: Record<string, unknown>) =>
        ctx.as(tenant.admin.id).patch(`/work-logs/${log.id}/status`, body);
      expect((await review({ status: 'rejected', note: 'First reason' })).status).toBe(200);
      await drain();
      expect((await review({ status: 'rejected', note: 'Corrected reason' })).status).toBe(200);
      await drain();
      let items = (await listOf(deniz.id)).items;
      expect(items.map((item) => item.body)).toEqual([
        'Your work log was rejected: Corrected reason',
        'Your work log was rejected: First reason',
      ]);

      expect((await review({ status: 'submitted' })).status).toBe(200);
      expect((await review({ status: 'approved', note: 'Good' })).status).toBe(200);
      await drain();
      expect((await review({ status: 'approved', note: 'Good, thanks' })).status).toBe(200);
      await drain();
      items = (await listOf(deniz.id)).items;
      expect(items.map((item) => item.type)).toEqual([
        'work_log.approved',
        'work_log.rejected',
        'work_log.rejected',
      ]);
    });
  });

  describe('the in-app list', () => {
    async function seed(recipientId: string, count: number, organizationId = orgId()) {
      for (let index = 0; index < count; index += 1) {
        await ctx.prisma.notification.create({
          data: {
            organizationId,
            recipientId,
            type: 'task.assigned',
            title: `N${index}`,
            body: 'b',
            createdAt: new Date(Date.UTC(2026, 9, 1, 8, index)),
          },
        });
      }
    }

    it('lists only my own, newest first, paginated, with the unread filter and count', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      await seed(deniz.id, 3);
      await seed(emre.id, 2);
      const page = await ctx.as(deniz.id).get('/notifications', { pageSize: 2 });
      expect(page.body).toMatchObject({ total: 3, unreadCount: 3, page: 1, pageSize: 2 });
      expect(page.body.items.map((item: { title: string }) => item.title)).toEqual(['N2', 'N1']);

      const first = page.body.items[0].id as string;
      const read = await ctx.as(deniz.id).post(`/notifications/${first}/read`);
      expect(read.status).toBe(200);
      expect(read.body.readAt).not.toBeNull();
      const again = await ctx.as(deniz.id).post(`/notifications/${first}/read`);
      expect(again.body.readAt).toBe(read.body.readAt);

      const unread = await ctx.as(deniz.id).get('/notifications', { unread: true });
      expect(unread.body).toMatchObject({ total: 2, unreadCount: 2 });

      expect((await ctx.as(deniz.id).post('/notifications/read-all')).status).toBe(204);
      expect((await listOf(deniz.id)).unreadCount).toBe(0);
      expect((await listOf(emre.id)).unreadCount).toBe(2);
    });

    it("answers 404 for somebody else's notification and leaves it unread", async () => {
      const [deniz, emre] = [await worker(), await worker()];
      await seed(emre.id, 1);
      const theirs = await ctx.prisma.notification.findFirstOrThrow({
        where: { recipientId: emre.id },
      });
      expect((await ctx.as(deniz.id).post(`/notifications/${theirs.id}/read`)).status).toBe(404);
      expect(
        (await ctx.prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt,
      ).toBeNull();
    });

    it('requires a signed-in user', async () => {
      expect((await ctx.as().get('/notifications')).status).toBe(401);
    });
  });

  describe('push tokens', () => {
    it('validates the body strictly', async () => {
      const deniz = await worker();
      const api = ctx.as(deniz.id);
      expect(
        (await api.post('/notifications/push-tokens', { token: 'abc', platform: 'android' }))
          .status,
      ).toBe(400);
      expect(
        (await api.post('/notifications/push-tokens', { token: token(1), platform: 'web' })).status,
      ).toBe(400);
      expect(
        (
          await api.post('/notifications/push-tokens', {
            token: token(1),
            platform: 'ios',
            userId: deniz.id,
          })
        ).status,
      ).toBe(400);
    });

    it('binds the token to the caller and the session, idempotently, and audits without the token', async () => {
      const deniz = await worker();
      const api = ctx.as(deniz.id);
      await api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      await api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      const rows = await tokenRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: deniz.id,
        organizationId: orgId(),
        platform: 'android',
      });
      expect(rows[0]!.sessionId).not.toBeNull();

      const audits = await ctx.prisma.auditEvent.findMany({ where: { entityType: 'push_token' } });
      expect(audits.map((audit) => audit.action)).toEqual(['push_token.registered']);
      expect(JSON.stringify(audits)).not.toContain('fake-test-token');
      expect(audits[0]!.after).toMatchObject({ suffix: '…n-0001', platform: 'android' });
    });

    it('replaces the previous token of the same session', async () => {
      const deniz = await worker();
      const api = ctx.as(deniz.id);
      await api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      await api.post('/notifications/push-tokens', { token: token(2), platform: 'android' });
      expect((await tokenRows()).map((row) => row.token)).toEqual([token(2)]);
    });

    it('moves a token registered by another user to the caller', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'ios' });
      await ctx
        .as(emre.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'ios' });
      const rows = await tokenRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(emre.id);
      const actions = (
        await ctx.prisma.auditEvent.findMany({
          where: { entityType: 'push_token' },
          orderBy: { occurredAt: 'asc' },
        })
      ).map((audit) => [audit.action, (audit.after as { reason?: string }).reason ?? null]);
      expect(actions).toEqual([
        ['push_token.registered', null],
        ['push_token.removed', 'rebound'],
        ['push_token.registered', null],
      ]);
    });

    it("unregisters only one's own token; another's answers 404", async () => {
      const [deniz, emre] = [await worker(), await worker()];
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'ios' });
      const path = `/notifications/push-tokens/${encodeURIComponent(token(1))}`;
      expect((await ctx.as(emre.id).delete(path)).status).toBe(404);
      expect(await tokenRows()).toHaveLength(1);
      expect((await ctx.as(deniz.id).delete(path)).status).toBe(204);
      expect(await tokenRows()).toHaveLength(0);
      expect((await ctx.as(deniz.id).delete(path)).status).toBe(404);
    });

    describe('ending the session removes its token', () => {
      async function signedIn() {
        const deniz = await worker();
        await ctx.setPassword(deniz.id, PASSWORD);
        const login = await ctx.loginAs(deniz.email!, PASSWORD);
        expect(login.status).toBe(200);
        const tokens = login.body.tokens as { accessToken: string; refreshToken: string };
        const api = ctx.bearer(tokens.accessToken);
        return { deniz, api, ...tokens };
      }

      it('on sign-out', async () => {
        const { api } = await signedIn();
        await api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
        expect((await api.post('/auth/logout', {})).status).toBe(204);
        expect(await tokenRows()).toHaveLength(0);
        const removed = await ctx.prisma.auditEvent.findFirstOrThrow({
          where: { action: 'push_token.removed' },
        });
        expect(removed.after).toEqual({ reason: 'session_ended' });
      });

      it('on sign-out everywhere, and on ending the session from another device', async () => {
        const one = await signedIn();
        await one.api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
        await ctx
          .as(one.deniz.id)
          .post('/notifications/push-tokens', { token: token(2), platform: 'ios' });
        expect(await tokenRows()).toHaveLength(2);
        expect((await one.api.post('/auth/logout-all')).status).toBe(204);
        expect(await tokenRows()).toHaveLength(0);

        const two = await signedIn();
        await two.api.post('/notifications/push-tokens', { token: token(3), platform: 'android' });
        const session = (await ctx.prisma.pushToken.findFirstOrThrow()).sessionId!;
        expect((await ctx.as(two.deniz.id).delete(`/auth/sessions/${session}`)).status).toBe(204);
        expect(await tokenRows()).toHaveLength(0);
      });

      it('on a password change: other sessions lose theirs, the current one keeps it', async () => {
        const one = await signedIn();
        await one.api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
        const other = await ctx.loginAs(one.deniz.email!, PASSWORD);
        const otherApi = ctx.bearer(other.body.tokens.accessToken as string);
        await otherApi.post('/notifications/push-tokens', { token: token(2), platform: 'ios' });
        const changed = await one.api.post('/auth/change-password', {
          currentPassword: PASSWORD,
          newPassword: 'another long passphrase 42',
        });
        expect(changed.status).toBe(204);
        expect((await tokenRows()).map((row) => row.token)).toEqual([token(1)]);
      });

      it('on refresh-token reuse', async () => {
        const one = await signedIn();
        await one.api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
        expect(
          (await ctx.as().post('/auth/refresh', { refreshToken: one.refreshToken })).status,
        ).toBe(200);
        ctx.clock.advanceSeconds(30);
        expect(
          (await ctx.as().post('/auth/refresh', { refreshToken: one.refreshToken })).status,
        ).toBe(401);
        expect(await tokenRows()).toHaveLength(0);
      });

      it('when an admin archives the user', async () => {
        const { deniz, api } = await signedIn();
        await api.post('/notifications/push-tokens', { token: token(1), platform: 'android' });
        expect((await ctx.as(tenant.admin.id).post(`/users/${deniz.id}/archive`)).status).toBe(200);
        expect(await tokenRows()).toHaveLength(0);
      });
    });

    it('drops a token Expo reports as not registered, and a token of a dead session at delivery', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      await ctx
        .as(emre.id)
        .post('/notifications/push-tokens', { token: token(2), platform: 'ios' });
      expo.invalid.add(token(1));
      // emre's session expires without any event
      await ctx.prisma.authSession.updateMany({
        where: { userId: emre.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'Check the valves', assigneeIds: [deniz.id, emre.id] });
      await drain();

      expect(expo.sent.map((message) => message.to)).toEqual([token(1)]);
      expect(await tokenRows()).toHaveLength(0);
      const reasons = (
        await ctx.prisma.auditEvent.findMany({ where: { action: 'push_token.removed' } })
      ).map((audit) => (audit.after as { reason: string }).reason);
      expect(reasons.sort()).toEqual(['device_not_registered', 'session_ended']);
      // The in-app list works regardless of push.
      expect((await listOf(deniz.id)).unreadCount).toBe(1);
    });
  });

  describe('push token lifecycle: the rest of the ways a session ends', () => {
    async function signedIn(userId?: string) {
      const user =
        userId !== undefined
          ? await ctx.prisma.user.findUniqueOrThrow({ where: { id: userId } })
          : await worker();
      if (userId === undefined) {
        await ctx.setPassword(user.id, PASSWORD);
      }
      const login = await ctx.loginAs(user.email!, PASSWORD);
      expect(login.status).toBe(200);
      return {
        user,
        api: ctx.bearer(login.body.tokens.accessToken as string),
        sessionId: login.body.session?.id as string | undefined,
      };
    }
    const register = (api: ReturnType<typeof ctx.bearer>, n: number) =>
      api.post('/notifications/push-tokens', { token: token(n), platform: 'android' });

    it('sign-out removes only that device’s token; the other device keeps receiving', async () => {
      const phone = await signedIn();
      const tablet = await signedIn(phone.user.id);
      expect((await register(phone.api, 1)).status).toBe(204);
      expect((await register(tablet.api, 2)).status).toBe(204);

      expect((await phone.api.post('/auth/logout', {})).status).toBe(204);
      expect((await tokenRows()).map((row) => row.token)).toEqual([token(2)]);

      await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'Still delivered', assigneeIds: [phone.user.id] });
      await drain();
      expect(expo.sent.map((message) => message.to)).toEqual([token(2)]);
    });

    it('the same token registered from a second session of the same user moves to that session', async () => {
      const first = await signedIn();
      const second = await signedIn(first.user.id);
      await register(first.api, 1);
      const before = (await tokenRows())[0]!;
      await register(second.api, 1);
      const rows = await tokenRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.userId).toBe(first.user.id);
      expect(rows[0]!.sessionId).not.toBe(before.sessionId);
      // Signing out of the FIRST session no longer touches it.
      await first.api.post('/auth/logout', {});
      expect(await tokenRows()).toHaveLength(1);
    });

    it('a password reset (admin code + set-password) removes the tokens of every session', async () => {
      const one = await signedIn();
      const two = await signedIn(one.user.id);
      await register(one.api, 1);
      await register(two.api, 2);
      const issued = await ctx.as(tenant.admin.id).post(`/users/${one.user.id}/password-reset`);
      expect(issued.status).toBe(200);
      expect(await tokenRows()).toHaveLength(2); // issuing a code alone ends nothing
      const set = await ctx.as().post('/auth/set-password', {
        code: issued.body.code,
        password: 'a fresh long passphrase 7',
      });
      expect(set.status).toBe(204);
      expect(await tokenRows()).toHaveLength(0);
    });

    it('archiving the membership removes the tokens (the person loses access)', async () => {
      const { user, api } = await signedIn();
      await register(api, 1);
      const membership = await ctx.prisma.membership.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(
        (await ctx.as(tenant.admin.id).post(`/memberships/${membership.id}/archive`)).status,
      ).toBe(200);
      expect(await tokenRows()).toHaveLength(0);
      const removed = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'push_token.removed' },
      });
      expect(removed.after).toEqual({ reason: 'session_ended' });
    });

    it("ending somebody else's session is 404 and their token stays", async () => {
      const deniz = await signedIn();
      await register(deniz.api, 1);
      const sessionId = (await tokenRows())[0]!.sessionId!;
      const emre = await worker();
      expect((await ctx.as(emre.id).delete(`/auth/sessions/${sessionId}`)).status).toBe(404);
      expect(await tokenRows()).toHaveLength(1);
    });

    it('a DeviceNotRegistered receipt removes the token; an accepted one keeps it', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      await ctx
        .as(emre.id)
        .post('/notifications/push-tokens', { token: token(2), platform: 'ios' });
      expo.invalidInReceipt.add(token(1));
      await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'Receipts', assigneeIds: [deniz.id, emre.id] });
      await drain();
      expect(expo.sent).toHaveLength(2);
      expect(await tokenRows()).toHaveLength(2); // both tickets were accepted

      const channel = ctx.app.get(ExpoPushChannel);
      expect(await channel.checkReceipts()).toBe(1);
      expect((await tokenRows()).map((row) => row.token)).toEqual([token(2)]);
      expect(channel.pendingReceiptCount).toBe(0);
      const reasons = (
        await ctx.prisma.auditEvent.findMany({ where: { action: 'push_token.removed' } })
      ).map((audit) => (audit.after as { reason: string }).reason);
      expect(reasons).toEqual(['device_not_registered']);
    });

    it('never writes a token to the logs (request log included), the audit log or the outbox', async () => {
      const deniz = await signedIn();
      const api = deniz.api;
      await register(api, 1);
      await register(api, 2); // replaces 1
      const emre = await worker();
      await ctx
        .as(emre.id)
        .post('/notifications/push-tokens', { token: token(3), platform: 'ios' });
      await ctx
        .as(emre.id)
        .post('/notifications/push-tokens', { token: token(4), platform: 'ios' }); // replaces 3
      expo.throttled.add(token(4));
      const third = await worker();
      await ctx
        .as(third.id)
        .post('/notifications/push-tokens', { token: token(5), platform: 'android' });
      expo.invalid.add(token(5));
      await ctx.as(tenant.admin.id).post('/tasks', {
        title: 'Logged carefully',
        assigneeIds: [deniz.user.id, emre.id, third.id],
      });
      await drain();
      // Unregister through the path the phone uses.
      expect(
        (await api.delete(`/notifications/push-tokens/${encodeURIComponent(token(2))}`)).status,
      ).toBe(204);
      expect(
        (await ctx.as(emre.id).delete(`/notifications/push-tokens/${encodeURIComponent(token(4))}`))
          .status,
      ).toBe(204);
      await api.post('/auth/logout', {});

      const everything = [
        ...logger.lines,
        JSON.stringify(await ctx.prisma.auditEvent.findMany()),
        JSON.stringify(
          await ctx.prisma.outboxEvent.findMany({ select: { eventType: true, payload: true } }),
        ),
      ];
      expect(everything.join('\n')).toContain('/notifications/push-tokens/:token');
      expect(everything.filter((line) => line.includes('fake-test-token'))).toEqual([]);
    });

    // BUG (reported): Express matches routes case-insensitively, so
    // `DELETE /Notifications/Push-Tokens/<token>` reaches the handler (204), but the redaction in
    // request-log.ts (`SECRET_PATH_SEGMENTS`) is case-sensitive: the token is written to the log.
    it('never logs a token sent in a differently cased path', async () => {
      const deniz = await worker();
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(7), platform: 'android' });
      const response = await ctx
        .as(deniz.id)
        .delete(`/Notifications/Push-Tokens/${encodeURIComponent(token(7))}`);
      expect(response.status).toBe(204);
      await ctx.as(deniz.id).get('/notifications'); // the log line is written on 'finish'
      expect(logger.lines.filter((line) => line.includes('fake-test-token'))).toEqual([]);
    });
  });

  describe('notifications only to the right users: more cases', () => {
    it('nothing for a task archived before the event is handled', async () => {
      const deniz = await worker();
      const created = await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'Cancelled plan', assigneeIds: [deniz.id] });
      expect((await ctx.as(tenant.admin.id).post(`/tasks/${created.body.id}/archive`)).status).toBe(
        200,
      );
      await drain();
      expect(await ctx.prisma.notification.count()).toBe(0);
      expect(expo.sent).toHaveLength(0);
    });

    it('a worker never gets a notification for assigning themselves, nor for their own status changes', async () => {
      const supervisor = await createUser(ctx.prisma, orgId());
      const site = await createSite(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), supervisor.id, 'supervisor', {
        siteIds: [site.id],
      });
      const created = await ctx
        .as(supervisor.id)
        .post('/tasks', { title: 'Mine', siteId: site.id, assigneeIds: [supervisor.id] });
      expect(created.status).toBe(201);
      await ctx
        .as(supervisor.id)
        .patch(`/tasks/${created.body.id}/status`, { status: 'blocked', reason: 'Rain' });
      await drain();
      expect(await ctx.prisma.notification.count()).toBe(0);
    });

    it('a quick reject-then-reopen notifies nobody; approve-then-reject notifies the rejection only, with its note', async () => {
      const deniz = await worker();
      const reviewer = ctx.as(tenant.admin.id);
      const first = await createWorkLog(ctx.prisma, orgId(), deniz.id, { status: 'submitted' });
      await reviewer.patch(`/work-logs/${first.id}/status`, { status: 'rejected', note: 'Oops' });
      await reviewer.patch(`/work-logs/${first.id}/status`, { status: 'submitted' });
      const second = await createWorkLog(ctx.prisma, orgId(), deniz.id, { status: 'submitted' });
      await reviewer.patch(`/work-logs/${second.id}/status`, { status: 'approved' });
      await reviewer.patch(`/work-logs/${second.id}/status`, { status: 'submitted' });
      await reviewer.patch(`/work-logs/${second.id}/status`, {
        status: 'rejected',
        note: 'Wrong meter',
      });

      await drain();

      const items = (await listOf(deniz.id)).items;
      expect(items).toEqual([
        expect.objectContaining({
          type: 'work_log.rejected',
          body: 'Your work log was rejected: Wrong meter',
          data: { workLogId: second.id },
        }),
      ]);
      expect(expo.sent).toHaveLength(0); // deniz has no device
    });

    it('nobody in another organization is notified, even when an event names them', async () => {
      const elsewhere = await createTenant(ctx.prisma, 'Elsewhere');
      const stranger = await createUser(ctx.prisma, elsewhere.organization.id);
      await createMembership(ctx.prisma, elsewhere.organization.id, stranger.id, 'worker', {
        orgWide: true,
      });
      await ctx
        .as(stranger.id)
        .post('/notifications/push-tokens', { token: token(9), platform: 'android' });
      // A corrupted row: an assignee of another organization on this organization's task.
      const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
        assigneeIds: [stranger.id],
      });
      await ctx.prisma.outboxEvent.create({
        data: {
          organizationId: orgId(),
          eventType: 'task.created',
          aggregateType: 'task',
          aggregateId: task.id,
          payload: { task: { id: task.id, title: task.title, assigneeIds: [stranger.id] } },
          actorId: tenant.admin.id,
        },
      });
      await drain();
      expect(await ctx.prisma.notification.count()).toBe(0);
      expect(expo.sent).toHaveLength(0);
    });

    it('two API instances handling the same window write one notification and send one push', async () => {
      const deniz = await worker();
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      const second = new OutboxConsumer(ctx.prisma, ctx.app.get(OutboxService), {
        name: DEFAULT_OUTBOX_CONSUMER_NAME,
        enabled: false,
        pollIntervalMs: 1000,
      });
      const handler = ctx.app.get(OperationsNotificationsService);
      for (const eventType of NOTIFYING_EVENT_TYPES) {
        second.registerHandler(eventType, async (event) => {
          await handler.handle(event);
        });
      }
      // Steady state: the shared cursor row exists (see the next test for the very first start).
      await consumer.processPending();
      for (let index = 0; index < 3; index += 1) {
        await ctx
          .as(tenant.admin.id)
          .post('/tasks', { title: `Twice ${index}`, assigneeIds: [deniz.id] });
      }

      const [one, two] = await Promise.all([consumer.processPending(), second.processPending()]);
      await notifications.whenIdle();

      expect(one.handled + two.handled).toBe(6);
      expect(await ctx.prisma.notification.count()).toBe(3);
      expect(expo.sent).toHaveLength(3);
      // And again after both "restart".
      consumer.resetState();
      await Promise.all([consumer.processPending(), second.processPending()]);
      await notifications.whenIdle();
      expect(await ctx.prisma.notification.count()).toBe(3);
      expect(expo.sent).toHaveLength(3);
    });

    // Finding (reported, low): on the very first start (no cursor row yet), two instances racing
    // to create the row make one pass fail with a unique violation (Prisma's upsert is not
    // atomic). The polling loop logs it and the next pass succeeds; nothing is lost or doubled.
    it('two instances starting for the very first time: a failed first pass recovers on the next one', async () => {
      const deniz = await worker();
      await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'First start', assigneeIds: [deniz.id] });
      const instance = () => {
        const runner = new OutboxConsumer(ctx.prisma, ctx.app.get(OutboxService), {
          name: DEFAULT_OUTBOX_CONSUMER_NAME,
          enabled: false,
          pollIntervalMs: 1000,
        });
        const handler = ctx.app.get(OperationsNotificationsService);
        for (const eventType of NOTIFYING_EVENT_TYPES) {
          runner.registerHandler(eventType, async (event) => {
            await handler.handle(event);
          });
        }
        return runner;
      };
      const runners = [instance(), instance(), instance()];
      const first = await Promise.allSettled(runners.map((runner) => runner.processPending()));
      const second = await Promise.allSettled(runners.map((runner) => runner.processPending()));
      await notifications.whenIdle();
      expect(first.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
      expect(second.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
      expect(await ctx.prisma.notification.count()).toBe(1);
    });

    it('a failing push channel never blocks, retries or rolls back the in-app notification', async () => {
      const deniz = await worker();
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      expo.down = true;
      await ctx
        .as(tenant.admin.id)
        .post('/tasks', { title: 'Expo is down', assigneeIds: [deniz.id] });

      const result = await drain();

      expect(result).toMatchObject({ handled: 1, retrying: 0, gaveUp: 0 });
      expect((await listOf(deniz.id)).unreadCount).toBe(1);
      expect(await tokenRows()).toHaveLength(1); // a failed send is not a dead token
      expect(logger.lines.some((line) => line.includes('Push batch of 1 failed'))).toBe(true);
    });

    it('a repeated work-log submit (same clientId) after a review: 200 with the current log, no new event, no second notification', async () => {
      const deniz = await worker();
      await ctx
        .as(deniz.id)
        .post('/notifications/push-tokens', { token: token(1), platform: 'android' });
      const body = {
        clientId: randomUUID(),
        occurredAt: at().toISOString(),
        siteId: deniz.siteId,
        text: 'Replaced the filter',
      };
      // The phone sends twice at once (a double tap), then once more later (a lost answer).
      const burst = await Promise.all([
        ctx.as(deniz.id).post('/work-logs', body),
        ctx.as(deniz.id).post('/work-logs', body),
      ]);
      expect(burst.map((response) => response.status).sort()).toEqual([200, 201]);
      const id = burst[0]!.body.id as string;
      await ctx
        .as(tenant.admin.id)
        .patch(`/work-logs/${id}/status`, { status: 'rejected', note: 'Photo missing' });
      await drain();
      const counts = await eventCounts(ctx.prisma, orgId());

      const retry = await ctx.as(deniz.id).post('/work-logs', body);
      await drain();

      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({
        id,
        status: 'rejected',
        review: { note: 'Photo missing' },
      });
      expect(await ctx.prisma.workLog.count()).toBe(1);
      expect(await eventCounts(ctx.prisma, orgId())).toEqual(counts);
      expect(await ctx.prisma.notification.count()).toBe(1);
      expect(expo.sent).toHaveLength(1);
    });
  });
});
