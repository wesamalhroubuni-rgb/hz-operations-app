import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { NotificationService } from '../../platform/notifications/notification.service';
import { OutboxConsumer } from '../../platform/outbox/outbox-consumer';
import type { OutboxEventRow } from '../../platform/outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { renderNotification, type RenderedNotification } from './notification-messages';
import {
  NOTIFYING_EVENT_TYPES,
  planNotifications,
  type PlannedNotification,
} from './notification-rules';

/**
 * The Operations side of notifications: registers outbox handlers for the events in
 * ./notification-rules.ts and turns each plan into notifications through the platform's
 * `NotificationService`.
 *
 * Before writing, the CURRENT state is checked, so a notification never reveals something the
 * recipient cannot see now:
 * - task assigned: the task still exists in the organization and is not archived, and the
 *   recipient is STILL an assignee (an assignee can see the task and its title). The current
 *   title is used.
 * - log approved / rejected: the log is not archived, its author is the recipient, and its
 *   status is still the one the event announces (a quick approve-then-reject notifies only the
 *   final decision). A log is always visible to its author.
 * - `NotificationService` keeps only active users of the same organization.
 *
 * Idempotent: every notification carries the event id as `sourceEventId`, so a re-processed
 * event writes and pushes nothing new.
 */
@Injectable()
export class OperationsNotificationsService implements OnModuleInit {
  private readonly logger = new Logger('OperationsNotifications');

  constructor(
    private readonly consumer: OutboxConsumer,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    for (const eventType of NOTIFYING_EVENT_TYPES) {
      this.consumer.registerHandler(
        eventType,
        async (event) => {
          await this.handle(event);
        },
        `operations.notifications:${eventType}`,
      );
    }
  }

  /** Handles one outbox event. Returns how many notifications were created. */
  async handle(event: OutboxEventRow): Promise<number> {
    let created = 0;
    for (const plan of planNotifications(event)) {
      created += await this.apply(event.id, plan);
    }
    return created;
  }

  private async apply(sourceEventId: string, plan: PlannedNotification): Promise<number> {
    if (plan.type === 'task.assigned') {
      const task = await this.prisma.task.findFirst({
        where: { id: plan.taskId, organizationId: plan.organizationId, archivedAt: null },
        select: { title: true, assignees: { select: { userId: true } } },
      });
      if (!task) {
        return 0;
      }
      const current = new Set(task.assignees.map((assignee) => assignee.userId));
      const recipientIds = plan.recipientIds.filter((userId) => current.has(userId));
      const message = renderNotification('task.assigned', { taskTitle: task.title });
      return this.send(sourceEventId, plan, recipientIds, message, { taskId: plan.taskId });
    }

    const workLog = await this.prisma.workLog.findFirst({
      where: { id: plan.workLogId, organizationId: plan.organizationId, archivedAt: null },
      select: { authorId: true, status: true },
    });
    const announced = plan.type === 'work_log.approved' ? 'approved' : 'rejected';
    if (!workLog || workLog.status !== announced) {
      return 0;
    }
    const recipientIds = plan.recipientIds.filter((userId) => userId === workLog.authorId);
    const message =
      plan.type === 'work_log.approved'
        ? renderNotification('work_log.approved', {})
        : renderNotification('work_log.rejected', { note: plan.note });
    return this.send(sourceEventId, plan, recipientIds, message, { workLogId: plan.workLogId });
  }

  private async send(
    sourceEventId: string,
    plan: PlannedNotification,
    recipientIds: string[],
    message: RenderedNotification,
    data: Record<string, string>,
  ): Promise<number> {
    if (recipientIds.length === 0) {
      return 0;
    }
    const result = await this.notifications.notify({
      organizationId: plan.organizationId,
      recipientIds,
      type: plan.type,
      title: message.title,
      body: message.body,
      push: message.push,
      data,
      sourceEventId,
    });
    if (result.created.length > 0) {
      this.logger.debug(
        `${plan.type}: ${result.created.length} notification(s) from event ${sourceEventId}`,
      );
    }
    return result.created.length;
  }
}
