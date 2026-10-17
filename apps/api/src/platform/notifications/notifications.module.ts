import { Global, Logger, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthTx } from '../auth/auth-db';
import { SessionService } from '../auth/sessions';
import { OutboxConsumer, OUTBOX_CONSUMER_OPTIONS } from '../outbox/outbox-consumer';
import type { OutboxConsumerOptions } from '../outbox/outbox-consumer';
import { DEFAULT_OUTBOX_CONSUMER_NAME } from '../outbox/outbox-consumer';
import { EXPO_PUSH_CLIENT, HttpExpoPushClient, type ExpoPushClient } from './expo-push-client';
import {
  EXPO_PUSH_CHANNEL_OPTIONS,
  ExpoPushChannel,
  type ExpoPushChannelOptions,
} from './expo-push.channel';
import { NOTIFICATION_CHANNELS, type NotificationChannel } from './notification-channel';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';
import { PushTokenService, type PushTokenStore } from './push-tokens.service';

/**
 * Notifications (reusable platform component): the notification-channel interface, the in-app
 * list (`/notifications`), device push tokens, the Expo push channel, and the outbox consumer
 * that hosts register event handlers with. Global: a host module injects `NotificationService`
 * and `OutboxConsumer` without importing anything.
 *
 * Host requirements: a global `PrismaService` (tables `notification`, `pushToken`,
 * `outboxConsumerCursor`, `outboxEvent`, `authSession`, `user`, `auditEvent`), a global
 * `ConfigService`, and `SessionService` and `AuditService` from the platform module.
 *
 * Configuration (each switch is on only when the value is exactly `true`, so a test
 * configuration that omits it leaves it off):
 * - `PUSH_ENABLED`: send pushes through Expo; `EXPO_ACCESS_TOKEN` optional;
 * - `OUTBOX_CONSUMER_ENABLED`, `OUTBOX_POLL_INTERVAL_MS`: the background consumer.
 *
 * Replaceable parts, by providing another value under the token: `EXPO_PUSH_CLIENT` (tests use
 * a fake), `NOTIFICATION_CHANNELS` (add email, SMS, ...), `OUTBOX_CONSUMER_OPTIONS`,
 * `EXPO_PUSH_CHANNEL_OPTIONS`.
 */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [
    NotificationService,
    NotificationInboxService,
    PushTokenService,
    {
      provide: EXPO_PUSH_CLIENT,
      useFactory: (config: ConfigService): ExpoPushClient =>
        new HttpExpoPushClient({ accessToken: config.get<string>('EXPO_ACCESS_TOKEN') }),
      inject: [ConfigService],
    },
    {
      provide: EXPO_PUSH_CHANNEL_OPTIONS,
      useFactory: (config: ConfigService): ExpoPushChannelOptions => ({
        enabled: config.get<unknown>('PUSH_ENABLED') === true,
      }),
      inject: [ConfigService],
    },
    ExpoPushChannel,
    {
      provide: NOTIFICATION_CHANNELS,
      useFactory: (push: ExpoPushChannel): NotificationChannel[] => [push],
      inject: [ExpoPushChannel],
    },
    {
      provide: OUTBOX_CONSUMER_OPTIONS,
      useFactory: (config: ConfigService): OutboxConsumerOptions => {
        const interval = config.get<unknown>('OUTBOX_POLL_INTERVAL_MS');
        return {
          name: DEFAULT_OUTBOX_CONSUMER_NAME,
          enabled: config.get<unknown>('OUTBOX_CONSUMER_ENABLED') === true,
          pollIntervalMs: typeof interval === 'number' ? interval : 2000,
        };
      },
      inject: [ConfigService],
    },
    OutboxConsumer,
  ],
  exports: [
    NotificationService,
    PushTokenService,
    ExpoPushChannel,
    OutboxConsumer,
    EXPO_PUSH_CLIENT,
    NOTIFICATION_CHANNELS,
  ],
})
export class NotificationsModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Notifications');
  private detach: (() => void) | null = null;

  constructor(
    private readonly sessions: SessionService,
    private readonly pushTokens: PushTokenService,
    private readonly push: ExpoPushChannel,
  ) {}

  onModuleInit(): void {
    // Ending a session removes its device push tokens, in the same transaction.
    this.detach = this.sessions.onSessionsEnded((tx: AuthTx, ended) =>
      this.pushTokens.sessionsEnded(tx as unknown as PushTokenStore, ended),
    );
    if (!this.push.enabled) {
      this.logger.log('Push notifications are off (PUSH_ENABLED); the in-app list still works');
    }
  }

  onModuleDestroy(): void {
    this.detach?.();
    this.detach = null;
  }
}
