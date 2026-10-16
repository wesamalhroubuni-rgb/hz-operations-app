import type { AccessTokenService } from './access-token';
import type { AuthClientValue, AuthSessionRow, AuthTx } from './auth-db';
import type { AuthSettings } from './auth-settings';
import type { Clock, RandomSource } from './clock';
import { sha256Hex } from './hashing';

/**
 * Sessions and their refresh tokens.
 *
 * A session is one sign-in on one device. It carries a chain ("family") of refresh tokens, each
 * 256 random bits, stored as SHA-256, used once and replaced.
 *
 * Expiry:
 * - sliding: each refresh token lives `refreshTokenTtl` (30 days), so a session nobody uses for
 *   that long can no longer be renewed;
 * - absolute: `session.expiresAt` is fixed at sign-in (`sessionAbsoluteTtl`, 90 days) and never
 *   moves; no refresh token outlives it.
 *
 * Rotation and the race rule (`rotate`):
 * - The token is marked used with a conditional update (`WHERE usedAt IS NULL`), so when two
 *   requests present the same token at the same moment the database lets exactly one of them
 *   win. The winner gets the next token.
 * - A token that is presented after it was used is refused. If that happens within
 *   `refreshReuseGrace` (10 seconds) of its use, it is treated as the loser of such a race, two
 *   browser tabs renewing at once: the request fails, nothing is issued, and the session lives
 *   on with the winner's token. Later than that, it is reuse of a stolen or replayed token: the
 *   whole session is revoked (`refresh_reuse`), which also stops whoever holds the newer token.
 * - The cost of the grace: a thief who replays a token within those seconds of the rightful
 *   use is not detected by that replay (and gets nothing from it). Set the grace to 0 to treat
 *   every replay as reuse.
 */

export const REFRESH_TOKEN_BYTES = 32;
const MAX_REFRESH_TOKEN_LENGTH = 512;

export type RevocationReason =
  | 'logout'
  | 'logout_all'
  | 'refresh_reuse'
  | 'user_archived'
  | 'membership_removed'
  | 'password_changed'
  | 'admin_revoked'
  | 'expired';

export interface CreateSessionArgs {
  userId: string;
  organizationId: string;
  client: AuthClientValue;
  deviceName?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}

