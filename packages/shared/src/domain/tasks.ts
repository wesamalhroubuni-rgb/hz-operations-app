import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import {
  paginatedSchema,
  paginationQuerySchema,
  sortQuerySchema,
  type Paginated,
} from '../common/pagination.js';
import { idSchema, isoDateTimeSchema, queryBooleanSchema } from '../common/primitives.js';
import { taskPrioritySchema, taskStatusSchema } from './enums.js';
import {
  AT_LEAST_ONE_FIELD,
  atLeastOneField,
  longTextSchema,
  nameSchema,
  nullableIsoDateTimeSchema,
  searchQuerySchema,
  uniqueIdListSchema,
  type ListQueryParams,
} from './shared.js';

export const MAX_TASK_ASSIGNEES = 50;

/** `completedAt` is set by the API when the status becomes `done` and cleared when it leaves. */
export const taskSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  siteId: idSchema.nullable(),
  teamId: idSchema.nullable(),
  createdById: idSchema,
  assigneeIds: z.array(idSchema),
  dueAt: nullableIsoDateTimeSchema,
  completedAt: nullableIsoDateTimeSchema,
  /** Why the task has its current status (always set for `blocked`), or null. */
  statusReason: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  archivedAt: nullableIsoDateTimeSchema,
});
export type Task = z.infer<typeof taskSchema>;

const assigneeIdsSchema = uniqueIdListSchema(MAX_TASK_ASSIGNEES);

/** The creator is the acting user. */
export const createTaskSchema = z.strictObject({
  title: nameSchema,
  description: longTextSchema.nullable().optional(),
  status: taskStatusSchema.default('todo'),
  priority: taskPrioritySchema.default('normal'),
  siteId: idSchema.nullable().optional(),
  teamId: idSchema.nullable().optional(),
  assigneeIds: assigneeIdsSchema.default([]),
  dueAt: isoDateTimeSchema.nullable().optional(),
});
export type CreateTask = z.infer<typeof createTaskSchema>;
export type CreateTaskInput = z.input<typeof createTaskSchema>;

/**
 * A field left out is unchanged; `null` clears it. Status and assignees have their own
 * endpoints because they emit their own events.
 */
export const updateTaskSchema = z
  .strictObject({
    title: nameSchema.optional(),
    description: longTextSchema.nullable().optional(),
    priority: taskPrioritySchema.optional(),
    siteId: idSchema.nullable().optional(),
    teamId: idSchema.nullable().optional(),
    dueAt: isoDateTimeSchema.nullable().optional(),
  })
  .refine(atLeastOneField, AT_LEAST_ONE_FIELD);
export type UpdateTask = z.infer<typeof updateTaskSchema>;

export const TASK_STATUS_REASON_MAX_LENGTH = 1000;

/**
 * A status change. `reason` says why; it is required when moving to `blocked` and stored as the
 * task's `statusReason` (a change without a reason clears it).
 */
export const changeTaskStatusSchema = z
  .strictObject({
    status: taskStatusSchema,
    reason: z.string().trim().min(1).max(TASK_STATUS_REASON_MAX_LENGTH).optional(),
  })
  .refine((body) => body.status !== 'blocked' || body.reason !== undefined, {
    path: ['reason'],
    error: 'is required when the task is blocked',
  });
export type ChangeTaskStatus = z.infer<typeof changeTaskStatusSchema>;

/** Replaces the whole assignee list. */
export const setTaskAssigneesSchema = z.strictObject({ assigneeIds: assigneeIdsSchema });
export type SetTaskAssignees = z.infer<typeof setTaskAssigneesSchema>;

export const TASK_SORT_FIELDS = ['createdAt', 'dueAt', 'priority', 'status', 'updatedAt'] as const;

/** `dueFrom` is inclusive, `dueTo` is exclusive. */
export const listTasksQuerySchema = paginationQuerySchema.extend({
  sort: sortQuerySchema(TASK_SORT_FIELDS, { field: 'createdAt', direction: 'desc' }),
  search: searchQuerySchema,
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  siteId: idSchema.optional(),
  teamId: idSchema.optional(),
  assigneeId: idSchema.optional(),
  createdById: idSchema.optional(),
  dueFrom: isoDateTimeSchema.optional(),
  dueTo: isoDateTimeSchema.optional(),
  includeArchived: queryBooleanSchema.default(false),
});
export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

export const taskListSchema = paginatedSchema(taskSchema);

export function tasksEndpoints(transport: ApiTransport) {
  return {
    list(
      query: ListQueryParams<typeof listTasksQuerySchema> = {},
    ): Promise<ApiResult<Paginated<Task>>> {
      return transport.request({ path: '/tasks', query, schema: taskListSchema });
    },
    get(id: string): Promise<ApiResult<Task>> {
      return transport.request({ path: `/tasks/${id}`, schema: taskSchema });
    },
    create(body: CreateTaskInput): Promise<ApiResult<Task>> {
      return transport.request({ method: 'POST', path: '/tasks', body, schema: taskSchema });
    },
    update(id: string, body: UpdateTask): Promise<ApiResult<Task>> {
      return transport.request({ method: 'PATCH', path: `/tasks/${id}`, body, schema: taskSchema });
    },
    changeStatus(id: string, body: ChangeTaskStatus): Promise<ApiResult<Task>> {
      return transport.request({
        method: 'PATCH',
        path: `/tasks/${id}/status`,
        body,
        schema: taskSchema,
      });
    },
    setAssignees(id: string, body: SetTaskAssignees): Promise<ApiResult<Task>> {
      return transport.request({
        method: 'PUT',
        path: `/tasks/${id}/assignees`,
        body,
        schema: taskSchema,
      });
    },
    archive(id: string): Promise<ApiResult<Task>> {
      return transport.request({
        method: 'POST',
        path: `/tasks/${id}/archive`,
        schema: taskSchema,
      });
    },
  };
}
