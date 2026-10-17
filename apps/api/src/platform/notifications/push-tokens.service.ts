/**
 * Device push tokens (reusable platform component).
 *
 * Lifecycle:
 * - REGISTER (`POST /notifications/push-tokens`): the token is bound to the caller AND to the
 *   session of the request. Upsert by token: the same token for the same session only refreshes
 *   `lastSeenAt` (nothing audited); a token known for another session or user (a phone that
 *   changed hands, or signed in again) is removed there and registered here. A session holds one
 *   token: registering a different token for the same session replaces the old one.
 * - UNREGISTER (`DELETE /notifications/push-tokens/:token`): only one's own token; any other
 *   answers 404, exactly like an unknown token.
 * - SESSION END: every way a session ends (logout, logout-all, ending one session, refresh-token
 *   reuse, password change or reset, archiving, membership removal) goes through
 *   `SessionService`, which calls `sessionsEnded` INSIDE the transaction that ends the sessions:
 *   the tokens disappear with the same commit.
 * - DELIVERY: `deliverableTokens` only returns tokens whose session is still live (not revoked,
 *   not expired); tokens of a dead session are removed on the spot (covers expiry, which has no
 *   event, and a registration that raced with a logout).
 * - EXPO SAYS INVALID: `removeInvalid` (DeviceNotRegistered in a ticket or a receipt).
 *
 * Every registration and removal is a security-relevant device change and is audited
 * (`push_token.registered`, `push_token.removed` with the reason). The audit holds the token's
 * row id, the platform, the session and the last six characters of the token, never the token.
 *
 * Host requirements: a global `PrismaService` with the `pushToken`, `authSession` and
 * `auditEvent` tables; `AuditService`.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { RegisterPushToken } from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService, type AuditWriter } from '../audit/audit.service';
import type { EndedSessions } from '../auth/sessions';
import { ApiException } from '../http';
import type { RequestActor } from '../request-context/request-context';
import { maskPushToken } from './expo-push-client';

export type PushTokenRemovalReason =
  'unregistered' | 'session_ended' | 'rebound' | 'replaced' | 'device_not_registered';

export interface PushTokenRow {
  id: string;
  organizationId: string;
  userId: string;
  sessionId: string | null;
  token: string;
  platform: 'ios' | 'android';
  createdAt: Date;
  lastSeenAt: Date;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- query arguments are the ORM's own shapes */
/** The slice of a database client (or transaction) push tokens are kept through. */
export interface PushTokenStore extends AuditWriter {
  pushToken: {
    findUnique(args: any): PromiseLike<PushTokenRow | null>;
    findFirst(args: any): PromiseLike<PushTokenRow | null>;
    findMany(args: any): PromiseLike<PushTokenRow[]>;
    create(args: any): PromiseLike<PushTokenRow>;
    update(args: any): PromiseLike<PushTokenRow>;
    deleteMany(args: any): PromiseLike<{ count: number }>;
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const AUDIT_ENTITY = 'push_token';

function describeToken(row: PushTokenRow) {
  return {
    userId: row.userId,
    sessionId: row.sessionId,
    platform: row.platform,
    suffix: maskPushToken(row.token),
  };
}

@Injectable()
export class PushTokenService {
  private readonly logger = new Logger('PushTokens');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private get store(): PushTokenStore {
    return this.prisma as unknown as PushTokenStore;
  }

  /** Binds the token to the caller and the caller's session. Idempotent. */
  async register(actor: RequestActor, input: RegisterPushToken): Promise<void> {
    const sessionId = actor.sessionId ?? null;
    await this.prisma.$transaction(async (transaction) => {
      const tx = transaction as unknown as PushTokenStore;
      const now = new Date();
      const existing = await tx.pushToken.findUnique({ where: { token: input.token } });
      const sameOwner =
        existing !== null &&
        existing.userId === actor.userId &&
        existing.organizationId === actor.organizationId &&
        existing.sessionId === sessionId;

      if (sessionId !== null) {
        const others = await tx.pushToken.findMany({
          where: { sessionId, token: { not: input.token } },
        });
        await this.removeRows(tx, others, 'replaced');
      }

      if (sameOwner) {
        await tx.pushToken.update({
          where: { id: existing.id },
          data: { lastSeenAt: now, platform: input.platform },
        });
        return;
      }
      if (existing) {
        await this.removeRows(tx, [existing], 'rebound');
      }
      const row = await tx.pushToken.create({
        data: {
          organizationId: actor.organizationId,
          userId: actor.userId,
          sessionId,
          token: input.token,
          platform: input.platform,
          createdAt: now,
          lastSeenAt: now,
        },
      });
      await this.audit.record(tx, {
        organizationId: row.organizationId,
        action: 'push_token.registered',
        entityType: AUDIT_ENTITY,
        entityId: row.id,
        after: describeToken(row),
      });
    });
  }

  /** Removes one of the caller's own tokens. Another user's token answers 404. */
  async unregister(actor: RequestActor, token: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const tx = transaction as unknown as PushTokenStore;
      const row = await tx.pushToken.findFirst({
        where: { token, userId: actor.userId, organizationId: actor.organizationId },
      });
      if (!row) {
        throw ApiException.notFound('Push token');
      }
      await this.removeRows(tx, [row], 'unregistered');
    });
  }

