/**
 * Authentication operations that OTHER modules call (the contract between the platform auth
 * module and the host application's user management). Business modules never touch credentials,
 * codes, sessions or tokens directly: they call these methods, inside their own transaction.
 *
 * Host requirements: the tables listed in ./auth-db.ts, reachable through the client or
 * transaction passed as `tx`.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { AuthCodePurpose, IssuedCode } from '@ops/shared';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../http/api-exception';
import { NOTIFICATION_SENDER, type NotificationSender } from '../notifications/notification-sender';
import { RequestContext } from '../request-context/request-context';
import type { AuthTx } from './auth-db';
import { AUTH_SETTINGS, isDevelopment, type AuthSettings } from './auth-settings';
import { AUTH_CLOCK, type Clock } from './clock';
import { normalizeCode, OneTimeCodes } from './one-time-codes';
import { PasswordHasher } from './password-hasher';
import { checkNewPassword } from './password-policy';
import { SessionService, type RevocationReason } from './sessions';

/** Why every session of a user is being ended. Stored on the session and in the audit event. */
export type SessionRevocationReason = RevocationReason;

export interface IssueCodeInput {
  userId: string;
  organizationId: string;
  purpose: AuthCodePurpose;
}

export interface RevokeSessionsInput {
  userId: string;
  organizationId: string;
  reason: SessionRevocationReason;
}

export interface SetPasswordInput {
  userId: string;
  organizationId: string;
  password: string;
}

/**
 * A database client or transaction. The auth module narrows it to the tables it needs; callers
 * pass the transaction of the change they are making so both commit or roll back together.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrowed inside the auth module
export type AuthDb = any;

const AUDIT_ENTITY = 'auth';

@Injectable()
export class AuthAdminService {
  constructor(
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    @Inject(AUTH_CLOCK) private readonly clock: Clock,
    private readonly codes: OneTimeCodes,
    private readonly sessions: SessionService,
    private readonly hasher: PasswordHasher,
    private readonly audit: AuditService,
    @Inject(NOTIFICATION_SENDER) private readonly sender: NotificationSender,
  ) {}

  /**
   * Issues a one-time code that lets the user set a password, invalidating any earlier unused
   * code of the same purpose, hands it to the notification sender, and writes the audit event.
   * The returned `code` and `link` are null outside development (see `issuedCodeSchema`).
   * The actor (the admin) is taken from the request context.
   *
   * The user must exist in the given organization and must not be archived (404 otherwise).
   * The notification sender is called before the caller's transaction commits; a sender that
   * really delivers must therefore tolerate a code whose transaction is later rolled back.
   */
  async issueOneTimeCode(tx: AuthDb, input: IssueCodeInput): Promise<IssuedCode> {
    const db = tx as AuthTx;
    const user = await db.user.findUnique({ where: { id: input.userId } });
    if (!user || user.organizationId !== input.organizationId || user.archivedAt !== null) {
      throw ApiException.notFound('User', input.userId);
    }

    const issued = await this.codes.issue(db, {
      userId: user.id,
      organizationId: user.organizationId,
      purpose: input.purpose,
      issuedById: RequestContext.actor()?.userId ?? null,
    });
    // The page reads the code from the query string; it is sent to the API in a request body.
    const link = `${this.settings.webAppUrl}/activate?code=${normalizeCode(issued.code)}`;

    await this.audit.record(db, {
      organizationId: user.organizationId,
      action: 'auth.code_issued',
      entityType: AUDIT_ENTITY,
      entityId: user.id,
      // The id of the stored code, never the code.
      after: { purpose: input.purpose, expiresAt: issued.expiresAt, issueId: issued.id },
    });

    await this.sender.sendOneTimeCode({
      user: {
        id: user.id,
        organizationId: user.organizationId,
        displayName: user.displayName,
        email: user.email,
        phone: user.phone,
      },
      purpose: input.purpose,
      code: issued.code,
      link,
      expiresAt: issued.expiresAt,
    });

    const reveal = isDevelopment(this.settings);
    return {
      purpose: input.purpose,
      expiresAt: issued.expiresAt.toISOString(),
      code: reveal ? issued.code : null,
      link: reveal ? link : null,
    };
  }

  /**
   * Ends every active session of the user immediately and writes the audit event. Returns how
   * many sessions were ended. Call it when a user is archived or loses a membership.
   *
   * It takes effect with the caller's transaction: from the commit on, the very next request of
   * any of those sessions is refused, because the guard reads the session on every request.
   * When nothing was active, nothing is recorded.
   */
  async revokeUserSessions(tx: AuthDb, input: RevokeSessionsInput): Promise<number> {
    const db = tx as AuthTx;
    const count = await this.sessions.revokeAllForUser(db, {
      userId: input.userId,
      organizationId: input.organizationId,
      reason: input.reason,
    });
    if (count > 0) {
      await this.audit.record(db, {
        organizationId: input.organizationId,
        action: input.reason === 'logout_all' ? 'auth.logout_all' : 'auth.session_revoked',
        entityType: AUDIT_ENTITY,
        entityId: input.userId,
        after: { reason: input.reason, sessions: count },
      });
    }
    return count;
  }

  /**
   * Sets a user's password directly, applying the password policy. For the development seed
   * only: real users set their own password with a one-time code. Refuses to run in production.
   * Writes no audit event. Throws a validation error when the policy refuses the password.
   */
  async setPasswordForSeed(tx: AuthDb, input: SetPasswordInput): Promise<void> {
    if (this.settings.nodeEnv !== 'development' && this.settings.nodeEnv !== 'test') {
      throw new Error('setPasswordForSeed is for development and test data only');
    }
    const db = tx as AuthTx;
    const user = await db.user.findUnique({ where: { id: input.userId } });
    if (!user || user.organizationId !== input.organizationId) {
      throw ApiException.notFound('User', input.userId);
    }
    const problems = checkNewPassword(input.password, user);
    if (problems.length > 0) {
      throw ApiException.validation(problems, 'The seed password does not meet the policy');
    }
    const passwordHash = await this.hasher.hash(input.password);
    const now = this.clock.now();
    await db.authCredential.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        organizationId: user.organizationId,
        passwordHash,
        passwordChangedAt: now,
      },
      update: { passwordHash, passwordChangedAt: now, failedAttempts: 0, lockedUntil: null },
    });
  }

  /**
   * Which of the given users have set a password, in one query (for lists). An empty input
   * answers an empty set without touching the database.
   */
  async activatedUserIds(tx: AuthDb, userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set();
    }
    const db = tx as AuthTx;
    const rows = await db.authCredential.findMany({
      where: { userId: { in: [...new Set(userIds)] } },
      select: { userId: true },
    });
    return new Set(rows.map((row) => row.userId));
  }

  /** True when the user has set a password (has been activated). */
  async isActivated(tx: AuthDb, userId: string): Promise<boolean> {
    const db = tx as AuthTx;
    return (await db.authCredential.findUnique({ where: { userId } })) !== null;
  }
}
