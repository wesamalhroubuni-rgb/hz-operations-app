import { Injectable } from '@nestjs/common';
import type { CreateTeam, ListTeamsQuery, Paginated, Team, UpdateTeam } from '@ops/shared';
import type { Prisma, Team as TeamRow } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService, teamVisibilityWhere, type AccessContext } from '../access';
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

/**
 * Reading follows `teamVisibility`. Managing is for managers and admins (route policy
 * `team.manage`), who see every team, so the writes need no further object-level rule.
 */
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
  ) {}

  async list(query: ListTeamsQuery): Promise<Paginated<Team>> {
    const context = await this.access.context();
    const where: Prisma.TeamWhereInput = {
      organizationId: context.organizationId,
      ...activeUnless(query.includeArchived),
      AND: [teamVisibilityWhere(context) as Prisma.TeamWhereInput],
      ...(query.parentId ? { parentId: query.parentId } : {}),
      ...(query.search ? { name: contains(query.search) } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.team.findMany({ where, orderBy: orderByArgs(query.sort), ...pageArgs(query) }),
      this.prisma.team.count({ where }),
    ]);
    return paginated(rows.map(toTeam), total, query);
  }

  async get(id: string): Promise<Team> {
    return toTeam(await this.find(this.prisma, await this.access.context(), id));
  }

  async create(input: CreateTeam): Promise<Team> {
    const { organizationId } = await this.access.context();
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

  async update(id: string, input: UpdateTeam): Promise<Team> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const before = toTeam(await this.findActive(tx, context, id));
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
  async archive(id: string): Promise<Team> {
    return this.setArchived(id, true);
  }

  async restore(id: string): Promise<Team> {
    return this.setArchived(id, false);
  }

  /** Archiving an archived team (or restoring an active one) changes and records nothing. */
  private async setArchived(id: string, archived: boolean): Promise<Team> {
    const context = await this.access.context();
    return this.prisma.$transaction(async (tx) => {
      const before = toTeam(await this.find(tx, context, id));
      if ((before.archivedAt !== null) === archived) {
        return before;
      }
      const team = toTeam(
        await tx.team.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } }),
      );
      await this.changes.record(tx, {
        organizationId: context.organizationId,
        entityType: 'team',
        verb: archived ? 'archived' : 'restored',
        entityId: id,
        before,
        after: team,
      });
      return team;
    });
  }

  /** The team, if the caller may see it; 404 otherwise (also for another organization). */
  private async find(db: Db, context: AccessContext, id: string): Promise<TeamRow> {
    const row = await db.team.findFirst({
      where: {
        id,
        organizationId: context.organizationId,
        AND: [teamVisibilityWhere(context) as Prisma.TeamWhereInput],
      },
    });
    if (!row) {
      throw ApiException.notFound('Team', id);
    }
    return row;
  }

  private async findActive(db: Db, context: AccessContext, id: string): Promise<TeamRow> {
    const row = await this.find(db, context, id);
    if (row.archivedAt) {
      throw ApiException.conflict(`Team ${id} is archived; restore it before changing it`);
    }
    return row;
  }
}
