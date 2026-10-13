import { Injectable } from '@nestjs/common';
import type { Organization, UpdateOrganization } from '@ops/shared';
import type { Organization as OrganizationRow, Prisma } from '../../generated/prisma/client';
import { ApiException } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { iso, isoOrNull, type Db } from '../common/db';

export function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    settings: (row.settings ?? {}) as Organization['settings'],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

@Injectable()
export class OrganizationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async get(organizationId: string): Promise<Organization> {
    return toOrganization(await this.find(this.prisma, organizationId));
  }

  async update(organizationId: string, input: UpdateOrganization): Promise<Organization> {
    return this.prisma.$transaction(async (tx) => {
      const before = toOrganization(await this.find(tx, organizationId));
      const organization = toOrganization(
        await tx.organization.update({
          where: { id: organizationId },
          data: {
            name: input.name,
            settings: input.settings as Prisma.InputJsonObject | undefined,
          },
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'organization',
        verb: 'updated',
        entityId: organizationId,
        before,
        after: organization,
      });
      return organization;
    });
  }

  private async find(db: Db, organizationId: string): Promise<OrganizationRow> {
    const row = await db.organization.findUnique({ where: { id: organizationId } });
    if (!row) {
      throw ApiException.notFound('Organization', organizationId);
    }
    return row;
  }
}
