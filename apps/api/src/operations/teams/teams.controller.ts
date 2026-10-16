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
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { TeamsService } from './teams.service';

@ApiTags('teams')
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @Policy('team.read')
  @ApiDocs({ summary: 'List teams', query: listTeamsQuerySchema, response: teamListSchema })
  list(@Query(new ZodPipe(listTeamsQuerySchema)) query: ListTeamsQuery): Promise<Paginated<Team>> {
    return this.teams.list(query);
  }

  @Get(':id')
  @Policy('team.read')
  @ApiDocs({
    summary: 'Get a team',
    response: teamSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  get(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Team> {
    return this.teams.get(id);
  }

  @Post()
  @Policy('team.manage')
  @ApiDocs({
    summary: 'Create a team',
    body: createTeamSchema,
    response: teamSchema,
    status: HttpStatus.CREATED,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.CONFLICT, HttpStatus.UNPROCESSABLE_ENTITY],
  })
  create(@Body(new ZodPipe(createTeamSchema)) body: CreateTeam): Promise<Team> {
    return this.teams.create(body);
  }

  @Patch(':id')
  @Policy('team.manage')
  @ApiDocs({
    summary: 'Update a team',
    body: updateTeamSchema,
    response: teamSchema,
    errors: [
      HttpStatus.FORBIDDEN,
      HttpStatus.NOT_FOUND,
      HttpStatus.CONFLICT,
      HttpStatus.UNPROCESSABLE_ENTITY,
    ],
  })
  update(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateTeamSchema)) body: UpdateTeam,
  ): Promise<Team> {
    return this.teams.update(id, body);
  }

  @Post(':id/archive')
  @Policy('team.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Archive a team',
    response: teamSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  archive(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Team> {
    return this.teams.archive(id);
  }

  @Post(':id/restore')
  @Policy('team.manage')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Restore an archived team',
    response: teamSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  restore(@Param('id', new ZodPipe(idSchema)) id: string): Promise<Team> {
    return this.teams.restore(id);
  }
}
