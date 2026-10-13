import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  createUserSchema,
  idSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userListSchema,
  userSchema,
  type CreateUser,
  type ListUsersQuery,
  type Paginated,
  type UpdateUser,
  type User,
} from '@ops/shared';
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiDocs({
    summary: 'List users, each with their active memberships',
    query: listUsersQuerySchema,
    response: userListSchema,
  })
  list(@Query(new ZodPipe(listUsersQuerySchema)) query: ListUsersQuery): Promise<Paginated<User>> {
    return this.users.list(requireActor().organizationId, query);
  }

  @Get(':id')
  @ApiDocs({ summary: 'Get a user', response: userSchema, errors: [HttpStatus.NOT_FOUND] })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<User> {
    return this.users.get(requireActor().organizationId, id);
  }

  @Post()
  @ApiDocs({
    summary: 'Create a user',
    description: 'A new user has no role until a membership is created for them.',
    body: createUserSchema,
    response: userSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.CONFLICT],
  })
  create(@Body(new ZodPipe(createUserSchema)) body: CreateUser): Promise<User> {
    return this.users.create(requireActor().organizationId, body);
  }

  @Patch(':id')
  @ApiDocs({
    summary: 'Update a user',
    body: updateUserSchema,
    response: userSchema,
    errors: [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: UpdateUser,
  ): Promise<User> {
    return this.users.update(requireActor().organizationId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({ summary: 'Archive a user', response: userSchema, errors: [HttpStatus.NOT_FOUND] })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<User> {
    return this.users.archive(requireActor().organizationId, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Restore an archived user',
    response: userSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  restore(@Param('id', new ZodPipe(idSchema)) id: string): Promise<User> {
    return this.users.restore(requireActor().organizationId, id);
  }
}
