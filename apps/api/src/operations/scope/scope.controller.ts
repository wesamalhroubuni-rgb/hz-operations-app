import { Controller, Get, HttpStatus, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { idSchema, resolvedScopeSchema, type ResolvedScope } from '@ops/shared';
import { ApiDocs, requireActor, ZodPipe } from '../../platform/http';
import { ScopeService } from './scope.service';

/**
 * Read-only views of the scope resolution, for development and testing. No route enforces
 * scope yet; that is Phase 3.
 */
@ApiTags('scope')
@Controller()
export class ScopeController {
  constructor(private readonly scope: ScopeService) {}

  @Get('scope/me')
  @ApiDocs({
    summary: 'What the acting user may see',
    description: 'Inspection only: no route enforces this scope until Phase 3.',
    response: resolvedScopeSchema,
  })
  me(): Promise<ResolvedScope> {
    const actor = requireActor();
    return this.scope.resolveForUser(actor.organizationId, actor.userId);
  }

  @Get('users/:id/scope')
  @ApiDocs({
    summary: 'What a given user may see',
    description: 'Inspection only: no route enforces this scope until Phase 3.',
    response: resolvedScopeSchema,
    errors: [HttpStatus.NOT_FOUND],
  })
  forUser(@Param('id', new ZodPipe(idSchema)) id: string): Promise<ResolvedScope> {
    return this.scope.resolveForUser(requireActor().organizationId, id);
  }
}
