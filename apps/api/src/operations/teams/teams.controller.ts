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
  createTeamSchema,
  idSchema,
  listTeamsQuerySchema,
  teamListSchema,
  teamSchema,
  updateTeamSchema,
  type CreateTeam,
  type ListTeamsQuery,
  type Paginated,
  type Team,
  type UpdateTeam,
} from '@ops/shared';
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { TeamsService } from './teams.service';

@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @ApiDocs({ summary: 'List teams', query: listTeamsQuerySchema, response: teamListSchema })
  list(@Query(new ZodPipe(listTeamsQuerySchema)) query: ListTeamsQuery): Promise<Paginated<Team>> {
    return this.teams.list(requireActor().organizationId, query);
  }

  @Get(':id')
  @ApiDocs({ summary: 'Get a team', response: teamSchema, errors: [HttpStatus.NOT_FOUND] })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Team> {
    return this.teams.get(requireActor().organizationId, id);
  }

  @Post()
  @ApiDocs({
    summary: 'Create a team',
    body: createTeamSchema,
    response: teamSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createTeamSchema)) body: CreateTeam): Promise<Team> {
    return this.teams.create(requireActor().organizationId, body);
  }

  @Patch(':id')
  @ApiDocs({
    summary: 'Update a team',
    body: updateTeamSchema,
    response: teamSchema,
    errors: [HttpStatus.NOT_FOUND, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateTeamSchema)) body: UpdateTeam,
  ): Promise<Team> {
    return this.teams.update(requireActor().organizationId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({ summary: 'Archive a team', response: teamSchema, errors: [HttpStatus.NOT_FOUND] })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Team> {
    return this.teams.archive(requireActor().organizationId, id);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Restore an archived team',
    response: teamSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  restore(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Team> {
    return this.teams.restore(requireActor().organizationId, id);
  }
}
