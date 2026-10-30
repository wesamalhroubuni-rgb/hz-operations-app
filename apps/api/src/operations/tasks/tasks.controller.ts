import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  changeTaskStatusSchema,
  createTaskSchema,
  idSchema,
  listTasksQuerySchema,
  recordHistorySchema,
  setTaskAssigneesSchema,
  taskListSchema,
  taskSchema,
  updateTaskSchema,
  type ChangeTaskStatus,
  type CreateTask,
  type ListTasksQuery,
  type Paginated,
  type RecordHistory,
  type SetTaskAssignees,
  type Task,
  type UpdateTask,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { Idempotent } from '../../platform/idempotency';
import { RecordHistoryService } from '../history/record-history.service';
import { TasksService } from './tasks.service';

const CHANGE_ERRORS = [
  HttpStatus.FORBIDDEN,
  HttpStatus.NOT_FOUND,
  HttpStatus.CONFLICT,
  HttpStatus.UNPROCESSABLE_ENTITY,
];

const MANAGE =
  'Supervisors manage the tasks placed in their scope (a site or a team of theirs) and assign ' +
  'their own people; managers and admins manage every task. A task the caller cannot see ' +
  'answers 404; one they can see but not manage answers 403.';

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly histories: RecordHistoryService,
  ) {}

  @Get()
  @Policy('task.read')
  @ApiDocs({
    summary: 'List the tasks the caller may see',
    description:
      'A worker sees the tasks assigned to them; a supervisor also those of their scope and ' +
      'their people; a manager or admin every task. `open` keeps todo, in_progress and ' +
      'blocked tasks (false: done and cancelled); `overdue` keeps open tasks due before now.',
    query: listTasksQuerySchema,
    response: taskListSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  list(@Query(new ZodPipe(listTasksQuerySchema)) query: ListTasksQuery): Promise<Paginated<Task>> {
    return this.tasks.list(query);
  }

  @Get(':id/history')
  @Policy('task.read')
  @ApiDocs({
    summary: "A task's history",
    description:
      'The audit events of the task, oldest first, at most 200: the action, the time, who (a ' +
      'name only for users the caller may see), the changed fields among a fixed list, and ' +
      'whether it came from the offline queue. A task the caller may not see answers 404.',
    response: recordHistorySchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  history(@Param('id', new ZodPipe(idSchema)) id: string): Promise<RecordHistory> {
    return this.histories.task(id);
  }

  @Get(':id')
  @Policy('task.read')
  @ApiDocs({
    summary: 'Get a task',
    response: taskSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Task> {
    return this.tasks.get(id);
  }

  @Post()
  @Policy('task.manage')
  @ApiDocs({
    summary: 'Create a task',
    description: `The signed-in user becomes the creator. ${MANAGE}`,
    body: createTaskSchema,
    response: taskSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createTaskSchema)) body: CreateTask): Promise<Task> {
    return this.tasks.create(body);
  }

  @Patch(':id')
  @Policy('task.manage')
  @ApiDocs({
    summary: 'Update a task',
    description: MANAGE,
    body: updateTaskSchema,
    response: taskSchema,
    errors: CHANGE_ERRORS,
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateTaskSchema)) body: UpdateTask,
  ): Promise<Task> {
    return this.tasks.update(id, body);
  }

  @Patch(':id/status')
  @Policy('task.change_status')
  @Idempotent()
  @ApiDocs({
    summary: "Change a task's status",
    description:
      'Whoever manages the task sets any status. An assignee moves their task between `todo`, ' +
      '`in_progress`, `blocked` and `done`. Sets `completedAt` when the task becomes done and ' +
      'clears it when it leaves done. `reason` (required for `blocked`) is stored as the ' +
      "task's `statusReason`; a change without a reason clears it. Sending the current status " +
      'and reason changes nothing.',
    body: changeTaskStatusSchema,
    response: taskSchema,
    errors: CHANGE_ERRORS,
  })
  changeStatus(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(changeTaskStatusSchema)) body: ChangeTaskStatus,
  ): Promise<Task> {
    return this.tasks.changeStatus(id, body);
  }

  @Put(':id/assignees')
  @Policy('task.manage')
  @ApiDocs({
    summary: "Replace a task's assignees",
    description: MANAGE,
    body: setTaskAssigneesSchema,
    response: taskSchema,
    errors: CHANGE_ERRORS,
  })
  setAssignees(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(setTaskAssigneesSchema)) body: SetTaskAssignees,
  ): Promise<Task> {
    return this.tasks.setAssignees(id, body.assigneeIds);
  }

  @Post(':id/archive')
  @Policy('task.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a task',
    description: MANAGE,
    response: taskSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Task> {
    return this.tasks.archive(id);
  }
}
