import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';

// The wire contract of the reusable notifications component: the signed-in user's in-app list
// and the registration of their device for push notifications.

/** A message in the signed-in user's in-app list. `data` says what to open (e.g. `taskId`). */
export const notificationSchema = z.object({
  id: idSchema,
  /** Dotted kind, e.g. `task.assigned`, `work_log.approved`, `work_log.rejected`. */
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()),
  readAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type AppNotification = z.infer<typeof notificationSchema>;

export const NOTIFICATION_SORT_FIELDS = ['createdAt'] as const;

export const listNotificationsQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(NOTIFICATION_SORT_FIELDS, { field: 'createdAt', direction: 'desc' }),
  /** true: only unread ones. */
  unread: queryBooleanSchema.optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

/** The list envelope plus how many of the user's notifications are unread in total. */
export const notificationListSchema = paginatedSchema(notificationSchema).extend({
  unreadCount: z.number().int().min(0),
});
export type NotificationList = Paginated<AppNotification> & { unreadCount: number };

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export const pushPlatformSchema = z.enum(PUSH_PLATFORMS);
export type PushPlatform = z.infer<typeof pushPlatformSchema>;

/** Registers this device for push notifications, tied to the current session. */
export const registerPushTokenSchema = z.strictObject({
  /** The Expo push token, e.g. `ExponentPushToken[xxxxxxxx]`. */
  token: z
    .string()
    .trim()
    .max(200)
    .regex(/^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/, {
      error: 'must be an Expo push token',
    }),
  platform: pushPlatformSchema,
});
export type RegisterPushToken = z.infer<typeof registerPushTokenSchema>;

const emptySchema = z.unknown();

export function notificationsEndpoints(transport: ApiTransport) {
  return {
    list(
      query: { page?: number; pageSize?: number; unread?: boolean } = {},
    ): Promise<ApiResult<NotificationList>> {
      return transport.request({ path: '/notifications', query, schema: notificationListSchema });
    },
    markRead(id: string): Promise<ApiResult<AppNotification>> {
      return transport.request({
        method: 'POST',
        path: `/notifications/${id}/read`,
        schema: notificationSchema,
      });
    },
    markAllRead(): Promise<ApiResult<unknown>> {
      return transport.request({
        method: 'POST',
        path: '/notifications/read-all',
        schema: emptySchema,
      });
    },
    registerPushToken(body: RegisterPushToken): Promise<ApiResult<unknown>> {
      return transport.request({
        method: 'POST',
        path: '/notifications/push-tokens',
        body,
        schema: emptySchema,
      });
    },
    /** Unregisters this device (also done by the API on sign-out). */
    unregisterPushToken(token: string): Promise<ApiResult<unknown>> {
      return transport.request({
        method: 'DELETE',
        path: `/notifications/push-tokens/${encodeURIComponent(token)}`,
        schema: emptySchema,
      });
    },
  };
}
