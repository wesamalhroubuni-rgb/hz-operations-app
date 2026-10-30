import { Injectable } from '@nestjs/common';
import {
  hasLoginIdentifier,
  localeOf,
  rolesHighestFirst,
  USER_IDENTIFIER_FIELDS,
  type CreatedUser,
  type CreateUser,
  type AuthSession,
  type IssuedCode,
  type ListUsersQuery,
  type MembershipSummary,
  type Paginated,
  type UpdateUser,
  type User,
  type UserBasic,
  type UserContact,
  type UserFull,
  type UserIdentifierField,
  type UserProfileLevel,
} from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuthAdminService } from '../../platform/auth/auth-admin.service';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessService,
  canUpdateUser,
  contactVisibilityWhere,
  enforce,
  seesEveryContact,
  siteVisibilityWhere,
  teamVisibilityWhere,
  userProfileLevel,
  userVisibilityWhere,
  type AccessContext,
} from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, contains, iso, isoOrNull, isUniqueViolation, type Db } from '../common/db';
import { assertAdminRemains } from '../memberships/admin-guard';
import { MEMBERSHIP_INCLUDE, toMembershipSummary } from '../memberships/memberships.service';

/** A user is always read together with their active memberships. */
const USER_INCLUDE = {
  memberships: {
    where: { archivedAt: null },
    include: MEMBERSHIP_INCLUDE,
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.UserInclude;

type UserRow = Prisma.UserGetPayload<{ include: typeof USER_INCLUDE }>;

/**
 * The stored user, as written to the audit log and the outbox (both admin-only): the business
 * row and its memberships. It holds nothing from the authentication tables, by construction.
 */
export interface UserRecord {
  id: string;
  organizationId: string;
  email: string | null;
  phone: string | null;
  username: string | null;
  displayName: string;
  locale: string;
  memberships: MembershipSummary[];
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    phone: row.phone,
    username: row.username,
    displayName: row.displayName,
    locale: localeOf(row.locale),
    memberships: row.memberships.map(toMembershipSummary),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

// The three response shapes. Each mapper lists its fields: nothing reaches a caller by default.

export function toUserBasic(row: UserRow): UserBasic {
  return {
    profile: 'basic',
    id: row.id,
    displayName: row.displayName,
    roles: rolesHighestFirst(row.memberships.map((membership) => membership.role)),
  };
}

export function toUserContact(row: UserRow): UserContact {
  return { ...toUserBasic(row), profile: 'contact', email: row.email, phone: row.phone };
}

export function toUserFull(row: UserRow, activated: boolean): UserFull {
  const record = toUserRecord(row);
  return {
    ...toUserContact(row),
    profile: 'full',
    organizationId: record.organizationId,
    username: record.username,
    memberships: record.memberships,
    activated,
    locale: localeOf(row.locale),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
  };
}

export function toUserProfile(level: UserProfileLevel, row: UserRow, activated: boolean): User {
  switch (level) {
    case 'full':
      return toUserFull(row, activated);
    case 'contact':
      return toUserContact(row);
    case 'basic':
    default:
      return toUserBasic(row);
  }
}

type Identifiers = Partial<Record<UserIdentifierField, string | null | undefined>>;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
    private readonly auth: AuthAdminService,
  ) {}

  /**
   * The users the caller may see, each in the shape the caller is entitled to. Every filter is
   * part of the query; nothing is loaded and dropped afterwards.
   */
  async list(query: ListUsersQuery): Promise<Paginated<User>> {
    const context = await this.access.context();
    if (query.sort.field === 'email' && !seesEveryContact(context)) {
      // Ordering by a column the caller cannot read would reveal it little by little.
      throw ApiException.forbidden('You can sort by email only when you can see every email');
    }
    const byMembership = query.role !== undefined || query.siteId || query.teamId;
    const where: Prisma.UserWhereInput = {
      organizationId: context.organizationId,
      ...activeUnless(query.includeArchived),
      AND: [
        userVisibilityWhere(context) as Prisma.UserWhereInput,
        ...(query.search ? [this.searchWhere(context, query.search)] : []),
      ],
      // One active membership must satisfy all three filters together. The site and the team
      // must be ones the caller may see, or the filter matches nobody.
      ...(byMembership
        ? {
            memberships: {
              some: {
                archivedAt: null,
                ...(query.role ? { role: query.role } : {}),
                ...(query.siteId
                  ? {
                      sites: {
                        some: {
                          siteId: query.siteId,
                          site: siteVisibilityWhere(context) as Prisma.SiteWhereInput,
                        },
                      },
                    }
                  : {}),
                ...(query.teamId
                  ? {
                      teams: {
                        some: {
                          teamId: query.teamId,
                          team: teamVisibilityWhere(context) as Prisma.TeamWhereInput,
                        },
                      },
                    }
                  : {}),
              },
            },
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: USER_INCLUDE,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.user.count({ where }),
    ]);
    const levels = rows.map((row) => userProfileLevel(context, row.id));
    const activated = await this.activationStates(
      this.prisma,
      rows.filter((_row, index) => levels[index] === 'full').map((row) => row.id),
    );
    return paginated(
      rows.map((row, index) => toUserProfile(levels[index] ?? 'basic', row, activated.has(row.id))),
      total,
      query,
    );
  }

  async get(id: string): Promise<User> {
    const context = await this.access.context();
    const row = await this.findVisible(this.prisma, context, id);
    const level = userProfileLevel(context, id);
    const activated = level === 'full' && (await this.auth.isActivated(this.prisma, id));
    return toUserProfile(level, row, activated);
  }

  /**
   * Creates a user and, in the same transaction, issues the one-time activation code that lets
   * them set their password. Admins only (route policy `user.manage`).
   */
  async create(input: CreateUser): Promise<CreatedUser> {
    const { organizationId } = await this.access.context();
    return this.identifierConflictAsError(() =>
      this.prisma.$transaction(async (tx) => {
        const row = await this.insert(tx, organizationId, input);
        const activation = await this.auth.issueOneTimeCode(tx, {
          userId: row.id,
          organizationId,
          purpose: 'activation',
        });
        return { ...toUserFull(row, false), activation };
      }),
    );
  }

  /**
   * DEVELOPMENT SEED ONLY: creates a user who can sign in at once with the given password, with
   * no activation code. The password goes straight to `AuthAdminService.setPasswordForSeed`,
   * which applies the password policy and refuses to run in production; it is never stored,
   * logged or returned here. No route calls this.
   */
  async createWithPassword(input: CreateUser, password: string): Promise<UserFull> {
    const context = await this.access.context();
    if (!context.isAdmin) {
      throw ApiException.forbidden('Only an admin can create users');
    }
    const { organizationId } = context;
    return this.identifierConflictAsError(() =>
      this.prisma.$transaction(async (tx) => {
        const row = await this.insert(tx, organizationId, input);
        await this.auth.setPasswordForSeed(tx, { userId: row.id, organizationId, password });
        return toUserFull(row, true);
      }),
    );
  }

  /**
   * Changes a user the caller can see: an admin any field of anyone, everyone else only their
   * own display name (`canUpdateUser`). At least one login identifier must remain.
   */
  async update(id: string, input: UpdateUser): Promise<UserFull> {
    const context = await this.access.context();
    const { organizationId } = context;
    const changedFields = Object.entries(input)
      .filter(([, value]) => value !== undefined)
      .map(([field]) => field);
    return this.identifierConflictAsError(() =>
      this.prisma.$transaction(async (tx) => {
        const row = await this.findVisible(tx, context, id);
        enforce(canUpdateUser(context, id, changedFields), 'User', id);
        if (row.archivedAt) {
          throw ApiException.conflict(`User ${id} is archived; restore them before changing them`);
        }
        const identifiers: Identifiers = {
          email: input.email === undefined ? row.email : input.email,
          phone: input.phone === undefined ? row.phone : input.phone,
          username: input.username === undefined ? row.username : input.username,
        };
        if (!hasLoginIdentifier(identifiers)) {
          throw ApiException.validation([
            { path: 'email', message: 'A user needs at least one of email, phone or username' },
          ]);
        }
        await this.assertIdentifiersFree(
          tx,
          organizationId,
          { email: input.email, phone: input.phone, username: input.username },
          id,
        );
        const updated = await tx.user.update({
          where: { id },
          data: {
            displayName: input.displayName,
            email: input.email,
            phone: input.phone,
            username: input.username,
            locale: input.locale,
          },
          include: USER_INCLUDE,
        });
        await this.changes.record(tx, {
          organizationId,
          entityType: 'user',
          verb: 'updated',
          entityId: id,
          before: toUserRecord(row),
          after: toUserRecord(updated),
        });
        return toUserFull(updated, await this.auth.isActivated(tx, id));
      }),
    );
  }

  /**
   * Archives the user and ends their sessions in the same transaction. Their memberships are
   * kept (scope resolution ignores an archived user), so restoring the user brings their roles
   * back. The last active admin cannot be archived (409).
   */
  async archive(id: string): Promise<UserFull> {
    return this.setArchived(id, true);
  }

  async restore(id: string): Promise<UserFull> {
    return this.setArchived(id, false);
  }

  /**
   * A new activation code for a user who has not set a password yet (the earlier one expired or
   * was lost). Issuing it invalidates the earlier code. 409 once the user is activated.
   */
  async issueActivationCode(id: string): Promise<IssuedCode> {
    return this.issueCode(id, 'activation');
  }

  /** A password-reset code for a user who has set a password before. 409 if they never did. */
  async issuePasswordReset(id: string): Promise<IssuedCode> {
    return this.issueCode(id, 'password_reset');
  }

  private async issueCode(id: string, purpose: IssuedCode['purpose']): Promise<IssuedCode> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const row = await this.findVisible(tx, context, id);
      if (row.archivedAt) {
        throw ApiException.conflict(`User ${id} is archived; restore them first`);
      }
      const activated = await this.auth.isActivated(tx, id);
      if (purpose === 'activation' && activated) {
        throw ApiException.conflict(
          `User ${id} is already activated; issue a password reset instead`,
        );
      }
      if (purpose === 'password_reset' && !activated) {
        throw ApiException.conflict(
          `User ${id} has not been activated yet; issue an activation code instead`,
        );
      }
      // The auth module stores only a hash, notifies the user and writes the audit event.
      return this.auth.issueOneTimeCode(tx, { userId: id, organizationId, purpose });
    });
  }

  /**
   * The user's active sessions (devices), for an admin (route policy `user.manage`, Phase 6).
   * Through `AuthAdminService`: never a token, a hash or an IP address.
   */
  async sessions(id: string): Promise<{ items: AuthSession[] }> {
    const context = await this.access.context();
    await this.findVisible(this.prisma, context, id);
    return {
      items: await this.auth.listUserSessions(this.prisma, {
        userId: id,
        organizationId: context.organizationId,
      }),
    };
  }

  /**
   * Ends every session of the user (signs them out on every device) and, through the
   * session-end hook, removes their push tokens. Audited by the auth module
   * (`auth.session_revoked`, reason `admin_revoked`) when anything was active.
   */
  async revokeSessions(id: string): Promise<{ revoked: number }> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      await this.findVisible(tx, context, id);
      const revoked = await this.auth.revokeUserSessions(tx, {
        userId: id,
        organizationId,
        reason: 'admin_revoked',
      });
      return { revoked };
    });
  }

  /** Archiving an archived user (or restoring an active one) changes and records nothing. */
  private async setArchived(id: string, archived: boolean): Promise<UserFull> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const row = await this.findVisible(tx, context, id);
      if ((row.archivedAt !== null) === archived) {
        return toUserFull(row, await this.auth.isActivated(tx, id));
      }
      if (archived) {
        await assertAdminRemains(tx, organizationId, { userId: id });
      }
      const updated = await tx.user.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
        include: USER_INCLUDE,
      });
      await this.changes.record(tx, {
        organizationId,
        entityType: 'user',
        verb: archived ? 'archived' : 'restored',
        entityId: id,
        before: toUserRecord(row),
        after: toUserRecord(updated),
      });
      if (archived) {
        await this.auth.revokeUserSessions(tx, {
          userId: id,
          organizationId,
          reason: 'user_archived',
        });
      }
      return toUserFull(updated, await this.auth.isActivated(tx, id));
    });
  }

  /** Writes the user row and its audit and outbox events. The caller owns the transaction. */
  private async insert(tx: Db, organizationId: string, input: CreateUser): Promise<UserRow> {
    await this.assertIdentifiersFree(tx, organizationId, input);
    const row = await tx.user.create({
      data: {
        organizationId,
        displayName: input.displayName,
        email: input.email ?? null,
        phone: input.phone ?? null,
        username: input.username ?? null,
        ...(input.locale ? { locale: input.locale } : {}),
      },
      include: USER_INCLUDE,
    });
    await this.changes.record(tx, {
      organizationId,
      entityType: 'user',
      verb: 'created',
      entityId: row.id,
      after: toUserRecord(row),
    });
    return row;
  }

  /**
   * A search term matches the display name of anyone the caller can see, and the email and
   * phone only of users whose contact details the caller may read (the username only for
   * admins), so a search can never be used to guess a field the caller is not shown.
   */
  private searchWhere(context: AccessContext, term: string): Prisma.UserWhereInput {
    return {
      OR: [
        { displayName: contains(term) },
        {
          AND: [
            contactVisibilityWhere(context) as Prisma.UserWhereInput,
            {
              OR: [
                { email: contains(term) },
                { phone: contains(term) },
                ...(context.isAdmin ? [{ username: contains(term) }] : []),
              ],
            },
          ],
        },
      ],
    };
  }

  /** The user, if the caller may see them at all; 404 otherwise (also for another organization). */
  private async findVisible(db: Db, context: AccessContext, id: string): Promise<UserRow> {
    const row = await db.user.findFirst({
      where: {
        id,
        organizationId: context.organizationId,
        AND: [userVisibilityWhere(context) as Prisma.UserWhereInput],
      },
      include: USER_INCLUDE,
    });
    if (!row) {
      throw ApiException.notFound('User', id);
    }
    return row;
  }

  /**
   * Which of these users have set a password: one query for the whole page. Only `full` rows
   * need it (the caller's own row, or an admin's page).
   */
  private async activationStates(db: Db, userIds: string[]): Promise<Set<string>> {
    return this.auth.activatedUserIds(db, userIds);
  }

  /**
   * 409 naming the field when an identifier is already used by another user of the
   * organization (archived users keep theirs). Admin-only paths, so naming the field reveals
   * nothing the caller cannot already list.
   */
  private async assertIdentifiersFree(
    db: Db,
    organizationId: string,
    identifiers: Identifiers,
    exceptUserId?: string,
  ): Promise<void> {
    const wanted = USER_IDENTIFIER_FIELDS.flatMap((field) => {
      const value = identifiers[field];
      return typeof value === 'string' ? [{ field, value }] : [];
    });
    if (wanted.length === 0) {
      return;
    }
    const taken = await db.user.findMany({
      where: {
        organizationId,
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
        OR: wanted.map(({ field, value }) => ({ [field]: value })),
      },
      select: { email: true, phone: true, username: true },
    });
    const fields = wanted
      .filter(({ field, value }) => taken.some((user) => user[field] === value))
      .map(({ field }) => field);
    if (fields.length > 0) {
      throw identifierConflict(fields);
    }
  }

  /** The unique indexes catch what the check above cannot: two identical writes at once. */
  private async identifierConflictAsError<Result>(write: () => Promise<Result>): Promise<Result> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const description = JSON.stringify(error);
        throw identifierConflict(
          USER_IDENTIFIER_FIELDS.filter((field) => description.includes(field)),
        );
      }
      throw error;
    }
  }
}

function identifierConflict(fields: readonly UserIdentifierField[]): ApiException {
  const named = fields.length > 0 ? fields : USER_IDENTIFIER_FIELDS;
  return ApiException.conflict(
    `A user with this ${named.join(' or ')} already exists`,
    fields.map((field) => ({ path: field, message: 'is already in use' })),
  );
}
