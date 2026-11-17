import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { NotificationService } from '../../platform/notifications/notification.service';
import { OutboxConsumer } from '../../platform/outbox/outbox-consumer';
import type { OutboxEventRow } from '../../platform/outbox/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessClock } from '../access';

/** Task states in which "a task was assigned to you" asks for nothing more. */
const SETTLED_TASK_STATUSES = new Set(['done', 'cancelled']);

/** Events after which a task's "assigned" notifications may be settled. */
const TASK_EVENTS = ['task.status_changed', 'task.assignees_changed', 'task.archived'] as const;
/** Events after which a log's "rejected" notification may be settled. */
const WORK_LOG_EVENTS = ['work_log.status_changed', 'work_log.archived'] as const;

/**
 * Clears notifications that ask for nothing any more (owner request, 2026-11-16): they are
 * marked resolved, so they leave the in-app list, the unread count and the phone (the sync pull
 * no longer lists them), and stay in the table as history.
 *
 * - `task.assigned`: when the task is done, cancelled, archived or gone, or the recipient is no
 *   longer an assignee.
 * - `work_log.rejected`: when the log is no longer rejected (resubmitted, approved) or archived.
 * - `ai.daily_summary`: when a newer summary for the same recipient arrives.
 *
 * Each handler re-reads the CURRENT state of the subject and resolves only what that state
 * settles, so it is idempotent and safe to run twice or out of order.
 */
@Injectable()
export class NotificationResolutionService implements OnModuleInit {
  private readonly logger = new Logger('NotificationResolution');

  constructor(
    private readonly consumer: OutboxConsumer,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
    private readonly clock: AccessClock,
  ) {}

  onModuleInit(): void {
    for (const eventType of TASK_EVENTS) {
      this.consumer.registerHandler(
        eventType,
        async (event) => void (await this.handle(event)),
        `operations.notification-resolution:${eventType}`,
      );
    }
    for (const eventType of WORK_LOG_EVENTS) {
      this.consumer.registerHandler(
        eventType,
        async (event) => void (await this.handle(event)),
        `operations.notification-resolution:${eventType}`,
      );
    }
    this.consumer.registerHandler(
      'daily_summary.created',
      async (event) => void (await this.handle(event)),
      'operations.notification-resolution:daily_summary.created',
    );
  }

  /** Handles one outbox event. Returns how many notifications were resolved. */
  async handle(event: OutboxEventRow): Promise<number> {
    const organizationId = event.organizationId;
    if (!organizationId) {
      return 0;
    }
    let resolved = 0;
    if (event.eventType.startsWith('task.')) {
      resolved = await this.settleTask(organizationId, event.aggregateId);
    } else if (event.eventType.startsWith('work_log.')) {
      resolved = await this.settleWorkLog(organizationId, event.aggregateId);
    } else if (event.eventType === 'daily_summary.created') {
      resolved = await this.settleOlderSummaries(organizationId, event.aggregateId);
    }
    if (resolved > 0) {
      this.logger.debug(`${event.eventType}: resolved ${resolved} notification(s)`);
    }
    return resolved;
  }

  /** Open "assigned" notifications of the task the task's current state settles. */
  async settleTask(organizationId: string, taskId: string): Promise<number> {
    const open = await this.open(organizationId, 'task.assigned', 'taskId', taskId);
    if (open.length === 0) {
      return 0;
    }
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId },
      select: { status: true, archivedAt: true, assignees: { select: { userId: true } } },
    });
    const finished = !task || task.archivedAt !== null || SETTLED_TASK_STATUSES.has(task.status);
    const assignees = new Set(task?.assignees.map((assignee) => assignee.userId) ?? []);
    const settled = open.filter((row) => finished || !assignees.has(row.recipientId));
    return this.notifications.resolve(
      organizationId,
      settled.map((row) => row.id),
      this.clock.now(),
    );
  }

  /** The open "rejected" notification of the log, once the log is no longer rejected. */
  async settleWorkLog(organizationId: string, workLogId: string): Promise<number> {
    const open = await this.open(organizationId, 'work_log.rejected', 'workLogId', workLogId);
    if (open.length === 0) {
      return 0;
    }
    const workLog = await this.prisma.workLog.findFirst({
      where: { id: workLogId, organizationId },
      select: { status: true, archivedAt: true },
    });
    if (workLog && workLog.archivedAt === null && workLog.status === 'rejected') {
      return 0;
    }
    return this.notifications.resolve(
      organizationId,
      open.map((row) => row.id),
      this.clock.now(),
    );
  }

  /** Older open summary notifications of the new summary's recipient. */
  async settleOlderSummaries(organizationId: string, summaryId: string): Promise<number> {
    const summary = await this.prisma.dailySummary.findFirst({
      where: { id: summaryId, organizationId },
      select: { recipientId: true, day: true },
    });
    if (!summary) {
      return 0;
    }
    const open = await this.prisma.notification.findMany({
      where: {
        organizationId,
        recipientId: summary.recipientId,
        type: 'ai.daily_summary',
        resolvedAt: null,
        NOT: { data: { path: ['summaryId'], equals: summaryId } },
      },
      select: { id: true, data: true },
    });
    // Only summaries of earlier days: a summary regenerated for an older day leaves newer ones.
    const newDay = dayKeyOf(summary.day);
    const older = open.filter((row) => {
      const day = (row.data as { day?: unknown } | null)?.day;
      return typeof day === 'string' && day < newDay;
    });
    return this.notifications.resolve(
      organizationId,
      older.map((row) => row.id),
      this.clock.now(),
    );
  }

  private open(organizationId: string, type: string, dataKey: string, subjectId: string) {
    return this.prisma.notification.findMany({
      where: {
        organizationId,
        type,
        resolvedAt: null,
        data: { path: [dataKey], equals: subjectId },
      },
      select: { id: true, recipientId: true },
    });
  }
}

function dayKeyOf(day: Date | string): string {
  return typeof day === 'string' ? day.slice(0, 10) : day.toISOString().slice(0, 10);
}
