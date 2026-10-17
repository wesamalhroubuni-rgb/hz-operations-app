/**
 * The Expo push channel (reusable platform component).
 *
 * For each committed notification, one push message per live device token of the recipient
 * (`PushTokenService.deliverableTokens`). The message carries the notification's `push` text
 * when it has one (generic text for the lock screen; the full text stays in the in-app row),
 * else its title and body, and in `data` only ids: `notificationId`, `type`, and the notification's own `data`
 * (e.g. `taskId`). Nothing else of the person or the record travels through Apple, Google or
 * Expo.
 *
 * Tickets and receipts:
 * - The tickets of a send are read at once: `DeviceNotRegistered` removes the token; other
 *   errors are logged (masked).
 * - An accepted ticket is remembered IN MEMORY for its receipt. `checkReceipts` (every
 *   `receiptCheckIntervalMs`, for tickets at least `receiptDelayMs` old) fetches receipts in
 *   batches of 1000; `DeviceNotRegistered` removes the token. Tickets without a receipt after
 *   `receiptMaxAgeMs` are dropped. A restart forgets pending receipts (accepted: the token is
 *   then removed on the next failed send instead). Durable receipt tracking would need a table.
 *
 * Disabled (`PUSH_ENABLED` not exactly true) it does nothing at all: the in-app list still works.
 * Host requirements: `PushTokenService`, `EXPO_PUSH_CLIENT`, `EXPO_PUSH_CHANNEL_OPTIONS`.
 */
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import {
  EXPO_MAX_MESSAGES_PER_REQUEST,
  EXPO_MAX_RECEIPT_IDS_PER_REQUEST,
  EXPO_PUSH_CLIENT,
  maskPushToken,
  maskTokensIn,
  type ExpoErrorDetails,
  type ExpoPushClient,
  type ExpoPushMessage,
} from './expo-push-client';
import type { DeliverableNotification, NotificationChannel } from './notification-channel';
import { PushTokenService, type PushTokenRow } from './push-tokens.service';

export interface ExpoPushChannelOptions {
  enabled: boolean;
  /** Wait at least this long before asking for a receipt. Default 15 minutes. */
  receiptDelayMs?: number;
  /** Forget a ticket whose receipt never came after this long. Default 24 hours. */
  receiptMaxAgeMs?: number;
  /** How often pending receipts are checked. Default 5 minutes. */
  receiptCheckIntervalMs?: number;
  now?: () => number;
}

export const EXPO_PUSH_CHANNEL_OPTIONS = Symbol('platform.expoPushChannelOptions');

interface PendingReceipt {
  tokenId: string;
  token: string;
  sentAt: number;
}

export interface SendSummary {
  messages: number;
  accepted: number;
  failed: number;
  removedTokens: number;
}

const DEVICE_NOT_REGISTERED = 'DeviceNotRegistered';

/** True when Expo says the token can never receive again. */
export function isInvalidTokenError(message: string | undefined, details?: ExpoErrorDetails) {
  if (details?.error === DEVICE_NOT_REGISTERED) {
    return true;
  }
  return (
    typeof message === 'string' &&
    /is not a (valid Expo push token|registered push notification recipient)/i.test(message)
  );
}

