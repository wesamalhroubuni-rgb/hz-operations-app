import { Injectable } from '@nestjs/common';
import {
  offlineMaxBackdateDaysOf,
  timeZoneOf,
  workLogEditWindowHoursOf,
  type Organization,
  type OrganizationFull,
  type OrganizationSummary,
  type UpdateOrganization,
} from '@ops/shared';
import type { Organization as OrganizationRow, Prisma } from '../../generated/prisma/client';
import { ApiException } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService, organizationView } from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { iso, isoOrNull, type Db } from '../common/db';

/** What every signed-in user of the organization may see. */
export function toOrganizationSummary(row: OrganizationRow): OrganizationSummary {
  return {
    view: 'summary',
    id: row.id,
    name: row.name,
    slug: row.slug,
    workLogEditWindowHours: workLogEditWindowHoursOf(row.settings),
    offlineMaxBackdateDays: offlineMaxBackdateDaysOf(row.settings),
    timeZone: timeZoneOf(row.settings),
  };
}

/** Everything, for admins; also the shape recorded in the audit log and the outbox. */
export function toOrganizationFull(row: OrganizationRow): OrganizationFull {
  return {
    ...toOrganizationSummary(row),
    view: 'full',
    settings: (row.settings ?? {}) as OrganizationFull['settings'],
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
    private readonly access: AccessService,
  ) {}

  /** The caller's organization, in the shape their role may see. */
  async get(): Promise<Organization> {
    const context = await this.access.context();
    const row = await this.find(this.prisma, context.organizationId);
    return organizationView(context) === 'full'
      ? toOrganizationFull(row)
      : toOrganizationSummary(row);
  }

  /** Admins only (route policy `organization.update`). */
  async update(input: UpdateOrganization): Promise<OrganizationFull> {
    const { organizationId } = await this.access.context();
    return this.prisma.$transaction(async (tx) => {
      const before = toOrganizationFull(await this.find(tx, organizationId));
      const organization = toOrganizationFull(
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
