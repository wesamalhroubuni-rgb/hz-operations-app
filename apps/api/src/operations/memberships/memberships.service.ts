import { Injectable } from '@nestjs/common';
import type {
  CreateMembership,
  ListMembershipsQuery,
  Membership,
  MembershipSummary,
  Paginated,
  UpdateMembership,
} from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, iso, isoOrNull, type Db } from '../common/db';
import { assertActiveReferences, ref } from '../common/references';

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

@Injectable()
export class MembershipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async list(organizationId: string, query: ListMembershipsQuery): Promise<Paginated<Membership>> {
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

  async get(organizationId: string, id: string): Promise<Membership> {
    return toMembership(await this.find(this.prisma, organizationId, id));
  }

  async create(organizationId: string, input: CreateMembership): Promise<Membership> {
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

  /** Changes the role and/or replaces the scope. Scope lists that are left out stay as they are. */
  async update(organizationId: string, id: string, input: UpdateMembership): Promise<Membership> {
    return this.prisma.$transaction(async (tx) => {
      const row = await this.find(tx, organizationId, id);
      if (row.archivedAt) {
        throw ApiException.conflict(`Membership ${id} is archived and cannot be changed`);
      }
      const before = toMembership(row);
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
      return membership;
    });
  }

  /** Archiving an archived membership changes and records nothing. */
  async archive(organizationId: string, id: string): Promise<Membership> {
    return this.prisma.$transaction(async (tx) => {
      const before = toMembership(await this.find(tx, organizationId, id));
      if (before.archivedAt !== null) {
        return before;
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
