import { Injectable } from '@nestjs/common';
import type {
  CreateTask,
  ListTasksQuery,
  Paginated,
  Task,
  TaskStatus,
  UpdateTask,
} from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, contains, iso, isoOrNull, type Db } from '../common/db';
import { assertActiveReferences, ref } from '../common/references';

/** A task is always read together with its assignees. */
const TASK_INCLUDE = {
  assignees: { select: { userId: true }, orderBy: { userId: 'asc' } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    siteId: row.siteId,
    teamId: row.teamId,
    createdById: row.createdById,
    assigneeIds: row.assignees.map((assignee) => assignee.userId),
    dueAt: isoOrNull(row.dueAt),
    completedAt: isoOrNull(row.completedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
  ) {}

  async list(organizationId: string, query: ListTasksQuery): Promise<Paginated<Task>> {
    const where: Prisma.TaskWhereInput = {
      organizationId,
      ...activeUnless(query.includeArchived),
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.siteId ? { siteId: query.siteId } : {}),
      ...(query.teamId ? { teamId: query.teamId } : {}),
      ...(query.createdById ? { createdById: query.createdById } : {}),
      ...(query.assigneeId ? { assignees: { some: { userId: query.assigneeId } } } : {}),
      ...(query.dueFrom || query.dueTo
        ? {
            dueAt: {
              ...(query.dueFrom ? { gte: new Date(query.dueFrom) } : {}),
              ...(query.dueTo ? { lt: new Date(query.dueTo) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? { OR: [{ title: contains(query.search) }, { description: contains(query.search) }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        include: TASK_INCLUDE,
        orderBy: orderByArgs(query.sort),
        ...pageArgs(query),
      }),
      this.prisma.task.count({ where }),
    ]);
    return paginated(rows.map(toTask), total, query);
  }

  async get(organizationId: string, id: string): Promise<Task> {
    return toTask(await this.find(this.prisma, organizationId, id));
  }

  /** @param createdById the acting user, recorded as the task's creator */
  async create(organizationId: string, createdById: string, input: CreateTask): Promise<Task> {
    return this.prisma.$transaction(async (tx) => {
      await assertActiveReferences(tx, organizationId, [
        ...ref('user', 'createdById', createdById),
        ...ref('site', 'siteId', input.siteId),
        ...ref('team', 'teamId', input.teamId),
        ...ref('user', 'assigneeIds', input.assigneeIds),
      ]);
      const task = toTask(
        await tx.task.create({
          data: {
            organizationId,
            createdById,
            title: input.title,
            description: input.description,
            status: input.status,
            priority: input.priority,
            siteId: input.siteId,
            teamId: input.teamId,
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            completedAt: input.status === 'done' ? new Date() : null,
            assignees: {
              create: input.assigneeIds.map((userId) => ({ userId, organizationId })),
            },
          },
          include: TASK_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'task',
        verb: 'created',
        entityId: task.id,
        after: task,
      });
      return task;
    });
  }

  async update(organizationId: string, id: string, input: UpdateTask): Promise<Task> {
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.findActive(tx, organizationId, id));
      await assertActiveReferences(tx, organizationId, [
        ...ref('site', 'siteId', input.siteId),
        ...ref('team', 'teamId', input.teamId),
      ]);
      const task = toTask(
        await tx.task.update({
          where: { id },
          data: {
            title: input.title,
            description: input.description,
            priority: input.priority,
            siteId: input.siteId,
            teamId: input.teamId,
            dueAt:
              input.dueAt === undefined || input.dueAt === null
                ? input.dueAt
                : new Date(input.dueAt),
          },
          include: TASK_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'task',
        verb: 'updated',
        entityId: id,
        before,
        after: task,
      });
      return task;
    });
  }

  /**
   * Moves the task to another status. `completedAt` is set when the task becomes `done` and
   * cleared when it leaves `done`. Setting the status it already has changes and records nothing.
   */
  async changeStatus(organizationId: string, id: string, status: TaskStatus): Promise<Task> {
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.findActive(tx, organizationId, id));
      if (before.status === status) {
        return before;
      }
      const task = toTask(
        await tx.task.update({
          where: { id },
          data: { status, completedAt: status === 'done' ? new Date() : null },
          include: TASK_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'task',
        verb: 'status_changed',
        entityId: id,
        before,
        after: task,
        extra: { from: before.status, to: status },
      });
      return task;
    });
  }

  /** Replaces the assignee list. Sending the list the task already has records nothing. */
  async setAssignees(organizationId: string, id: string, assigneeIds: string[]): Promise<Task> {
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.findActive(tx, organizationId, id));
      const added = assigneeIds.filter((userId) => !before.assigneeIds.includes(userId));
      const removed = before.assigneeIds.filter((userId) => !assigneeIds.includes(userId));
      if (added.length === 0 && removed.length === 0) {
        return before;
      }
      // Only new assignees must be active: someone archived since may stay on the list.
      await assertActiveReferences(
        tx,
        organizationId,
        assigneeIds.flatMap((userId, index) =>
          added.includes(userId) ? ref('user', `assigneeIds.${index}`, userId) : [],
        ),
      );
      await tx.taskAssignee.deleteMany({ where: { taskId: id, userId: { in: removed } } });
      await tx.taskAssignee.createMany({
        data: added.map((userId) => ({ taskId: id, userId, organizationId })),
      });
      const task = toTask(
        await tx.task.update({
          where: { id },
          data: { updatedAt: new Date() },
          include: TASK_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'task',
        verb: 'assignees_changed',
        entityId: id,
        before,
        after: task,
        extra: { added, removed },
      });
      return task;
    });
  }

  /** Archiving an archived task changes and records nothing. */
  async archive(organizationId: string, id: string): Promise<Task> {
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.find(tx, organizationId, id));
      if (before.archivedAt !== null) {
        return before;
      }
      const task = toTask(
        await tx.task.update({
          where: { id },
          data: { archivedAt: new Date() },
          include: TASK_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId,
        entityType: 'task',
        verb: 'archived',
        entityId: id,
        before,
        after: task,
      });
      return task;
    });
  }

  private async find(db: Db, organizationId: string, id: string): Promise<TaskRow> {
    const row = await db.task.findFirst({ where: { id, organizationId }, include: TASK_INCLUDE });
    if (!row) {
      throw ApiException.notFound('Task', id);
    }
    return row;
  }

  private async findActive(db: Db, organizationId: string, id: string): Promise<TaskRow> {
    const row = await this.find(db, organizationId, id);
    if (row.archivedAt) {
      throw ApiException.conflict(`Task ${id} is archived and cannot be changed`);
    }
    return row;
  }
}
