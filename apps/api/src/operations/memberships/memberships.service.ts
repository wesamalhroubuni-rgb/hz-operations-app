import { Injectable } from '@nestjs/common';
import {
  membershipScopeIssues,
  type CreateMembership,
  type ListMembershipsQuery,
  type Membership,
  type MembershipSummary,
  type Paginated,
  type UpdateMembership,
} from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { AuthAdminService } from '../../platform/auth/auth-admin.service';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessService,
  canGrantMembership,
  enforce,
  isMembershipReduced,
  type MembershipGrant,
} from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, iso, isoOrNull, type Db } from '../common/db';
import { assertActiveReferences, ref } from '../common/references';
import { assertAdminRemains } from './admin-guard';

/** A membership is always read together with its site and team scope rows. */
export const MEMBERSHIP_INCLUDE = {
  sites: { select: { siteId: true }, orderBy: { siteId: 'asc' } },
  teams: { select: { teamId: true }, orderBy: { teamId: 'asc' } },
} satisfies Prisma.MembershipInclude;

export type MembershipRow = Prisma.MembershipGetPayload<{ include: typeof MEMBERSHIP_INCLUDE }>;

export function toMembershipSummary(row: MembershipRow): MembershipSummary {
  return {
    id: row.id,
    role: row.role,
    orgWide: row.orgWide,
    siteIds: row.sites.map((scope) => scope.siteId),
    teamIds: row.teams.map((scope) => scope.teamId),
  };
}

export function toMembership(row: MembershipRow): Membership {
  return {
    ...toMembershipSummary(row),
    organizationId: row.organizationId,
    userId: row.userId,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/** A manager or admin membership that is not organization-wide is a 400 naming the fields. */
function assertScopeFitsRole(grant: MembershipGrant): void {
  const issues = membershipScopeIssues(grant);
  if (issues.length > 0) {
    throw ApiException.validation(
      issues,
      `A ${grant.role} membership always covers the whole organization`,
    );
  }
}

/**
 * Memberships are read and managed by admins only (route policies `membership.read` and
 * `membership.manage`). On top of that every write applies the general rules, whoever the
 * granter is: no role above the granter's own and no scope outside it (`canGrantMembership`),
 * manager and admin always organization-wide, and the last active admin stays.
 */
@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
    private readonly auth: AuthAdminService,
  ) {}

  async list(query: ListMembershipsQuery): Promise<Paginated<Membership>> {
    const { organizationId } = await this.access.context();
    const where: Prisma.MembershipWhereInput = {
      organizationId,
      ...activeUnless(query.includeArchived),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.role ? { role: query.role } : {}),
      ...(query.siteId ? { sites: { some: { siteId: query.siteId } } } : {}),
      ...(query.teamId ? { teams: { some: { teamId: query.teamId } } } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.membership.findMany({
        where,
        include: MEMBERSHIP_INCLUDE,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.membership.count({ where }),
    ]);
    return paginated(rows.map(toMembership), total, query);
  }

  async get(id: string): Promise<Membership> {
    const { organizationId } = await this.access.context();
    return toMembership(await this.find(this.prisma, organizationId, id));
  }

  async create(input: CreateMembership): Promise<Membership> {
    const context = await this.access.context();
    const { organizationId } = context;
    assertScopeFitsRole(input);
    enforce(canGrantMembership(context, input), 'Membership');
    return this.prisma.$transaction(async (tx) => {
      await assertActiveReferences(tx, organizationId, [
        ...ref('user', 'userId', input.userId),
        ...ref('site', 'siteIds', input.siteIds),
        ...ref('team', 'teamIds', input.teamIds),
      ]);
      const membership = toMembership(
        await tx.membership.create({
          data: {
            organizationId,
            userId: input.userId,
            role: input.role,
            orgWide: input.orgWide,
            sites: { create: input.siteIds.map((siteId) => ({ siteId, organizationId })) },
            teams: { create: input.teamIds.map((teamId) => ({ teamId, organizationId })) },
          },
          include: MEMBERSHIP_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'membership',
        verb: 'created',
        entityId: membership.id,
        after: membership,
      });
      return membership;
    });
  }

  /**
   * Changes the role and/or replaces the scope. Scope lists that are left out stay as they are.
   * When the change takes something away (a lower role, a smaller scope), the holder's sessions
   * are ended in the same transaction.
   */
  async update(id: string, input: UpdateMembership): Promise<Membership> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const row = await this.find(tx, organizationId, id);
      const before = toMembership(row);
      // The granter must be entitled to the membership as it is, and as it will be.
      enforce(canGrantMembership(context, before), 'Membership', id);
      if (row.archivedAt) {
        throw ApiException.conflict(`Membership ${id} is archived and cannot be changed`);
      }
      const after: MembershipGrant = {
        role: input.role ?? before.role,
        orgWide: input.orgWide ?? before.orgWide,
        siteIds: input.siteIds ?? before.siteIds,
        teamIds: input.teamIds ?? before.teamIds,
      };
      assertScopeFitsRole(after);
      enforce(canGrantMembership(context, after), 'Membership', id);
      if (before.role === 'admin' && after.role !== 'admin') {
        await assertAdminRemains(tx, organizationId, { membershipId: id });
      }
      await assertActiveReferences(tx, organizationId, [
        ...ref('site', 'siteIds', input.siteIds),
        ...ref('team', 'teamIds', input.teamIds),
      ]);

      if (input.siteIds) {
        await tx.membershipSite.deleteMany({ where: { membershipId: id } });
        await tx.membershipSite.createMany({
          data: input.siteIds.map((siteId) => ({ membershipId: id, siteId, organizationId })),
        });
      }
      if (input.teamIds) {
        await tx.membershipTeam.deleteMany({ where: { membershipId: id } });
        await tx.membershipTeam.createMany({
          data: input.teamIds.map((teamId) => ({ membershipId: id, teamId, organizationId })),
        });
      }
      // Always written, so `updatedAt` moves even when only the scope lists changed.
      const membership = toMembership(
        await tx.membership.update({
          where: { id },
          data: { role: input.role, orgWide: input.orgWide, updatedAt: new Date() },
          include: MEMBERSHIP_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'membership',
        verb: 'updated',
        entityId: id,
        before,
        after: membership,
      });
      if (isMembershipReduced(before, membership)) {
        await this.auth.revokeUserSessions(tx, {
          userId: membership.userId,
          organizationId,
          reason: 'membership_removed',
        });
      }
      return membership;
    });
  }

  /**
   * Archives the membership and ends the holder's sessions in the same transaction. Archiving
   * an archived membership changes and records nothing.
   */
  async archive(id: string): Promise<Membership> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const before = toMembership(await this.find(tx, organizationId, id));
      enforce(canGrantMembership(context, before), 'Membership', id);
      if (before.archivedAt !== null) {
        return before;
      }
      if (before.role === 'admin') {
        await assertAdminRemains(tx, organizationId, { membershipId: id });
      }
      const membership = toMembership(
        await tx.membership.update({
          where: { id },
          data: { archivedAt: new Date() },
          include: MEMBERSHIP_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'membership',
        verb: 'archived',
        entityId: id,
        before,
        after: membership,
      });
      await this.auth.revokeUserSessions(tx, {
        userId: membership.userId,
        organizationId,
        reason: 'membership_removed',
      });
      return membership;
    });
  }

  private async find(db: Db, organizationId: string, id: string): Promise<MembershipRow> {
    const row = await db.membership.findFirst({
      where: { id, organizationId },
      include: MEMBERSHIP_INCLUDE,
    });
    if (!row) {
      throw ApiException.notFound('Membership', id);
    }
    return row;
  }
}