  /**
   * The session-end hook (registered with `SessionService`): removes the tokens of the sessions
   * that have just ended, inside the same transaction.
   */
  async sessionsEnded(tx: PushTokenStore, ended: EndedSessions): Promise<void> {
    const where =
      ended.kind === 'session'
        ? { sessionId: ended.sessionId }
        : {
            userId: ended.userId,
            ...(ended.organizationId ? { organizationId: ended.organizationId } : {}),
            ...(ended.exceptSessionId
              ? { OR: [{ sessionId: null }, { sessionId: { not: ended.exceptSessionId } }] }
              : {}),
          };
    const rows = await tx.pushToken.findMany({ where });
    await this.removeRows(tx, rows, 'session_ended');
  }

  /**
   * The tokens to push to for these users: only those whose session is still live. Tokens of a
   * revoked or expired session are removed here.
   */
  async deliverableTokens(userIds: readonly string[]): Promise<PushTokenRow[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.store.pushToken.findMany({
      where: { userId: { in: [...new Set(userIds)] } },
    });
    const sessionIds = [
      ...new Set(rows.flatMap((row) => (row.sessionId === null ? [] : [row.sessionId]))),
    ];
    const live =
      sessionIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await this.prisma.authSession.findMany({
                where: { id: { in: sessionIds }, revokedAt: null, expiresAt: { gt: new Date() } },
                select: { id: true },
              })
            ).map((session) => session.id),
          );
    const dead = rows.filter((row) => row.sessionId !== null && !live.has(row.sessionId));
    if (dead.length > 0) {
      await this.prisma.$transaction(async (transaction) => {
        await this.removeRows(transaction as unknown as PushTokenStore, dead, 'session_ended');
      });
    }
    return rows.filter((row) => row.sessionId === null || live.has(row.sessionId));
  }

  /** Expo reported the token as no longer valid. Matches id AND token (it may have moved). */
  async removeInvalid(tokenId: string, token: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const tx = transaction as unknown as PushTokenStore;
      const row = await tx.pushToken.findFirst({ where: { id: tokenId, token } });
      if (row) {
        await this.removeRows(tx, [row], 'device_not_registered');
        this.logger.log(`Removed push token ${maskPushToken(token)}: Expo reports it invalid`);
      }
    });
  }

  private async removeRows(
    tx: PushTokenStore,
    rows: readonly PushTokenRow[],
    reason: PushTokenRemovalReason,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await tx.pushToken.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
    for (const row of rows) {
      await this.audit.record(tx, {
        organizationId: row.organizationId,
        action: 'push_token.removed',
        entityType: AUDIT_ENTITY,
        entityId: row.id,
        before: describeToken(row),
        after: { reason },
      });
    }
  }
}
