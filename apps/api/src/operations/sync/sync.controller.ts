import { Controller, Get, HttpStatus, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  syncPullQuerySchema,
  syncPullResponseSchema,
  type SyncPullQuery,
  type SyncPullResponse,
} from '@ops/shared';
import { Policy } from '../../platform/authz';
import { ApiDocs, ZodPipe } from '../../platform/http';
import { SyncService } from './sync.service';

/** The phone's offline cache refresh (ADR-0008 section 6). */
@ApiTags('sync')
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('pull')
  @Policy('sync.pull')
  @ApiDocs({
    summary: "The signed-in user's offline data, changed since a cursor",
    description:
      'For the caller only, through the same visibility rules as every other read: the ' +
      'non-archived tasks the caller is assigned to (done or cancelled ones only while changed ' +
      'within 30 days), every non-archived log type, the visible non-archived sites and teams, ' +
      "the caller's own non-archived work logs created or occurred within 30 days, the caller's " +
      'notifications of the last 30 days, and the organization summary. Each resource answers ' +
      '`{ upserts, ids }`: `ids` is always the complete current id set (delete every cached row ' +
      'not in it), `upserts` the records changed since the cursor (minus a 60-second overlap), ' +
      'or all of them when `full` is true. Log types, sites and teams are always sent whole. ' +
      'Send the returned `cursor` with the next pull; an unusable cursor (unreadable, or the ' +
      "caller's scope changed) gives a full pull, never an error.",
    query: syncPullQuerySchema,
    response: syncPullResponseSchema,
    errors: [HttpStatus.FORBIDDEN],
  })
  pull(@Query(new ZodPipe(syncPullQuerySchema)) query: SyncPullQuery): Promise<SyncPullResponse> {
    return this.sync.pull(query);
  }
}
