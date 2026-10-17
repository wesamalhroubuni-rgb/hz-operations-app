/**
 * The signed-in user's in-app notification list (reusable platform component).
 *
 * Self-service and role-agnostic: every query is limited to the acting user and organization
 * (`requireActor()`), so a notification of somebody else is answered exactly like one that does
 * not exist (404). Marking as read is not audited: notifications are derived data.
 *
 * Host requirements: a global `PrismaService` with the `notification` table; an acting user in
 * `RequestContext`.
 */
import { Injectable } from '@nestjs/common';
import type { AppNotification, ListNotificationsQuery, NotificationList } from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiException, orderByArgs, pageArgs, paginated, requireActor } from '../http';

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  data: unknown;
  readAt: Date | null;
  createdAt: Date;
}

export function toAppNotification(row: NotificationRow): AppNotification {
  const data =
    typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)
      ? (row.data as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    data,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class NotificationInboxService {
  constructor(private readonly prisma: PrismaService) {}

  private ownWhere() {
    const actor = requireActor();
    return { recipientId: actor.userId, organizationId: actor.organizationId };
  }

  async list(query: ListNotificationsQuery): Promise<NotificationList> {
    const own = this.ownWhere();
    const where = query.unread === true ? { ...own, readAt: null } : own;
    const [rows, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { ...own, readAt: null } }),
    ]);
    return { ...paginated(rows.map(toAppNotification), total, query), unreadCount };
  }

  /** Marks one of the caller's notifications read. Already read keeps its first `readAt`. */
  async markRead(id: string): Promise<AppNotification> {
    const own = this.ownWhere();
    await this.prisma.notification.updateMany({
      where: { ...own, id, readAt: null },
      data: { readAt: new Date() },
    });
    const row = await this.prisma.notification.findFirst({ where: { ...own, id } });
    if (!row) {
      throw ApiException.notFound('Notification', id);
    }
    return toAppNotification(row);
  }

  /** Marks every unread notification of the caller read. Returns how many changed. */
  async markAllRead(): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { ...this.ownWhere(), readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }
}
