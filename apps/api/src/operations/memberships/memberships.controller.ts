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
  createMembershipSchema,
  idSchema,
  listMembershipsQuerySchema,
  membershipListSchema,
  membershipSchema,
  updateMembershipSchema,
  type CreateMembership,
  type ListMembershipsQuery,
  type Membership,
  type Paginated,
  type UpdateMembership,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { MembershipsService } from './memberships.service';

/** Admins only. */
@ApiTags('memberships')
@Controller('memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @Policy('membership.read')
  @ApiDocs({
    summary: 'List memberships (roles and their scope)',
    description: 'Admins only.',
    query: listMembershipsQuerySchema,
    response: membershipListSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  list(
    @Query(new ZodPipe(listMembershipsQuerySchema)) query: ListMembershipsQuery,
  ): Promise<Paginated<Membership>> {
    return this.memberships.list(query);
  }

  @Get(':id')
  @Policy('membership.read')
  @ApiDocs({
    summary: 'Get a membership',
    description: 'Admins only.',
    response: membershipSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Membership> {
    return this.memberships.get(id);
  }

  @Post()
  @Policy('membership.manage')
  @ApiDocs({
    summary: 'Give a user a role with a scope',
    description:
      'Admins only. A `manager` or `admin` membership must be `orgWide: true` with no sites ' +
      'and no teams (400 otherwise). Nobody grants a role above their own or a scope outside ' +
      'their own (403).',
    body: createMembershipSchema,
    response: membershipSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createMembershipSchema)) body: CreateMembership): Promise<Membership> {
    return this.memberships.create(body);
  }

  @Patch(':id')
  @Policy('membership.manage')
  @ApiDocs({
    summary: "Change a membership's role or replace its scope",
    description:
      'Admins only. The result must respect the same rules as a new membership. Demoting the ' +
      "last active admin answers 409. A reduced role or scope ends the holder's sessions.",
    body: updateMembershipSchema,
    response: membershipSchema,
    errors: [
      HttpStatus.FORBIDDEN,
      HttpStatus.NOT_FOUND,
      HttpStatus.CONFLICT,
      HttpStatus.UNPROCESSABLE_ENTITY,
    ],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateMembershipSchema)) body: UpdateMembership,
  ): Promise<Membership> {
    return this.memberships.update(id, body);
  }

  @Post(':id/archive')
  @Policy('membership.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a membership',
    description:
      "Admins only. Ends the holder's sessions. Archiving the admin membership of the last " +
      'active admin answers 409.',
    response: membershipSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Membership> {
    return this.memberships.archive(id);
  }
}
