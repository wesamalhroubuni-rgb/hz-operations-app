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
  createdUserSchema,
  createUserSchema,
  idSchema,
  issuedCodeSchema,
  listUsersQuerySchema,
  updateUserSchema,
  userFullSchema,
  userListSchema,
  userSchema,
  type CreatedUser,
  type CreateUser,
  type IssuedCode,
  type ListUsersQuery,
  type Paginated,
  type UpdateUser,
  type User,
  type UserFull,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { UsersService } from './users.service';

const SHAPES =
  'Each user comes in the shape the caller is entitled to, named by `profile`: `full` (an ' +
  'admin for everyone, anyone for themselves), `contact` (a manager for everyone, a supervisor ' +
  'for their people) or `basic` (id, name and roles: everybody else the caller can see).';

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Policy('user.read')
  @ApiDocs({
    summary: 'List the users the caller may see',
    description:
      `${SHAPES} \`search\` matches the name, and the email and phone only of users whose ` +
      'contact details the caller may see. Sorting by email needs contact access to everyone.',
    query: listUsersQuerySchema,
    response: userListSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  list(@Query(new ZodPipe(listUsersQuerySchema)) query: ListUsersQuery): Promise<Paginated<User>> {
    return this.users.list(query);
  }

  @Get(':id')
  @Policy('user.read')
  @ApiDocs({
    summary: 'Get a user',
    description: `${SHAPES} A user the caller may not see answers 404.`,
    response: userSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<User> {
    return this.users.get(id);
  }

  @Post()
  @Policy('user.manage')
  @ApiDocs({
    summary: 'Create a user',
    description:
      'Admins only. Needs a display name and at least one of email, phone and username. The ' +
      'answer carries the one-time activation code (`activation.code` and `activation.link` ' +
      'are filled in development only). The user has no role until a membership is created.',
    body: createUserSchema,
    response: createdUserSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.CONFLICT],
  })
  create(@Body(new ZodPipe(createUserSchema)) body: CreateUser): Promise<CreatedUser> {
    return this.users.create(body);
  }

  @Patch(':id')
  @Policy('user.update')
  @ApiDocs({
    summary: 'Update a user',
    description:
      'An admin changes any field of any user. Everyone else may change only their own ' +
      '`displayName` (403 for any other field or user).',
    body: updateUserSchema,
    response: userFullSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: UpdateUser,
  ): Promise<UserFull> {
    return this.users.update(id, body);
  }

  @Post(':id/archive')
  @Policy('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a user',
    description:
      'Admins only. Ends every session of the user. The last active admin cannot be archived ' +
      '(409).',
    response: userFullSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<UserFull> {
    return this.users.archive(id);
  }

  @Post(':id/restore')
  @Policy('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Restore an archived user',
    description: 'Admins only.',
    response: userFullSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  restore(@Param('id', new ZodPipe(idSchema)) id: string): Promise<UserFull> {
    return this.users.restore(id);
  }

  @Post(':id/activation-code')
  @Policy('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Issue a new activation code',
    description:
      'Admins only. For a user who has not set a password yet; the earlier code stops working. ' +
      'Answers 409 when the user is already activated.',
    response: issuedCodeSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  issueActivationCode(@Param('id', new ZodPipe(idSchema)) id: string): Promise<IssuedCode> {
    return this.users.issueActivationCode(id);
  }

  @Post(':id/password-reset')
  @Policy('user.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Issue a password-reset code',
    description:
      'Admins only. For a user who has set a password before. Answers 409 when the user was ' +
      'never activated.',
    response: issuedCodeSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  issuePasswordReset(@Param('id', new ZodPipe(idSchema)) id: string): Promise<IssuedCode> {
    return this.users.issuePasswordReset(id);
  }
}
