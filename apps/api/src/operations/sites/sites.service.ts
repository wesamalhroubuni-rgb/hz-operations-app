import { Injectable } from '@nestjs/common';
import type { CreateSite, ListSitesQuery, Paginated, Site, UpdateSite } from '@ops/shared';
import type { Prisma, Site as SiteRow } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, contains, iso, isoOrNull, type Db } from '../common/db';
import { assertValidParent } from '../common/references';

export function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    organizationId: row.organizationId,
    parentId: row.parentId,
    name: row.name,
    code: row.code,
    description: row.description,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async list(organizationId: string, query: ListSitesQuery): Promise<Paginated<Site>> {
    const where: Prisma.SiteWhereInput = {
      organizationId,
      ...activeUnless(query.includeArchived),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.search
        ? { OR: [{ name: contains(query.search) }, { code: contains(query.search) }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.site.findMany({ where, orderBy: orderByArgs(query.sort), ...pageArgs(query) }),
      this.prisma.site.count({ where }),
    ]);
    return paginated(rows.map(toSite), total, query);
  }

  async get(organizationId: string, id: string): Promise<Site> {
    return toSite(await this.find(this.prisma, organizationId, id));
  }

  async create(organizationId: string, input: CreateSite): Promise<Site> {
    return this.prisma.$transaction(async (tx) => {
      await assertValidParent(tx, 'site', organizationId, null, input.parentId);
      const site = toSite(await tx.site.create({ data: { ...input, organizationId } }));
      await this.changes.record(tx, {
        organizationId,
        entityType: 'site',
        verb: 'created',
        entityId: site.id,
        after: site,
      });
      return site;
    });
  }

  async update(organizationId: string, id: string, input: UpdateSite): Promise<Site> {
    return this.prisma.$transaction(async (tx) => {
      const before = toSite(await this.findActive(tx, organizationId, id));
      await assertValidParent(tx, 'site', organizationId, id, input.parentId);
      const site = toSite(await tx.site.update({ where: { id }, data: input }));
      await this.changes.record(tx, {
        organizationId,
        entityType: 'site',
        verb: 'updated',
        entityId: id,
        before,
        after: site,
      });
      return site;
    });
  }

  /** Archives the site. Its children, memberships and history are left as they are. */
  async archive(organizationId: string, id: string): Promise<Site> {
    return this.setArchived(organizationId, id, true);
  }

  async restore(organizationId: string, id: string): Promise<Site> {
    return this.setArchived(organizationId, id, false);
  }

  /** Archiving an archived site (or restoring an active one) changes and records nothing. */
  private async setArchived(organizationId: string, id: string, archived: boolean): Promise<Site> {
    return this.prisma.$transaction(async (tx) => {
      const before = toSite(await this.find(tx, organizationId, id));
      if ((before.archivedAt !== null) === archived) {
        return before;
      }
      const site = toSite(
        await tx.site.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'site',
        verb: archived ? 'archived' : 'restored',
        entityId: id,
        before,
        after: site,
      });
      return site;
    });
  }

  private async find(db: Db, organizationId: string, id: string): Promise<SiteRow> {
    const row = await db.site.findFirst({ where: { id, organizationId } });
    if (!row) {
      throw ApiException.notFound('Site', id);
    }
    return row;
  }

  private async findActive(db: Db, organizationId: string, id: string): Promise<SiteRow> {
    const row = await this.find(db, organizationId, id);
    if (row.archivedAt) {
      throw ApiException.conflict(`Site ${id} is archived; restore it before changing it`);
    }
    return row;
  }
}
