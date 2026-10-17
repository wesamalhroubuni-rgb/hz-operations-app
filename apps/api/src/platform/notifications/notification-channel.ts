/**
 * The notification-channel interface (reusable platform component).
 *
 * A notification is first written as a row of the recipient's in-app list (`Notification`):
 * that row IS the in-app channel, always on, and the source of truth. Every other way of
 * reaching the person (Expo push today; email, SMS, chat later) is a `NotificationChannel` that
 * receives the rows AFTER they are committed. A channel must never throw into its caller and
 * never block a business transaction; `NotificationService` calls channels outside any
 * transaction and logs what they throw.
 *
 * Host requirements: none. Register channels under `NOTIFICATION_CHANNELS` (an array).
 */

/** A committed in-app notification, as handed to the delivery channels. */
export interface DeliverableNotification {
  id: string;
  organizationId: string;
  recipientId: string;
  /** Dotted kind, e.g. `task.assigned`. */
  type: string;
  title: string;
  body: string;
  /** What a client needs to open the right screen (ids only, never personal data). */
  data: Record<string, unknown>;
  /**
   * Text for channels that show it outside the app (a push on a lock screen, a preview), used
   * INSTEAD of `title` / `body` when set: the in-app row keeps the full text, the push says only
   * that there is something to open. Not stored; only the call that created the row carries it.
   */
  push?: NotificationPushText | null;
  createdAt: Date;
}

/** Generic, non-sensitive text for out-of-app channels. */
export interface NotificationPushText {
  title: string;
  body: string;
}

export interface NotificationChannel {
  /** Short name for logs and configuration, e.g. `expo_push`. */
  readonly name: string;
  /**
   * Delivers a batch of committed notifications (any recipients, any organizations). Should
   * handle its own errors; whatever it throws is logged and dropped, never retried by the caller.
   */
  deliver(notifications: readonly DeliverableNotification[]): Promise<void>;
}

export const NOTIFICATION_CHANNELS = Symbol('platform.notificationChannels');
