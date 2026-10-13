import { Injectable } from '@nestjs/common';
import type { CreateUser, ListUsersQuery, Paginated, UpdateUser, User } from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, contains, iso, isoOrNull, isUniqueViolation, type Db } from '../common/db';
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

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    displayName: row.displayName,
    phone: row.phone,
    memberships: row.memberships.map(toMembershipSummary),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async list(organizationId: string, query: ListUsersQuery): Promise<Paginated<User>> {
    const byMembership = query.role !== undefined || query.siteId || query.teamId;
    const where: Prisma.UserWhereInput = {
      organizationId,
      ...activeUnless(query.includeArchived),
      ...(query.search
        ? { OR: [{ displayName: contains(query.search) }, { email: contains(query.search) }] }
        : {}),
      // One active membership must satisfy all three filters together.
      ...(byMembership
        ? {
            memberships: {
              some: {
                archivedAt: null,
                ...(query.role ? { role: query.role } : {}),
                ...(query.siteId ? { sites: { some: { siteId: query.siteId } } } : {}),
                ...(query.teamId ? { teams: { some: { teamId: query.teamId } } } : {}),
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
    return paginated(rows.map(toUser), total, query);
  }

  async get(organizationId: string, id: string): Promise<User> {
    return toUser(await this.find(this.prisma, organizationId, id));
  }

  async create(organizationId: string, input: CreateUser): Promise<User> {
    return this.emailConflictAsError(() =>
      this.prisma.$transaction(async (tx) => {
        const user = toUser(
          await tx.user.create({ data: { ...input, organizationId }, include: USER_INCLUDE }),
        );
        await this.changes.record(tx, {
          organizationId,
          entityType: 'user',
          verb: 'created',
          entityId: user.id,
          after: user,
        });
        return user;
      }),
    );
  }

  async update(organizationId: string, id: string, input: UpdateUser): Promise<User> {
    return this.emailConflictAsError(() =>
      this.prisma.$transaction(async (tx) => {
        const row = await this.find(tx, organizationId, id);
        if (row.archivedAt) {
          throw ApiException.conflict(`User ${id} is archived; restore them before changing them`);
        }
        const user = toUser(
          await tx.user.update({ where: { id }, data: input, include: USER_INCLUDE }),
        );
        await this.changes.record(tx, {
          organizationId,
          entityType: 'user',
          verb: 'updated',
          entityId: id,
          before: toUser(row),
          after: user,
        });
        return user;
      }),
    );
  }

  /**
   * Archives the user. Their memberships are kept (scope resolution ignores an archived user),
   * so restoring the user brings their roles back.
   */
  async archive(organizationId: string, id: string): Promise<User> {
    return this.setArchived(organizationId, id, true);
  }

  async restore(organizationId: string, id: string): Promise<User> {
    return this.setArchived(organizationId, id, false);
  }

  /** Archiving an archived user (or restoring an active one) changes and records nothing. */
  private async setArchived(organizationId: string, id: string, archived: boolean): Promise<User> {
    return this.prisma.$transaction(async (tx) => {
      const before = toUser(await this.find(tx, organizationId, id));
      if ((before.archivedAt !== null) === archived) {
        return before;
      }
      const user = toUser(
        await tx.user.update({
          where: { id },
          data: { archivedAt: archived ? new Date() : null },
          include: USER_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'user',
        verb: archived ? 'archived' : 'restored',
        entityId: id,
        before,
        after: user,
      });
      return user;
    });
  }

  private async find(db: Db, organizationId: string, id: string): Promise<UserRow> {
    const row = await db.user.findFirst({ where: { id, organizationId }, include: USER_INCLUDE });
    if (!row) {
      throw ApiException.notFound('User', id);
    }
    return row;
  }

  /** The only unique rule on a user is the email within the organization. */
  private async emailConflictAsError(write: () => Promise<User>): Promise<User> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw ApiException.conflict('A user with this email already exists', [
          { path: 'email', message: 'is already in use' },
        ]);
      }
      throw error;
    }
  }
}
