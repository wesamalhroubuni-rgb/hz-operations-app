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
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { MembershipsService } from './memberships.service';

@ApiTags('memberships')
@Controller('memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  @ApiDocs({
    summary: 'List memberships (roles and their scope)',
    query: listMembershipsQuerySchema,
    response: membershipListSchema,
  })
  list(
    @Query(new ZodPipe(listMembershipsQuerySchema)) query: ListMembershipsQuery,
  ): Promise<Paginated<Membership>> {
    return this.memberships.list(requireActor().organizationId, query);
  }

  @Get(':id')
  @ApiDocs({
    summary: 'Get a membership',
    response: membershipSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Membership> {
    return this.memberships.get(requireActor().organizationId, id);
  }

  @Post()
  @ApiDocs({
    summary: 'Give a user a role with a scope',
    body: createMembershipSchema,
    response: membershipSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createMembershipSchema)) body: CreateMembership): Promise<Membership> {
    return this.memberships.create(requireActor().organizationId, body);
  }

  @Patch(':id')
  @ApiDocs({
    summary: "Change a membership's role or replace its scope",
    body: updateMembershipSchema,
    response: membershipSchema,
    errors: [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateMembershipSchema)) body: UpdateMembership,
  ): Promise<Membership> {
    return this.memberships.update(requireActor().organizationId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a membership',
    response: membershipSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Membership> {
    return this.memberships.archive(requireActor().organizationId, id);
  }
}
