import { NotificationResolutionService } from '../src/operations/notifications/notification-resolution.service';
import { NotificationService } from '../src/platform/notifications/notification.service';
import { OutboxConsumer } from '../src/platform/outbox/outbox-consumer';
import {
  createMembership,
  createSite,
  createTask,
  createTenant,
  createUser,
  createWorkLog,
  type Tenant,
} from './support/factories';
import { startTestApp, type TestApp } from './support/test-app';

// Notifications that ask for nothing more are resolved (owner request, 2026-11-16): they leave
// the in-app list, the unread count and the phone's sync pull, and stay in the table. Example
// values only; no push (PUSH_ENABLED is off in the harness).

describe('notifications resolved when settled', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let consumer: OutboxConsumer;
  let notifications: NotificationService;

  beforeAll(async () => {
    ctx = await startTestApp();
    consumer = ctx.app.get(OutboxConsumer);
    notifications = ctx.app.get(NotificationService);
  });
  beforeEach(async () => {
    await ctx.reset();
    consumer.resetState();
    tenant = await createTenant(ctx.prisma);
  });
  afterAll(() => ctx.close());

  const orgId = () => tenant.organization.id;
  const admin = () => ctx.as(tenant.admin.id);

  async function worker() {
    const site = await createSite(ctx.prisma, orgId());
    const user = await createUser(ctx.prisma, orgId());
    await createMembership(ctx.prisma, orgId(), user.id, 'worker', { siteIds: [site.id] });
    return { ...user, siteId: site.id };
  }

  async function drain() {
    await consumer.processPending();
    await notifications.whenIdle();
  }

  const inbox = async (userId: string) => {
    const response = await ctx.as(userId).get('/notifications');
    expect(response.status).toBe(200);
    return response.body as { items: Array<{ type: string }>; unreadCount: number };
  };
  const pulledIds = async (userId: string) => {
    const response = await ctx.as(userId).get('/sync/pull');
    expect(response.status).toBe(200);
    return response.body.notifications.ids as string[];
  };

  async function assignedTask(assigneeIds: string[]) {
    const created = await admin().post('/tasks', { title: 'Fix the pump', assigneeIds });
    expect(created.status).toBe(201);
    await drain();
    return created.body.id as string;
  }

  describe('task assigned', () => {
    it('clears the alert when the assignee finishes the task, keeping the row', async () => {
      const deniz = await worker();
      const taskId = await assignedTask([deniz.id]);
      expect(await inbox(deniz.id)).toMatchObject({
        unreadCount: 1,
        items: [{ type: 'task.assigned' }],
      });
      expect(await pulledIds(deniz.id)).toHaveLength(1);

      // Starting the task asks for more work: the alert stays.
      expect(
        (await ctx.as(deniz.id).patch(`/tasks/${taskId}/status`, { status: 'in_progress' })).status,
      ).toBe(200);
      await drain();
      expect((await inbox(deniz.id)).items).toHaveLength(1);

      expect(
        (await ctx.as(deniz.id).patch(`/tasks/${taskId}/status`, { status: 'done' })).status,
      ).toBe(200);
      await drain();
      expect(await inbox(deniz.id)).toEqual(expect.objectContaining({ items: [], unreadCount: 0 }));
      expect(await pulledIds(deniz.id)).toEqual([]);
      const row = await ctx.prisma.notification.findFirstOrThrow({
        where: { recipientId: deniz.id },
      });
      expect(row.resolvedAt).not.toBeNull();
    });

    it('clears it for the person removed from the task, not for the one still on it', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      const taskId = await assignedTask([deniz.id, emre.id]);
      const response = await admin().put(`/tasks/${taskId}/assignees`, { assigneeIds: [emre.id] });
      expect(response.status).toBe(200);
      await drain();
      expect((await inbox(deniz.id)).items).toEqual([]);
      expect((await inbox(emre.id)).items).toHaveLength(1);
    });

    it('clears it when the task is cancelled or archived', async () => {
      const [deniz, emre] = [await worker(), await worker()];
      const cancelled = await assignedTask([deniz.id]);
      expect(
        (
          await admin().patch(`/tasks/${cancelled}/status`, {
            status: 'cancelled',
            reason: 'Not needed',
          })
        ).status,
      ).toBe(200);
      const archived = await assignedTask([emre.id]);
      expect((await admin().post(`/tasks/${archived}/archive`, {})).status).toBeLessThan(300);
      await drain();
      expect((await inbox(deniz.id)).items).toEqual([]);
      expect((await inbox(emre.id)).items).toEqual([]);
    });
  });

  describe('work log rejected', () => {
    it('keeps the rejection while it stands and clears it once the log is approved', async () => {
      const deniz = await worker();
      const log = await createWorkLog(ctx.prisma, orgId(), deniz.id, {
        siteId: deniz.siteId,
        status: 'submitted',
      });
      const review = (body: Record<string, string>) =>
        admin().patch(`/work-logs/${log.id}/status`, body);
      expect((await review({ status: 'rejected', note: 'Photo missing' })).status).toBe(200);
      await drain();
      expect((await inbox(deniz.id)).items.map((item) => item.type)).toEqual(['work_log.rejected']);

      // Resubmitted: the log is no longer rejected, so the alert is cleared.

      expect((await review({ status: 'submitted' })).status).toBe(200);

      await drain();

      expect((await inbox(deniz.id)).items).toEqual([]);

      expect((await review({ status: 'approved' })).status).toBe(200);
      await drain();
      expect((await inbox(deniz.id)).items.map((item) => item.type)).toEqual(['work_log.approved']);
    });
  });

  it('is idempotent: handling the same events again resolves nothing more', async () => {
    const deniz = await worker();
    const task = await createTask(ctx.prisma, orgId(), tenant.admin.id, {
      assigneeIds: [deniz.id],
    });
    const resolver = ctx.app.get(NotificationResolutionService);
    expect(await resolver.settleTask(orgId(), task.id)).toBe(0);
    await ctx.prisma.notification.create({
      data: {
        organizationId: orgId(),
        recipientId: deniz.id,
        type: 'task.assigned',
        title: 'New task',
        body: 'b',
        data: { taskId: task.id },
      },
    });
    await ctx.prisma.task.update({ where: { id: task.id }, data: { status: 'done' } });
    expect(await resolver.settleTask(orgId(), task.id)).toBe(1);
    expect(await resolver.settleTask(orgId(), task.id)).toBe(0);
  });
});
