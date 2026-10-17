import { Injectable } from '@nestjs/common';
import type {
  ChangeTaskStatus,
  CreateTask,
  ListTasksQuery,
  Paginated,
  Task,
  UpdateTask,
} from '@ops/shared';
import type { Prisma } from '../../generated/prisma/client';
import { ApiException, orderByArgs, pageArgs, paginated } from '../../platform/http';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AccessService,
  assignableUserWhere,
  authorOf,
  canChangeTaskStatus,
  canManageTask,
  canPlaceTask,
  enforce,
  siteVisibilityWhere,
  taskVisibilityWhere,
  teamVisibilityWhere,
  type AccessContext,
  type TaskFacts,
} from '../access';
import { ChangeRecorder } from '../common/change-recorder';
import { activeUnless, contains, iso, isoOrNull, type Db } from '../common/db';
import { assertActiveReferences, ref } from '../common/references';

/** A task is always read together with its assignees. */
const TASK_INCLUDE = {
  assignees: { select: { userId: true }, orderBy: { userId: 'asc' } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

/**
 * The task as sent to everyone who may see it. People appear as ids only (`createdById`,
 * `assigneeIds`); a client resolves them through `/users`, which answers with the shape the
 * caller is entitled to, so a worker never receives a colleague's contact details through a task.
 */
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
    statusReason: row.statusReason,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: isoOrNull(row.archivedAt),
  };
}

