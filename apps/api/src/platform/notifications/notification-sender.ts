/**
 * Notification sender (reusable platform component).
 *
 * How the platform reaches a person outside the application (email, SMS). Delivery is not built
 * yet: `LoggingNotificationSender` is the default. A real sender is bound by providing another
 * implementation under `NOTIFICATION_SENDER`.
 *
 * Host requirements: none beyond a logger. The default implementation takes the environment
 * name as a constructor argument.
 */
import { Logger } from '@nestjs/common';

export interface NotificationRecipient {
  id: string;
  organizationId: string;
  displayName: string;
  email: string | null;
  phone: string | null;
}

export interface OneTimeCodeNotification {
  user: NotificationRecipient;
  purpose: 'activation' | 'password_reset';
  /** The code in clear. It exists only in this call: never store it, never log it in production. */
  code: string;
  /** A ready-made link to the web app's set-password page, with the code in it. */
  link: string;
  expiresAt: Date;
}

export interface NotificationSender {
  sendOneTimeCode(notification: OneTimeCodeNotification): Promise<void>;
}

export const NOTIFICATION_SENDER = Symbol('platform.notificationSender');

/**
 * The stand-in until email or SMS delivery exists. It logs that a code was issued, by user id.
 *
 * IN DEVELOPMENT ONLY it also logs the code and the link, so a developer can complete the flow.
 * In every other environment the code is never written anywhere, and a warning says that nobody
 * received it.
 */
export class LoggingNotificationSender implements NotificationSender {
  private readonly logger = new Logger('Notifications');

  constructor(private readonly nodeEnv: string) {}

  sendOneTimeCode(notification: OneTimeCodeNotification): Promise<void> {
    const subject = `${notification.purpose} code issued for user ${notification.user.id}`;
    if (this.nodeEnv === 'development') {
      this.logger.log(
        `${subject}, valid until ${notification.expiresAt.toISOString()} ` +
          `[development only] code: ${notification.code} link: ${notification.link}`,
      );
    } else {
      this.logger.log(subject);
      this.logger.warn(
        'No notification sender is configured: the code was NOT delivered to the user. ' +
          'Bind a real sender under NOTIFICATION_SENDER.',
      );
    }
    return Promise.resolve();
  }
}
