/**
 * Creating notifications (reusable platform component). Business modules (and, in Phase 7, the
 * AI layer) call `notify`; nothing else writes `Notification` rows.
 *
 * Host requirements: a global `PrismaService` with the `notification` table (unique
 * `(sourceEventId, recipientId, type)`) and a `user` table (id, organizationId, archivedAt), and
 * the delivery channels under `NOTIFICATION_CHANNELS`.
 *
 * Rules:
 * - Recipients are filtered to ACTIVE users (not archived) of the given organization at the
 *   moment of writing; anybody else is skipped silently and reported in `skippedRecipientIds`.
 * - Idempotent per source event: with a `sourceEventId`, a second call for the same event,
 *   recipient and type writes nothing and delivers nothing (the unique key). That is what makes
 *   re-processing outbox events harmless, also with several API instances.
 * - Delivery happens AFTER the rows are committed, outside any transaction, and only for rows
 *   this call actually inserted (so a re-processed event never pushes twice). A failing channel
 *   is logged and never rolls back or delays the caller.
 * - Notification rows are derived data and are NOT written to the audit log or the outbox.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  NOTIFICATION_CHANNELS,
  type DeliverableNotification,
  type NotificationChannel,
  type NotificationPushText,
} from './notification-channel';

export const MAX_NOTIFICATION_TITLE_LENGTH = 200;
export const MAX_NOTIFICATION_BODY_LENGTH = 2000;

export interface NotifyInput {
  organizationId: string;
  recipientIds: readonly string[];
  /** Dotted kind, e.g. `task.assigned`. */
  type: string;
  title: string;
  body: string;
  /** Ids the client needs to open the right screen. No personal data. */
  data?: Record<string, unknown>;
  /**
   * What out-of-app channels (push) show instead of `title` / `body`: generic text with nothing
   * a lock screen should not display. Without it the channels use `title` / `body`.
   */
  push?: NotificationPushText | null;
  /** The outbox event this comes from: makes the call idempotent per recipient and type. */
  sourceEventId?: string | null;
}

export interface NotifyResult {
  /** The rows this call inserted (and handed to the channels). */
  created: DeliverableNotification[];
  /** Requested recipients that are not active users of the organization. */
  skippedRecipientIds: string[];
}

/** The slice of a database client (or transaction) notifications are written through. */
export interface NotificationWriter {
  user: {
    findMany(args: {
      where: { id: { in: string[] }; organizationId: string; archivedAt: null };
      select: { id: true };
    }): PromiseLike<Array<{ id: string }>>;
  };
  notification: {
    createManyAndReturn(args: {
      data: Array<{
        organizationId: string;
        recipientId: string;
        type: string;
        title: string;
        body: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON column
        data: any;
        sourceEventId: string | null;
      }>;
      skipDuplicates: true;
    }): PromiseLike<
      Array<{
        id: string;
        organizationId: string;
        recipientId: string;
        type: string;
        title: string;
        body: string;
        data: unknown;
        createdAt: Date;
      }>
    >;
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger('Notifications');
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(NOTIFICATION_CHANNELS) private readonly channels: NotificationChannel[],
  ) {}

  /** Writes the in-app notifications, then hands the new ones to the channels (not awaited). */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    const result = await this.write(this.prisma as unknown as NotificationWriter, input);
    this.deliver(result.created);
    return result;
  }

  /**
   * Writes the notifications inside the caller's transaction and delivers NOTHING: call
   * `deliver(result.created)` after the transaction has committed.
   */
  async notifyInTransaction(tx: NotificationWriter, input: NotifyInput): Promise<NotifyResult> {
    return this.write(tx, input);
  }

  /** Hands committed notifications to every channel, in the background. Never throws. */
  deliver(notifications: readonly DeliverableNotification[]): void {
    if (notifications.length === 0) {
      return;
    }
    for (const channel of this.channels) {
      const task = Promise.resolve()
        .then(() => channel.deliver(notifications))
        .catch((error: unknown) => {
          this.logger.error(
            `Channel "${channel.name}" failed for ${notifications.length} notification(s): ` +
              (error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
          );
        });
      this.inFlight.add(task);
      void task.finally(() => this.inFlight.delete(task));
    }
  }

  /** Resolves when every delivery started so far has finished (tests, shutdown). */
  async whenIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private async write(db: NotificationWriter, input: NotifyInput): Promise<NotifyResult> {
    const requested = [...new Set(input.recipientIds)];
    if (requested.length === 0) {
      return { created: [], skippedRecipientIds: [] };
    }
    const active = new Set(
      (
        await db.user.findMany({
          where: { id: { in: requested }, organizationId: input.organizationId, archivedAt: null },
          select: { id: true },
        })
      ).map((row) => row.id),
    );
    const recipients = requested.filter((id) => active.has(id));
    const skippedRecipientIds = requested.filter((id) => !active.has(id));
    if (recipients.length === 0) {
      return { created: [], skippedRecipientIds };
    }
    const title = clip(input.title, MAX_NOTIFICATION_TITLE_LENGTH);
    const body = clip(input.body, MAX_NOTIFICATION_BODY_LENGTH);
    const push = input.push
      ? {
          title: clip(input.push.title, MAX_NOTIFICATION_TITLE_LENGTH),
          body: clip(input.push.body, MAX_NOTIFICATION_BODY_LENGTH),
        }
      : null;
    const rows = await db.notification.createManyAndReturn({
      data: recipients.map((recipientId) => ({
        organizationId: input.organizationId,
        recipientId,
        type: input.type,
        title,
        body,
        data: input.data ?? {},
        sourceEventId: input.sourceEventId ?? null,
      })),
      skipDuplicates: true,
    });
    return {
      created: rows.map((row) => ({
        id: row.id,
        organizationId: row.organizationId,
        recipientId: row.recipientId,
        type: row.type,
        title: row.title,
        body: row.body,
        data: isRecord(row.data) ? row.data : {},
        push,
        createdAt: row.createdAt,
      })),
      skippedRecipientIds,
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
