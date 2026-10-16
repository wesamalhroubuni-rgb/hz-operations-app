import { Controller, Get, HttpStatus, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { idSchema, resolvedScopeSchema, type ResolvedScope } from '@ops/shared';
import { Authenticated, Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { AccessService } from '../access';
import { ScopeService } from './scope.service';

/** Read-only views of the scope resolution: one's own, and (admins) anybody's. */
@ApiTags('scope')
@Controller()
export class ScopeController {
  constructor(
    private readonly scope: ScopeService,
    private readonly access: AccessService,
  ) {}

  @Get('scope/me')
  @Authenticated()
  @ApiDocs({
    summary: 'What the signed-in user may see',
    description: 'The scope every route filters by, resolved from the active memberships.',
    response: resolvedScopeSchema,
  })
  async me(): Promise<ResolvedScope> {
    return (await this.access.context()).scope;
  }

  @Get('users/:id/scope')
  @Policy('user.read_scope')
  @ApiDocs({
    summary: 'What a given user may see',
    description: 'Admins only.',
    response: resolvedScopeSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  async forUser(@Param('id', new ZodPipe(idSchema)) id: string): Promise<ResolvedScope> {
    const { organizationId } = await this.access.context();
    return this.scope.resolveForUser(organizationId, id);
  }
}