function chunk<Item>(items: readonly Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

@Injectable()
export class ExpoPushChannel
  implements NotificationChannel, OnApplicationBootstrap, OnModuleDestroy
{
  readonly name = 'expo_push';
  private readonly logger = new Logger('ExpoPush');
  private readonly pendingReceipts = new Map<string, PendingReceipt>();
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tokens: PushTokenService,
    @Inject(EXPO_PUSH_CLIENT) private readonly client: ExpoPushClient,
    @Inject(EXPO_PUSH_CHANNEL_OPTIONS) private readonly options: ExpoPushChannelOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Tickets waiting for their receipt (tests and diagnostics). */
  get pendingReceiptCount(): number {
    return this.pendingReceipts.size;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      return;
    }
    const interval = this.options.receiptCheckIntervalMs ?? 5 * 60_000;
    this.timer = setInterval(() => {
      void this.checkReceipts().catch((error: unknown) => {
        this.logger.warn(`Receipt check failed: ${describe(error)}`);
      });
    }, interval);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async deliver(notifications: readonly DeliverableNotification[]): Promise<void> {
    await this.send(notifications);
  }

  /** Sends the pushes of these notifications and processes the tickets. Never throws. */
  async send(notifications: readonly DeliverableNotification[]): Promise<SendSummary> {
    const summary: SendSummary = { messages: 0, accepted: 0, failed: 0, removedTokens: 0 };
    if (!this.enabled || notifications.length === 0) {
      return summary;
    }
    let tokens: PushTokenRow[];
    try {
      tokens = await this.tokens.deliverableTokens(
        notifications.map((notification) => notification.recipientId),
      );
    } catch (error) {
      this.logger.error(`Could not load push tokens: ${describe(error)}`);
      return summary;
    }
    const byUser = new Map<string, PushTokenRow[]>();
    for (const row of tokens) {
      byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
    }
    const outgoing: Array<{ message: ExpoPushMessage; token: PushTokenRow }> = [];
    for (const notification of notifications) {
      for (const token of byUser.get(notification.recipientId) ?? []) {
        // A token rebound to another organization never receives this one's notifications.
        if (token.organizationId !== notification.organizationId) {
          continue;
        }
        outgoing.push({
          token,
          message: {
            to: token.token,
            title: notification.push?.title ?? notification.title,
            body: notification.push?.body ?? notification.body,
            data: {
              ...notification.data,
              notificationId: notification.id,
              type: notification.type,
            },
            sound: 'default',
            priority: 'high',
          },
        });
      }
    }
    summary.messages = outgoing.length;

    for (const batch of chunk(outgoing, EXPO_MAX_MESSAGES_PER_REQUEST)) {
      let tickets;
      try {
        tickets = await this.client.send(batch.map((item) => item.message));
      } catch (error) {
        summary.failed += batch.length;
        this.logger.error(`Push batch of ${batch.length} failed: ${describe(error)}`);
        continue;
      }
      const sentAt = this.now();
      for (const [index, ticket] of tickets.entries()) {
        const { token } = batch[index]!;
        if (ticket.status === 'ok') {
          summary.accepted += 1;
          this.pendingReceipts.set(ticket.id, { tokenId: token.id, token: token.token, sentAt });
          continue;
        }
        summary.failed += 1;
        if (isInvalidTokenError(ticket.message, ticket.details)) {
          summary.removedTokens += 1;
          await this.removeToken(token.id, token.token);
        } else {
          this.logger.warn(
            `Push to ${maskPushToken(token.token)} refused: ` +
              `${ticket.details?.error ?? 'error'} ${maskTokensIn(ticket.message ?? '')}`.trim(),
          );
        }
      }
    }
    return summary;
  }

  /**
   * Fetches the receipts of tickets at least `receiptDelayMs` old and removes the tokens Expo
   * reports as not registered. Returns how many tokens were removed.
   */
  async checkReceipts(): Promise<number> {
    const now = this.now();
    const delay = this.options.receiptDelayMs ?? 15 * 60_000;
    const maxAge = this.options.receiptMaxAgeMs ?? 24 * 60 * 60_000;
    const due = [...this.pendingReceipts.entries()].filter(
      ([, pending]) => now - pending.sentAt >= delay,
    );
    let removed = 0;
    for (const batch of chunk(due, EXPO_MAX_RECEIPT_IDS_PER_REQUEST)) {
      const receipts = await this.client.getReceipts(batch.map(([id]) => id));
      for (const [id, pending] of batch) {
        const receipt = receipts[id];
        if (!receipt) {
          if (now - pending.sentAt >= maxAge) {
            this.pendingReceipts.delete(id);
          }
          continue;
        }
        this.pendingReceipts.delete(id);
        if (receipt.status === 'ok') {
          continue;
        }
        if (isInvalidTokenError(receipt.message, receipt.details)) {
          removed += 1;
          await this.removeToken(pending.tokenId, pending.token);
        } else {
          this.logger.warn(
            `Push receipt for ${maskPushToken(pending.token)}: ` +
              `${receipt.details?.error ?? 'error'} ${maskTokensIn(receipt.message ?? '')}`.trim(),
          );
        }
      }
    }
    return removed;
  }

  private async removeToken(tokenId: string, token: string): Promise<void> {
    try {
      await this.tokens.removeInvalid(tokenId, token);
    } catch (error) {
      this.logger.warn(`Could not remove push token ${maskPushToken(token)}: ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${maskTokensIn(error.message)}` : 'error';
}