/** What the access rules read from a task. */
function factsOf(task: Task): TaskFacts {
  return {
    siteId: task.siteId,
    teamId: task.teamId,
    createdById: task.createdById,
    assigneeIds: task.assigneeIds,
    status: task.status,
  };
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly changes: ChangeRecorder,
    private readonly access: AccessService,
  ) {}

  /** The tasks the caller may see. The filters asked for can only narrow that set. */
  async list(query: ListTasksQuery): Promise<Paginated<Task>> {
    const context = await this.access.context();
    const where: Prisma.TaskWhereInput = {
      organizationId: context.organizationId,
      ...activeUnless(query.includeArchived),
      AND: [taskVisibilityWhere(context) as Prisma.TaskWhereInput],
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

  async get(id: string): Promise<Task> {
    return toTask(await this.find(this.prisma, await this.access.context(), id));
  }

  /**
   * Creates a task. The creator is the signed-in user. The site, the team and the assignees
   * must be ones the caller may see and assign (422, as for an id that does not exist), and the
   * task must be placed within the caller's scope (403).
   */
  async create(input: CreateTask): Promise<Task> {
    const context = await this.access.context();
    const { organizationId } = context;
    const createdById = authorOf(context);
    return this.prisma.$transaction(async (tx) => {
      await assertActiveReferences(tx, organizationId, [
        ...ref('site', 'siteId', input.siteId, siteVisibilityWhere(context)),
        ...ref('team', 'teamId', input.teamId, teamVisibilityWhere(context)),
        ...ref('user', 'assigneeIds', input.assigneeIds, assignableUserWhere(context)),
      ]);
      enforce(
        canPlaceTask(context, { siteId: input.siteId ?? null, teamId: input.teamId ?? null }),
        'Task',
      );
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

  /** Edits a task the caller manages. Moving it must leave it within the caller's scope. */
  async update(id: string, input: UpdateTask): Promise<Task> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.find(tx, context, id));
      enforce(canManageTask(context, factsOf(before)), 'Task', id);
      assertNotArchived(before);
      await assertActiveReferences(tx, organizationId, [
        ...ref('site', 'siteId', input.siteId, siteVisibilityWhere(context)),
        ...ref('team', 'teamId', input.teamId, teamVisibilityWhere(context)),
      ]);
      enforce(
        canPlaceTask(context, {
          siteId: input.siteId === undefined ? before.siteId : input.siteId,
          teamId: input.teamId === undefined ? before.teamId : input.teamId,
        }),
        'Task',
        id,
      );
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
   * Moves the task to another status (`canChangeTaskStatus`: whoever manages it to any status,
   * an assignee to todo, in_progress, blocked or done). `completedAt` is set when the task
   * becomes `done` and cleared when it leaves `done`. `reason` becomes the task's
   * `statusReason` (required for `blocked` by the schema); a change without one clears it.
   * Sending the status and reason the task already has changes and records nothing; the same
   * status with another reason updates the reason (an event with `from === to`).
   *
   * Outbox payload of `task.status_changed`: `{ from, to, reason, changedById, createdById,
   * assigneeIds, task }`.
   */
  async changeStatus(id: string, input: ChangeTaskStatus): Promise<Task> {
    const context = await this.access.context();
    const { status } = input;
    const reason = input.reason ?? null;
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.find(tx, context, id));
      enforce(canChangeTaskStatus(context, factsOf(before), status), 'Task', id);
      assertNotArchived(before);
      if (before.status === status && before.statusReason === reason) {
        return before;
      }
      const completedAt =
        status === 'done' ? (before.status === 'done' ? undefined : new Date()) : null;
      const task = toTask(
        await tx.task.update({
          where: { id },
          data: { status, statusReason: reason, completedAt },
          include: TASK_INCLUDE,
        }),
      );
      await this.changes.record(tx, {
        organizationId: context.organizationId,
        entityType: 'task',
        verb: 'status_changed',
        entityId: id,
        before,
        after: task,
        extra: {
          from: before.status,
          to: status,
          reason,
          changedById: context.system ? null : context.userId,
          createdById: task.createdById,
          assigneeIds: task.assigneeIds,
        },
      });
      return task;
    });
  }

  /**
   * Replaces the assignee list of a task the caller manages. Sending the list the task already
   * has records nothing.
   */
  async setAssignees(id: string, assigneeIds: string[]): Promise<Task> {
    const context = await this.access.context();
    const { organizationId } = context;
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.find(tx, context, id));
      enforce(canManageTask(context, factsOf(before)), 'Task', id);
      assertNotArchived(before);
      const added = assigneeIds.filter((userId) => !before.assigneeIds.includes(userId));
      const removed = before.assigneeIds.filter((userId) => !assigneeIds.includes(userId));
      if (added.length === 0 && removed.length === 0) {
        return before;
      }
      // Only new assignees are checked: they must be active and be people the caller may
      // assign. Someone already on the list (archived since, or assigned by a manager) may stay.
      const assignable = assignableUserWhere(context);
      await assertActiveReferences(
        tx,
        organizationId,
        assigneeIds.flatMap((userId, index) =>
          added.includes(userId) ? ref('user', `assigneeIds.${index}`, userId, assignable) : [],
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

  /** Archives a task the caller manages. Archiving an archived task changes and records nothing. */
  async archive(id: string): Promise<Task> {
    const context = await this.access.context();
    return this.prisma.$transaction(async (tx) => {
      const before = toTask(await this.find(tx, context, id));
      enforce(canManageTask(context, factsOf(before)), 'Task', id);
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
        organizationId: context.organizationId,
        entityType: 'task',
        verb: 'archived',
        entityId: id,
        before,
        after: task,
      });
      return task;
    });
  }

  /** The task, if the caller may see it; 404 otherwise (also for another organization). */
  private async find(db: Db, context: AccessContext, id: string): Promise<TaskRow> {
    const row = await db.task.findFirst({
      where: {
        id,
        organizationId: context.organizationId,
        AND: [taskVisibilityWhere(context) as Prisma.TaskWhereInput],
      },
      include: TASK_INCLUDE,
    });
    if (!row) {
      throw ApiException.notFound('Task', id);
    }
    return row;
  }
}

/** 409 for a write to an archived task. Checked after the permission, so a 403 comes first. */
function assertNotArchived(task: Task): void {
  if (task.archivedAt !== null) {
    throw ApiException.conflict(`Task ${task.id} is archived and cannot be changed`);
  }
}
