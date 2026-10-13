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
  setTaskAssigneesSchema,
  taskListSchema,
  taskSchema,
  updateTaskSchema,
  type ChangeTaskStatus,
  type CreateTask,
  type ListTasksQuery,
  type Paginated,
  type SetTaskAssignees,
  type Task,
  type UpdateTask,
} from '@ops/shared';
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { TasksService } from './tasks.service';

const CHANGE_ERRORS = [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY];

@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @ApiDocs({ summary: 'List tasks', query: listTasksQuerySchema, response: taskListSchema })
  list(@Query(new ZodPipe(listTasksQuerySchema)) query: ListTasksQuery): Promise<Paginated<Task>> {
    return this.tasks.list(requireActor().organizationId, query);
  }

  @Get(':id')
  @ApiDocs({ summary: 'Get a task', response: taskSchema, errors: [HttpStatus.NOT_FOUND] })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Task> {
    return this.tasks.get(requireActor().organizationId, id);
  }

  @Post()
  @ApiDocs({
    summary: 'Create a task',
    description: 'The acting user becomes the creator.',
    body: createTaskSchema,
    response: taskSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createTaskSchema)) body: CreateTask): Promise<Task> {
    const actor = requireActor();
    return this.tasks.create(actor.organizationId, actor.userId, body);
  }

  @Patch(':id')
  @ApiDocs({
    summary: 'Update a task',
    body: updateTaskSchema,
    response: taskSchema,
    errors: CHANGE_ERRORS,
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateTaskSchema)) body: UpdateTask,
  ): Promise<Task> {
    return this.tasks.update(requireActor().organizationId, id, body);
  }

  @Patch(':id/status')
  @ApiDocs({
    summary: "Change a task's status",
    description: 'Sets `completedAt` when the task becomes done and clears it when it leaves done.',
    body: changeTaskStatusSchema,
    response: taskSchema,
    errors: CHANGE_ERRORS,
  })
  changeStatus(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(changeTaskStatusSchema)) body: ChangeTaskStatus,
  ): Promise<Task> {
    return this.tasks.changeStatus(requireActor().organizationId, id, body.status);
  }

  @Put(':id/assignees')
  @ApiDocs({
    summary: "Replace a task's assignees",
    body: setTaskAssigneesSchema,
    response: taskSchema,
    errors: CHANGE_ERRORS,
  })
  setAssignees(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(setTaskAssigneesSchema)) body: SetTaskAssignees,
  ): Promise<Task> {
    return this.tasks.setAssignees(requireActor().organizationId, id, body.assigneeIds);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({ summary: 'Archive a task', response: taskSchema, errors: [HttpStatus.NOT_FOUND] })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Task> {
    return this.tasks.archive(requireActor().organizationId, id);
  }
}
