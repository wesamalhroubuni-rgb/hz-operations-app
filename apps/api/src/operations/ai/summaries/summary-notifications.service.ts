import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DAILY_SUMMARY_NOTIFICATION_TYPE, type DailySummaryStats } from '@ops/shared';
import { NotificationService } from '../../../platform/notifications/notification.service';
import { OutboxConsumer } from '../../../platform/outbox/outbox-consumer';
import type { OutboxEventRow } from '../../../platform/outbox/outbox.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { dayKeyOfColumn } from '../day-column';
import { renderDailySummaryNotification } from './summary-messages';

export const DAILY_SUMMARY_CREATED_EVENT = 'daily_summary.created';

function summaryIdOf(payload: unknown): string | null {
  const record =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>).dailySummary
      : null;
  const id =
    typeof record === 'object' && record !== null ? (record as Record<string, unknown>).id : null;
  return typeof id === 'string' ? id : null;
}

/**
 * Tells a recipient that their daily summary is ready (Phase 7, ADR-0011 section 5): an outbox
 * handler on `daily_summary.created` that calls `NotificationService.notify` with type
 * `ai.daily_summary`, data `{ summaryId, day }`, the in-app text in the recipient's language
 * and a generic push text. It re-reads the summary first (it must still exist in the event's
 * organization; `NotificationService` keeps only active users) and is idempotent: the event id is
 * the `sourceEventId`.
 */
@Injectable()
export class SummaryNotificationsService implements OnModuleInit {
  private readonly logger = new Logger('SummaryNotifications');

  constructor(
    private readonly consumer: OutboxConsumer,
    private readonly notifications: NotificationService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.consumer.registerHandler(
      DAILY_SUMMARY_CREATED_EVENT,
      async (event) => {
        await this.handle(event);
      },
      `operations.ai.summaries:${DAILY_SUMMARY_CREATED_EVENT}`,
    );
  }

  /** Handles one event. Returns how many notifications were created (0 on a repeat). */
  async handle(event: Pick<OutboxEventRow, 'id' | 'organizationId' | 'payload'>): Promise<number> {
    const summaryId = summaryIdOf(event.payload);
    if (!summaryId || !event.organizationId) {
      return 0;
    }
    const summary = await this.prisma.dailySummary.findFirst({
      where: { id: summaryId, organizationId: event.organizationId },
      select: {
        id: true,
        day: true,
        stats: true,
        recipient: { select: { id: true, locale: true } },
      },
    });
    if (!summary) {
      return 0;
    }
    const day = dayKeyOfColumn(summary.day);
    const stats = summary.stats as unknown as Partial<DailySummaryStats>;
    const message = renderDailySummaryNotification(
      {
        day,
        logs: stats.logs?.total ?? 0,
        overdue: stats.tasks?.overdue ?? 0,
        anomalies: stats.anomalies?.total ?? 0,
      },
      summary.recipient.locale,
    );
    const result = await this.notifications.notify({
      organizationId: event.organizationId,
      recipientIds: [summary.recipient.id],
      type: DAILY_SUMMARY_NOTIFICATION_TYPE,
      title: message.title,
      body: message.body,
      push: message.push,
      data: { summaryId: summary.id, day },
      sourceEventId: event.id,
    });
    if (result.created.length > 0) {
      this.logger.debug(`Daily summary ${summary.id} notified (event ${event.id})`);
    }
    return result.created.length;
  }
}
