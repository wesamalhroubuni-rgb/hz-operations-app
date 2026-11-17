import { Module } from '@nestjs/common';
import { NotificationResolutionService } from './notification-resolution.service';
import { OperationsNotificationsService } from './operations-notifications.service';

/**
 * The Operations rules that turn domain events into notifications (task assigned, log approved
 * or rejected), and the rules that clear them once they ask for nothing more. Uses the platform's
 * global `OutboxConsumer` and `NotificationService`.
 */
@Module({
  providers: [OperationsNotificationsService, NotificationResolutionService],
  exports: [OperationsNotificationsService, NotificationResolutionService],
})
export class OperationsNotificationsModule {}
