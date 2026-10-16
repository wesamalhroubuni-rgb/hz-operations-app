import { Injectable } from '@nestjs/common';
import type { CreateSite, ListSitesQuery, Paginated, Site, UpdateSite } from '@ops/shared';
import type { Prisma, Site as SiteRow } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService, siteVisibilityWhere, type AccessContext } from '../access';
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

/**
 * Reading follows `siteVisibility`. Managing is for managers and admins (route policy
 * `site.manage`), who see every site, so the writes need no further object-level rule.
 */
@Injectable()
export class SitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
  ) {}

  async list(query: ListSitesQuery): Promise<Paginated<Site>> {
    const context = await this.access.context();
    const where: Prisma.SiteWhereInput = {
      organizationId: context.organizationId,
      ...activeUnless(query.includeArchived),
      AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput],
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

  async get(id: string): Promise<Site> {
    return toSite(await this.find(this.prisma, await this.access.context(), id));
  }

  async create(input: CreateSite): Promise<Site> {
    const { organizationId } = await this.access.context();
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

  async update(id: string, input: UpdateSite): Promise<Site> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const before = toSite(await this.findActive(tx, context, id));
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
  async archive(id: string): Promise<Site> {
    return this.setArchived(id, true);
  }

  async restore(id: string): Promise<Site> {
    return this.setArchived(id, false);
  }

  /** Archiving an archived site (or restoring an active one) changes and records nothing. */
  private async setArchived(id: string, archived: boolean): Promise<Site> {
    const context = await this.access.context();
    return this.prisma.$transaction(async (tx) => {
      const before = toSite(await this.find(tx, context, id));
      if ((before.archivedAt !== null) === archived) {
        return before;
      }
      const site = toSite(
        await tx.site.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } }),
      );
      await this.changes.record(tx, {
        organizationId: context.organizationId,
        entityType: 'site',
        verb: archived ? 'archived' : 'restored',
        entityId: id,
        before,
        after: site,
      });
      return site;
    });
  }

  /** The site, if the caller may see it; 404 otherwise (also for another organization). */
  private async find(db: Db, context: AccessContext, id: string): Promise<SiteRow> {
    const row = await db.site.findFirst({
      where: {
        id,
        organizationId: context.organizationId,
        AND: [siteVisibilityWhere(context) as Prisma.SiteWhereInput],
      },
    });
    if (!row) {
      throw ApiException.notFound('Site', id);
    }
    return row;
  }

  private async findActive(db: Db, context: AccessContext, id: string): Promise<SiteRow> {
    const row = await this.find(db, context, id);
    if (row.archivedAt) {
      throw ApiException.conflict(`Site ${id} is archived; restore it before changing it`);
    }
    return row;
  }
}
