import { Injectable } from '@nestjs/common';
import { rolesHighestFirst } from '@ops/shared';
import type { AuthProfile, AuthProfileProvider } from '../../platform/auth/auth-profile';
import { ApiException } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * What the Operations domain tells the platform's auth module about a signed-in user: the name
 * of their organization and the roles of their active memberships. An archived user holds none.
 */
@Injectable()
export class OperationsAuthProfileProvider implements AuthProfileProvider {
  constructor(private readonly prisma: PrismaService) {}

  async describe(user: { userId: string; organizationId: string }): Promise<AuthProfile> {
    const [organization, memberships] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: user.organizationId },
        select: { name: true },
      }),
      this.prisma.membership.findMany({
        where: {
          organizationId: user.organizationId,
          userId: user.userId,
          archivedAt: null,
          user: { archivedAt: null },
        },
        select: { role: true },
      }),
    ]);
    if (!organization) {
      throw ApiException.notFound('Organization', user.organizationId);
    }
    const roles = rolesHighestFirst(memberships.map((membership) => membership.role));
    return { organizationName: organization.name, roles, role: roles[0] ?? null };
  }
}
