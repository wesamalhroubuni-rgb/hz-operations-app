/**
 * Sign-in, session renewal, sign-out and password setting (reusable platform component).
 *
 * This class holds the rules; the controller only translates HTTP (cookies, headers) to and from
 * it. It has no framework dependencies: construct it with `new AuthService({...})` in a test,
 * with a fake database, a fixed clock and a predictable random source.
 *
 * Host requirements: see ./auth-db.ts (tables) and ./auth-settings.ts (configuration). The
 * host may provide an `AuthProfileProvider` (roles and organization name of a user); without
 * one, users are described with no roles and the organization name read from the database.
 *
 * What never leaves this module: passwords, password hashes, one-time codes, refresh tokens.
 * None of them is ever put in an audit event, a log line or an error message.
 */
import type {
  AuthSession,
  AuthUser,
  ChangePasswordRequest,
  LoginRequest,
  SetPasswordRequest,
} from '@ops/shared';
import type { AuditService } from '../audit/audit.service';
import { ApiException } from '../http/api-exception';
import { RequestContext, type RequestActor } from '../request-context/request-context';
import type { AccessTokenService } from './access-token';
import type { AuthDatabase, AuthSessionRow, AuthUserRow } from './auth-db';
import type { AuthProfile, AuthProfileProvider } from './auth-profile';
import type { AuthSettings } from './auth-settings';
import type { Clock } from './clock';
import { deriveKey, hmacSha256, sha256Hex } from './hashing';
import { parseLoginIdentifier, type LoginIdentifier } from './identifiers';
import { hashCode, type OneTimeCodes } from './one-time-codes';
import type { PasswordHasher } from './password-hasher';
import { checkNewPassword } from './password-policy';
import type { RateLimiter, RateLimitRule } from './rate-limiter';
import type { SessionGrant, SessionService } from './sessions';

/** Entity type of every security audit event. */
export const AUTH_AUDIT_ENTITY = 'auth';

/**
 * The one answer to every failed sign-in and every request without a valid session. It is the
 * same whether the account exists, is locked, is archived, has no password yet, or the password
 * is simply wrong, so the answer reveals nothing about any account.
 */
export const GENERIC_SIGN_IN_FAILURE = 'The sign-in details are not correct';
export const GENERIC_UNAUTHENTICATED = 'Sign in to continue';
export const GENERIC_CODE_FAILURE = 'This code is not valid or has expired';

/** What the HTTP layer knows about the caller. */
export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface LoginResult {
  user: AuthUser;
  grant: SessionGrant;
}

export type RefreshResult =
  | { ok: true; grant: SessionGrant }
  /** `keepCookies`: the request lost a race against another refresh; the cookies are current. */
  | { ok: false; keepCookies: boolean };

export interface AuthServiceDeps {
  db: AuthDatabase;
  settings: AuthSettings;
  clock: Clock;
  hasher: PasswordHasher;
  accessTokens: AccessTokenService;
  sessions: SessionService;
  codes: OneTimeCodes;
  audit: AuditService;
  limiter: RateLimiter;
  profiles?: AuthProfileProvider | null;
}

type FailedLoginReason = 'unknown_identifier' | 'not_activated' | 'locked' | 'bad_password';

export class AuthService {
  private readonly db: AuthDatabase;
  private readonly settings: AuthSettings;
  private readonly clock: Clock;
  private readonly hasher: PasswordHasher;
  private readonly accessTokens: AccessTokenService;
  private readonly sessions: SessionService;
  private readonly codes: OneTimeCodes;
  private readonly audit: AuditService;
  private readonly limiter: RateLimiter;
  private readonly profiles: AuthProfileProvider | null;
  private readonly fingerprintKey: Buffer;

  constructor(deps: AuthServiceDeps) {
    this.db = deps.db;
    this.settings = deps.settings;
    this.clock = deps.clock;
    this.hasher = deps.hasher;
    this.accessTokens = deps.accessTokens;
    this.sessions = deps.sessions;
    this.codes = deps.codes;
    this.audit = deps.audit;
    this.limiter = deps.limiter;
    this.profiles = deps.profiles ?? null;
    this.fingerprintKey = deriveKey(deps.settings.secret, 'identifier-fingerprint/v1');
  }

  // -------------------------------------------------------------------------------------------
  // Sign-in
  // -------------------------------------------------------------------------------------------