/** What a client needs to use a session. The tokens exist in clear only here. */
export interface SessionGrant {
  session: AuthSessionRow;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export type RotationFailure =
  /** No such token, or it is malformed. */
  | 'unknown'
  /** The token or its session has expired. */
  | 'expired'
  /** The session was ended, or its user is gone or archived. */
  | 'revoked'
  /** Lost a race with another refresh of the same token (see the race rule). Nothing revoked. */
  | 'raced'
  /** A used token came back: the session has just been revoked. */
  | 'reuse';

export type RotationResult =
  | { ok: true; grant: SessionGrant }
  | { ok: false; reason: RotationFailure; session: AuthSessionRow | null };

function truncate(value: string | null | undefined, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

export class SessionService {
  constructor(
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly settings: Pick<
      AuthSettings,
      'refreshTokenTtlMs' | 'sessionAbsoluteTtlMs' | 'refreshReuseGraceMs'
    >,
    private readonly accessTokens: AccessTokenService,
  ) {}

  /** Starts a session and issues its first tokens. */
  async create(tx: AuthTx, args: CreateSessionArgs): Promise<SessionGrant> {
    const now = this.clock.now();
    const session = await tx.authSession.create({
      data: {
        userId: args.userId,
        organizationId: args.organizationId,
        client: args.client,
        deviceName: truncate(args.deviceName, 100),
        userAgent: truncate(args.userAgent, 300),
        ipAddress: truncate(args.ipAddress, 64),
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + this.settings.sessionAbsoluteTtlMs),
      },
    });
    return this.issue(tx, session, now);
  }

  /**
   * Exchanges a refresh token for the next one. Never throws for a bad token: the caller gets
   * the reason, so whatever was revoked here commits with the caller's transaction.
   */
  async rotate(tx: AuthTx, rawToken: string): Promise<RotationResult> {
    if (rawToken.length === 0 || rawToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      return { ok: false, reason: 'unknown', session: null };
    }
    const token = await tx.authRefreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
    });
    if (!token) {
      return { ok: false, reason: 'unknown', session: null };
    }
    const session = await tx.authSession.findUnique({ where: { id: token.sessionId } });
    if (!session) {
      return { ok: false, reason: 'unknown', session: null };
    }
    const now = this.clock.now();
    if (session.revokedAt !== null) {
      return { ok: false, reason: 'revoked', session };
    }
    if (session.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'expired', session };
    }

    if (token.usedAt !== null) {
      const grace = this.settings.refreshReuseGraceMs;
      if (grace > 0 && now.getTime() - token.usedAt.getTime() <= grace) {
        return { ok: false, reason: 'raced', session };
      }
      await this.revoke(tx, session.id, 'refresh_reuse');
      return { ok: false, reason: 'reuse', session };
    }
    if (token.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'expired', session };
    }

    const user = await tx.user.findUnique({ where: { id: session.userId } });
    if (!user || user.archivedAt !== null || user.organizationId !== session.organizationId) {
      return { ok: false, reason: 'revoked', session };
    }

    // The single-use step. Of any number of concurrent requests, exactly one matches.
    const { count } = await tx.authRefreshToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: now },
    });
    if (count !== 1) {
      if (this.settings.refreshReuseGraceMs > 0) {
        return { ok: false, reason: 'raced', session };
      }
      await this.revoke(tx, session.id, 'refresh_reuse');
      return { ok: false, reason: 'reuse', session };
    }

    const touched = await tx.authSession.update({
      where: { id: session.id },
      data: { lastUsedAt: now },
    });
    return { ok: true, grant: await this.issue(tx, touched, now) };
  }

  /** The session, when it exists and is neither revoked nor expired. */
  async findActive(tx: AuthTx, sessionId: string): Promise<AuthSessionRow | null> {
    const session = await tx.authSession.findUnique({ where: { id: sessionId } });
    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= this.clock.now().getTime()
    ) {
      return null;
    }
    return session;
  }

  /** The session a refresh token belongs to, whatever the state of either. For logout. */
  async findByRefreshToken(tx: AuthTx, rawToken: string): Promise<AuthSessionRow | null> {
    if (rawToken.length === 0 || rawToken.length > MAX_REFRESH_TOKEN_LENGTH) {
      return null;
    }
    const token = await tx.authRefreshToken.findUnique({
      where: { tokenHash: sha256Hex(rawToken) },
    });
    return token ? tx.authSession.findUnique({ where: { id: token.sessionId } }) : null;
  }

  /** The user's sessions that can still be used, most recently used first. */
  async listActive(tx: AuthTx, userId: string): Promise<AuthSessionRow[]> {
    return tx.authSession.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: this.clock.now() } },
      orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** Ends one session. False when it was already ended (nothing changes then). */
  async revoke(tx: AuthTx, sessionId: string, reason: RevocationReason): Promise<boolean> {
    const { count } = await tx.authSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    return count === 1;
  }

  /** Ends every live session of a user, optionally sparing one. Returns how many ended. */
  async revokeAllForUser(
    tx: AuthTx,
    args: {
      userId: string;
      organizationId?: string;
      reason: RevocationReason;
      exceptSessionId?: string | null;
    },
  ): Promise<number> {
    const { count } = await tx.authSession.updateMany({
      where: {
        userId: args.userId,
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        revokedAt: null,
        ...(args.exceptSessionId ? { id: { not: args.exceptSessionId } } : {}),
      },
      data: { revokedAt: this.clock.now(), revokedReason: args.reason },
    });
    return count;
  }

  private async issue(tx: AuthTx, session: AuthSessionRow, now: Date): Promise<SessionGrant> {
    const refreshToken = this.random.bytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshTokenExpiresAt = new Date(
      Math.min(now.getTime() + this.settings.refreshTokenTtlMs, session.expiresAt.getTime()),
    );
    await tx.authRefreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: sha256Hex(refreshToken),
        createdAt: now,
        expiresAt: refreshTokenExpiresAt,
      },
    });
    const access = this.accessTokens.sign({
      sub: session.userId,
      org: session.organizationId,
      sid: session.id,
    });
    return {
      session,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken,
      refreshTokenExpiresAt,
    };
  }
}
