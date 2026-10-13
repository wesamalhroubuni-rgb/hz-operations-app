import { Injectable } from '@nestjs/common';
import type { ResolvedScope } from '@ops/shared';
import { ApiException } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveScope } from './resolve-scope';

/**
 * Loads what {@link resolveScope} needs and runs it. This is the single answer to "what may
 * this user see"; Phase 3 turns the result into query filters on every route. Nothing enforces
 * it yet.
 *
 * It reads every membership, site and team of the organization on each call, which is fine at
 * the size of one company; cache per request (or per user) when Phase 3 calls it on every route.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * @param organizationId the caller's organization; a user of another organization is reported
   *   as not found
   */
  async resolveForUser(organizationId: string, userId: string): Promise<ResolvedScope> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId },
      select: { id: true, organizationId: true, archivedAt: true },
    });
    if (!user) {
      throw ApiException.notFound('User', userId);
    }

    const node = { id: true, parentId: true } as const;
    const [memberships, sites, teams] = await Promise.all([
      this.prisma.membership.findMany({
        where: { organizationId },
        select: {
          userId: true,
          role: true,
          orgWide: true,
          archivedAt: true,
          sites: { select: { siteId: true } },
          teams: { select: { teamId: true } },
        },
      }),
      this.prisma.site.findMany({ where: { organizationId }, select: node }),
      this.prisma.team.findMany({ where: { organizationId }, select: node }),
    ]);

    return resolveScope({
      user: { id: user.id, organizationId, archived: user.archivedAt !== null },
      memberships: memberships.map((membership) => ({
        userId: membership.userId,
        role: membership.role,
        orgWide: membership.orgWide,
        archived: membership.archivedAt !== null,
        siteIds: membership.sites.map((scope) => scope.siteId),
        teamIds: membership.teams.map((scope) => scope.teamId),
      })),
      sites,
      teams,
    });
  }
}
