import { Injectable } from '@nestjs/common';
import type { CreateTeam, ListTeamsQuery, Paginated, Team, UpdateTeam } from '@ops/shared';
import type { Prisma, Team as TeamRow } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, contains, iso, isoOrNull, type Db } from '../common/db';
import { assertValidParent } from '../common/references';

export function toTeam(row: TeamRow): Team {
  return {
    id: row.id,
    organizationId: row.organizationId,
    parentId: row.parentId,
    name: row.name,
    description: row.description,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async list(organizationId: string, query: ListTeamsQuery): Promise<Paginated<Team>> {
    const where: Prisma.TeamWhereInput = {
      organizationId,
      ...activeUnless(query.includeArchived),
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.search ? { name: contains(query.search) } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.team.findMany({ where, orderBy: orderByArgs(query.sort), ...pageArgs(query) }),
      this.prisma.team.count({ where }),
    ]);
    return paginated(rows.map(toTeam), total, query);
  }

  async get(organizationId: string, id: string): Promise<Team> {
    return toTeam(await this.find(this.prisma, organizationId, id));
  }

  async create(organizationId: string, input: CreateTeam): Promise<Team> {
    return this.prisma.$transaction(async (tx) => {
      await assertValidParent(tx, 'team', organizationId, null, input.parentId);
      const team = toTeam(await tx.team.create({ data: { ...input, organizationId } }));
      await this.changes.record(tx, {
        organizationId,
        entityType: 'team',
        verb: 'created',
        entityId: team.id,
        after: team,
      });
      return team;
    });
  }

  async update(organizationId: string, id: string, input: UpdateTeam): Promise<Team> {
    return this.prisma.$transaction(async (tx) => {
      const before = toTeam(await this.findActive(tx, organizationId, id));
      await assertValidParent(tx, 'team', organizationId, id, input.parentId);
      const team = toTeam(await tx.team.update({ where: { id }, data: input }));
      await this.changes.record(tx, {
        organizationId,
        entityType: 'team',
        verb: 'updated',
        entityId: id,
        before,
        after: team,
      });
      return team;
    });
  }

  /** Archives the team. Its children, memberships and history are left as they are. */
  async archive(organizationId: string, id: string): Promise<Team> {
    return this.setArchived(organizationId, id, true);
  }

  async restore(organizationId: string, id: string): Promise<Team> {
    return this.setArchived(organizationId, id, false);
  }

  /** Archiving an archived team (or restoring an active one) changes and records nothing. */
  private async setArchived(organizationId: string, id: string, archived: boolean): Promise<Team> {
    return this.prisma.$transaction(async (tx) => {
      const before = toTeam(await this.find(tx, organizationId, id));
      if ((before.archivedAt !== null) === archived) {
        return before;
      }
      const team = toTeam(
        await tx.team.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'team',
        verb: archived ? 'archived' : 'restored',
        entityId: id,
        before,
        after: team,
      });
      return team;
    });
  }

  private async find(db: Db, organizationId: string, id: string): Promise<TeamRow> {
    const row = await db.team.findFirst({ where: { id, organizationId } });
    if (!row) {
      throw ApiException.notFound('Team', id);
    }
    return row;
  }

  private async findActive(db: Db, organizationId: string, id: string): Promise<TeamRow> {
    const row = await this.find(db, organizationId, id);
    if (row.archivedAt) {
      throw ApiException.conflict(`Team ${id} is archived; restore it before changing it`);
    }
    return row;
  }
}
