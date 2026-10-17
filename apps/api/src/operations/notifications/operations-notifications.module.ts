import { Module } from '@nestjs/common';
import { OperationsNotificationsService } from './operations-notifications.service';

/**
 * The Operations rules that turn domain events into notifications (task assigned, log approved
 * or rejected). Uses the platform's global `OutboxConsumer` and `NotificationService`.
 */
@Module({
  providers: [OperationsNotificationsService],
  exports: [OperationsNotificationsService],
})
export class OperationsNotificationsModule {}