  async login(input: LoginRequest, meta: RequestMeta): Promise<LoginResult> {
    const identifier = parseLoginIdentifier(input.identifier);
    const fingerprint = this.fingerprint(identifier, input.organizationSlug);
    const limits = this.settings.rateLimits;
    await this.limit(`login:ip:${meta.ip ?? 'unknown'}`, limits.loginPerIp);
    await this.limit(`login:id:${fingerprint}`, limits.loginPerIdentifier);

    const user = await this.findUserForLogin(identifier, input.organizationSlug);
    const credential = user
      ? await this.db.authCredential.findUnique({ where: { userId: user.id } })
      : null;

    if (!user || !credential) {
      // Equal work for an account that does not exist or has no password yet.
      await this.hasher.verifyAgainstNothing(input.password);
      await this.recordFailedLogin(
        user,
        identifier,
        fingerprint,
        user ? 'not_activated' : 'unknown_identifier',
      );
      throw ApiException.unauthenticated(GENERIC_SIGN_IN_FAILURE);
    }

    const now = this.clock.now();
    const locked = credential.lockedUntil !== null && credential.lockedUntil > now;
    // Verified even when the account is locked, so a locked account takes as long to answer.
    const matches = await this.hasher.verify(credential.passwordHash, input.password);

    if (locked) {
      // Attempts made during the lock neither count nor extend it.
      await this.recordFailedLogin(user, identifier, fingerprint, 'locked');
      throw ApiException.unauthenticated(GENERIC_SIGN_IN_FAILURE);
    }

    if (!matches) {
      // Concurrent failures must not undo a lock: the lock was decided above, before the slow
      // hash check, so another request may have locked the account meanwhile. The increment is
      // therefore conditional on no lock being in force (PostgreSQL re-checks the condition on
      // the latest row version once a concurrent writer commits), and a request that finds the
      // account locked by then is recorded as a locked attempt and changes nothing.
      const counted = await this.db.$transaction(async (tx) => {
        const bumped = await tx.authCredential.updateMany({
          where: {
            userId: user.id,
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
          },
          data: { failedAttempts: { increment: 1 }, lockedUntil: null },
        });
        if (bumped.count === 0) {
          return false;
        }
        const updated = await tx.authCredential.findUnique({ where: { userId: user.id } });
        await this.audit.record(tx, {
          organizationId: user.organizationId,
          action: 'auth.login_failed',
          entityType: AUTH_AUDIT_ENTITY,
          entityId: user.id,
          after: { reason: 'bad_password' satisfies FailedLoginReason, kind: identifier.kind },
        });
        if (updated && updated.failedAttempts >= this.settings.maxFailedLogins) {
          const lockedUntil = new Date(now.getTime() + this.settings.lockoutMs);
          await tx.authCredential.update({
            where: { userId: user.id },
            data: { failedAttempts: 0, lockedUntil },
          });
          await this.audit.record(tx, {
            organizationId: user.organizationId,
            action: 'auth.locked_out',
            entityType: AUTH_AUDIT_ENTITY,
            entityId: user.id,
            after: { lockedUntil, failedAttempts: updated.failedAttempts },
          });
        }
        return true;
      });
      if (!counted) {
        await this.recordFailedLogin(user, identifier, fingerprint, 'locked');
      }
      throw ApiException.unauthenticated(GENERIC_SIGN_IN_FAILURE);
    }

    const grant = await this.db.$transaction(async (tx) => {
      await tx.authCredential.update({
        where: { userId: user.id },
        data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: now },
      });
      const created = await this.sessions.create(tx, {
        userId: user.id,
        organizationId: user.organizationId,
        client: input.client,
        deviceName: input.deviceName ?? null,
        userAgent: meta.userAgent,
        ipAddress: meta.ip,
      });
      this.actAs({
        userId: user.id,
        organizationId: user.organizationId,
        sessionId: created.session.id,
      });
      await this.audit.record(tx, {
        organizationId: user.organizationId,
        action: 'auth.login_succeeded',
        entityType: AUTH_AUDIT_ENTITY,
        entityId: created.session.id,
        after: { userId: user.id, client: input.client, kind: identifier.kind },
      });
      return created;
    });

    return { user: await this.describeUser(user), grant };
  }

  // -------------------------------------------------------------------------------------------
  // Renewal
  // -------------------------------------------------------------------------------------------

  async refresh(
    rawToken: string | null,
    meta: RequestMeta,
    via: 'cookie' | 'body',
  ): Promise<RefreshResult> {
    const limits = this.settings.rateLimits;
    await this.limit(`refresh:ip:${meta.ip ?? 'unknown'}`, limits.refreshPerIp);
    if (!rawToken) {
      return { ok: false, keepCookies: false };
    }
    await this.limit(`refresh:token:${sha256Hex(rawToken).slice(0, 32)}`, limits.refreshPerToken);

    // A web session is renewed from its cookie only, a mobile session from the body only.
    const owner = await this.sessions.findByRefreshToken(this.db, rawToken);
    if (owner && (owner.client === 'web') !== (via === 'cookie')) {
      return { ok: false, keepCookies: false };
    }

    const result = await this.db.$transaction(async (tx) => {
      const rotation = await this.sessions.rotate(tx, rawToken);
      if (!rotation.ok && rotation.reason === 'reuse' && rotation.session) {
        // Committed together with the revocation: `rotate` reports, it does not throw.
        await this.audit.record(tx, {
          organizationId: rotation.session.organizationId,
          action: 'auth.refresh_reuse_detected',
          entityType: AUTH_AUDIT_ENTITY,
          entityId: rotation.session.id,
          after: { userId: rotation.session.userId, client: rotation.session.client },
        });
      }
      return rotation;
    });

    if (!result.ok) {
      return { ok: false, keepCookies: result.reason === 'raced' };
    }
    const { session } = result.grant;
    this.actAs({
      userId: session.userId,
      organizationId: session.organizationId,
      sessionId: session.id,
    });
    return { ok: true, grant: result.grant };
  }

  // -------------------------------------------------------------------------------------------
  // The signed-in user and their sessions
  // -------------------------------------------------------------------------------------------

  async me(actor: RequestActor): Promise<{ user: AuthUser; session: AuthSessionRow }> {
    const [user, session] = await Promise.all([
      this.db.user.findUnique({ where: { id: actor.userId } }),
      actor.sessionId ? this.sessions.findActive(this.db, actor.sessionId) : null,
    ]);
    if (!user || !session) {
      throw ApiException.unauthenticated(GENERIC_UNAUTHENTICATED);
    }
    return { user: await this.describeUser(user), session };
  }

  async listSessions(actor: RequestActor): Promise<AuthSession[]> {
    const sessions = await this.sessions.listActive(this.db, actor.userId);
    return sessions.map((session) => ({
      id: session.id,
      client: session.client,
      deviceName: session.deviceName,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      current: session.id === actor.sessionId,
    }));
  }

  /**
   * Ends one of the caller's own sessions. Another user's session id is answered exactly like
   * one that does not exist. Returns whether it was the session of this request.
   */
  async revokeSession(actor: RequestActor, sessionId: string): Promise<{ current: boolean }> {
    await this.db.$transaction(async (tx) => {
      const session = await tx.authSession.findUnique({ where: { id: sessionId } });
      if (
        !session ||
        session.userId !== actor.userId ||
        session.organizationId !== actor.organizationId
      ) {
        throw ApiException.notFound('Session', sessionId);
      }
      if (await this.sessions.revoke(tx, session.id, 'logout')) {
        await this.audit.record(tx, {
          organizationId: session.organizationId,
          action: 'auth.session_revoked',
          entityType: AUTH_AUDIT_ENTITY,
          entityId: session.id,
          after: { userId: session.userId, reason: 'logout', client: session.client },
        });
      }
    });
    return { current: sessionId === actor.sessionId };
  }

  /**
   * Ends the session named by an access token (an expired one is enough: it still proves which
   * session it was) or, failing that, by a refresh token. Never fails: signing out of a session
   * that is already gone is a success. Returns the session that was named, if any.
   */
  async logout(tokens: {
    accessToken: string | null;
    refreshToken: string | null;
  }): Promise<AuthSessionRow | null> {
    const claims = this.accessTokens.verify(tokens.accessToken, { ignoreExpiry: true });
    return this.db.$transaction(async (tx) => {
      let session = claims ? await tx.authSession.findUnique({ where: { id: claims.sid } }) : null;
      if (session && claims && session.userId !== claims.sub) {
        session = null;
      }
      if (!session && tokens.refreshToken) {
        session = await this.sessions.findByRefreshToken(tx, tokens.refreshToken);
      }
      if (!session) {
        return null;
      }
      if (await this.sessions.revoke(tx, session.id, 'logout')) {
        this.actAs({
          userId: session.userId,
          organizationId: session.organizationId,
          sessionId: session.id,
        });
        await this.audit.record(tx, {
          organizationId: session.organizationId,
          action: 'auth.logout',
          entityType: AUTH_AUDIT_ENTITY,
          entityId: session.id,
          after: { userId: session.userId, client: session.client },
        });
      }
      return session;
    });
  }

  /** Ends every session of the caller, the current one included. */
  async logoutAll(actor: RequestActor): Promise<number> {
    return this.db.$transaction(async (tx) => {
      const count = await this.sessions.revokeAllForUser(tx, {
        userId: actor.userId,
        organizationId: actor.organizationId,
        reason: 'logout_all',
      });
      await this.audit.record(tx, {
        organizationId: actor.organizationId,
        action: 'auth.logout_all',
        entityType: AUTH_AUDIT_ENTITY,
        entityId: actor.userId,
        after: { sessions: count },
      });
      return count;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Passwords
  // -------------------------------------------------------------------------------------------

  /**
   * Sets the password with a one-time code: first activation and reset alike. Every session of
   * the user ends, and every other unused code of the user is cancelled.
   *
   * A code that is unknown, used, expired, or belongs to an archived user gets one and the same
   * answer. A password the policy refuses does not use the code up, so the person can try again.
   */
  async setPassword(input: SetPasswordRequest, meta: RequestMeta): Promise<void> {
    const limits = this.settings.rateLimits;
    await this.limit(`set-password:ip:${meta.ip ?? 'unknown'}`, limits.setPasswordPerIp);
    await this.limit(
      `set-password:code:${hashCode(input.code).slice(0, 32)}`,
      limits.setPasswordPerCode,
    );

    const code = await this.codes.findUsable(this.db, input.code);
    const user = code ? await this.db.user.findUnique({ where: { id: code.userId } }) : null;
    if (!code || !user || user.archivedAt !== null) {
      throw ApiException.unprocessable(GENERIC_CODE_FAILURE);
    }

    const problems = checkNewPassword(input.password, user, 'password');
    if (problems.length > 0) {
      throw ApiException.validation(problems);
    }
    const passwordHash = await this.hasher.hash(input.password);
    const now = this.clock.now();

    await this.db.$transaction(async (tx) => {
      if (!(await this.codes.consume(tx, code.id))) {
        throw ApiException.unprocessable(GENERIC_CODE_FAILURE);
      }
      await tx.authCredential.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          organizationId: user.organizationId,
          passwordHash,
          passwordChangedAt: now,
        },
        update: { passwordHash, passwordChangedAt: now, failedAttempts: 0, lockedUntil: null },
      });
      await this.codes.cancelAllFor(tx, user.id);
      const sessionsEnded = await this.sessions.revokeAllForUser(tx, {
        userId: user.id,
        reason: 'password_changed',
      });
      // The code proved who this is: the event is attributed to the user, not to "system".
      this.actAs({ userId: user.id, organizationId: user.organizationId });
      await this.audit.record(tx, {
        organizationId: user.organizationId,
        action: code.purpose === 'activation' ? 'auth.activated' : 'auth.password_reset',
        entityType: AUTH_AUDIT_ENTITY,
        entityId: user.id,
        after: { purpose: code.purpose, sessionsEnded },
      });
    });
  }

  /** Changes the caller's password and ends their other sessions; the current one stays. */
  async changePassword(actor: RequestActor, input: ChangePasswordRequest): Promise<void> {
    await this.limit(
      `change-password:user:${actor.userId}`,
      this.settings.rateLimits.changePasswordPerUser,
    );
    const [user, credential] = await Promise.all([
      this.db.user.findUnique({ where: { id: actor.userId } }),
      this.db.authCredential.findUnique({ where: { userId: actor.userId } }),
    ]);
    if (!user) {
      throw ApiException.unauthenticated(GENERIC_UNAUTHENTICATED);
    }
    const matches = credential
      ? await this.hasher.verify(credential.passwordHash, input.currentPassword)
      : await this.hasher.verifyAgainstNothing(input.currentPassword);
    if (!matches) {
      // Not a 401: the caller IS signed in, and a client must not answer this by refreshing.
      throw ApiException.validation([{ path: 'currentPassword', message: 'is not correct' }]);
    }
    if (input.newPassword === input.currentPassword) {
      throw ApiException.validation([
        { path: 'newPassword', message: 'must differ from the current password' },
      ]);
    }
    const problems = checkNewPassword(input.newPassword, user, 'newPassword');
    if (problems.length > 0) {
      throw ApiException.validation(problems);
    }
    const passwordHash = await this.hasher.hash(input.newPassword);
    const now = this.clock.now();

    await this.db.$transaction(async (tx) => {
      await tx.authCredential.update({
        where: { userId: user.id },
        data: { passwordHash, passwordChangedAt: now, failedAttempts: 0, lockedUntil: null },
      });
      await this.codes.cancelAllFor(tx, user.id);
      const sessionsEnded = await this.sessions.revokeAllForUser(tx, {
        userId: user.id,
        reason: 'password_changed',
        exceptSessionId: actor.sessionId ?? null,
      });
      await this.audit.record(tx, {
        organizationId: user.organizationId,
        action: 'auth.password_changed',
        entityType: AUTH_AUDIT_ENTITY,
        entityId: user.id,
        after: { sessionsEnded },
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /** The user as they see themselves, with what the host knows about their roles. */
  async describeUser(user: AuthUserRow): Promise<AuthUser> {
    const profile = this.profiles
      ? await this.profiles.describe({ userId: user.id, organizationId: user.organizationId })
      : await this.profileWithoutHost(user.organizationId);
    return {
      id: user.id,
      organizationId: user.organizationId,
      organizationName: profile.organizationName,
      displayName: user.displayName,
      email: user.email,
      phone: user.phone,
      username: user.username,
      roles: profile.roles,
      role: profile.role,
    };
  }

  /** No host profile provider: no roles, and the organization name straight from its table. */
  private async profileWithoutHost(organizationId: string): Promise<AuthProfile> {
    const organization = await this.db.organization.findUnique({ where: { id: organizationId } });
    return { organizationName: organization?.name ?? '', roles: [], role: null };
  }

  /**
   * The one non-archived user an identifier names, or null. With an organization slug the
   * search is inside that organization; without one the identifier must name exactly one user
   * across all organizations (none or several: null, the same as a wrong password).
   */
  private async findUserForLogin(
    identifier: LoginIdentifier,
    organizationSlug: string | undefined,
  ): Promise<AuthUserRow | null> {
    let organizationId: string | undefined;
    if (organizationSlug !== undefined) {
      const organization = await this.db.organization.findUnique({
        where: { slug: organizationSlug.trim().toLowerCase() },
      });
      if (!organization || organization.archivedAt !== null) {
        return null;
      }
      organizationId = organization.id;
    } else {
      // Without a slug, an identifier is only meaningful while there is a single organization.
      // With several, an admin of one organization could otherwise block a user of another
      // (by creating the same identifier) or probe which identifiers exist elsewhere. So a
      // slug-less sign-in is refused as soon as a second active organization exists; clients
      // send the slug of their deployment (NEXT_PUBLIC_ / EXPO_PUBLIC_ORGANIZATION_SLUG).
      const organizations = await this.db.organization.findMany({
        where: { archivedAt: null },
        select: { id: true },
        take: 2,
      });
      if (organizations.length !== 1) {
        return null;
      }
    }
    const users = await this.db.user.findMany({
      where: {
        [identifier.kind]: identifier.value,
        archivedAt: null,
        ...(organizationId ? { organizationId } : {}),
      },
      take: 2,
    });
    const [user] = users;
    if (users.length !== 1 || !user) {
      return null;
    }
    if (organizationId === undefined) {
      const organization = await this.db.organization.findUnique({
        where: { id: user.organizationId },
      });
      if (!organization || organization.archivedAt !== null) {
        return null;
      }
    }
    return user;
  }

  /**
   * A failed sign-in that changes no counter. For a known user the event belongs to their
   * organization. For an identifier that names nobody, the event has NO organization (so no
   * organization's admin can read it) and carries only a keyed fingerprint of what was typed:
   * enough to see that the same identifier is being tried repeatedly, useless for finding out
   * which identifiers exist or what was typed.
   */
  private async recordFailedLogin(
    user: AuthUserRow | null,
    identifier: LoginIdentifier,
    fingerprint: string,
    reason: FailedLoginReason,
  ): Promise<void> {
    await this.audit.record(this.db, {
      organizationId: user?.organizationId ?? null,
      action: 'auth.login_failed',
      entityType: AUTH_AUDIT_ENTITY,
      entityId: user?.id ?? 'unknown',
      after: user
        ? { reason, kind: identifier.kind }
        : { reason, kind: identifier.kind, identifierFingerprint: fingerprint },
    });
  }

  private fingerprint(identifier: LoginIdentifier, organizationSlug: string | undefined): string {
    const scope = organizationSlug?.trim().toLowerCase() ?? '';
    return hmacSha256(this.fingerprintKey, `${scope}|${identifier.kind}|${identifier.value}`)
      .toString('hex')
      .slice(0, 32);
  }

  private async limit(key: string, rule: RateLimitRule): Promise<void> {
    const decision = await this.limiter.hit(key, rule);
    if (!decision.allowed) {
      throw ApiException.rateLimited(undefined, decision.retryAfterSeconds);
    }
  }

  /** Attributes the rest of the request (audit events, the request log line) to this user. */
  private actAs(actor: RequestActor): void {
    if (RequestContext.current()) {
      RequestContext.setActor(actor);
    }
  }
}
