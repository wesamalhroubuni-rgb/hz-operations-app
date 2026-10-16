import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema } from '../common/primitives.js';
import { roleSchema } from './enums.js';

/**
 * What a user may see, resolved from their memberships. The rules live in the API
 * (`apps/api/src/operations/scope/resolve-scope.ts`); this is the shape they produce.
 *
 * Reading it as a filter: when `orgWide` is true, everything in the organization is visible.
 * Otherwise a record is visible when it belongs to one of `siteIds`, to one of `teamIds`, or to
 * one of `userIds` (its author or assignee). The API's access layer
 * (`apps/api/src/operations/access/rules/`) turns this into the rule of each resource.
 */
export const resolvedScopeSchema = z.object({
  userId: idSchema,
  organizationId: idSchema,
  /** False when the user is archived: nothing below grants anything then. */
  active: z.boolean(),
  /** Distinct roles of the user's active memberships. */
  roles: z.array(roleSchema),
  /**
   * True when the user oversees the whole organization: any manager or admin membership (always
   * organization-wide), or a supervisor membership with `orgWide`.
   */
  orgWide: z.boolean(),
  /** Sites the user may see, descendants included. Every site when `orgWide`. */
  siteIds: z.array(idSchema),
  /** Teams the user may see, descendants included. Every team when `orgWide`. */
  teamIds: z.array(idSchema),
  /** Users whose records the user may see; always includes the user. `'all'` when `orgWide`. */
  userIds: z.union([z.literal('all'), z.array(idSchema)]),
  /**
   * People the user works with: everyone holding a worker or supervisor membership at a site or
   * team where the user is a worker (descendants included). Always includes the user. These are
   * the people a worker may see as a basic profile; it gives no view of their records.
   */
  colleagueIds: z.array(idSchema),
  /** Where the user works as a worker (their own sites and teams, descendants included). */
  memberOf: z.object({
    orgWide: z.boolean(),
    siteIds: z.array(idSchema),
    teamIds: z.array(idSchema),
  }),
});
export type ResolvedScope = z.infer<typeof resolvedScopeSchema>;

/** Read-only inspection endpoints: one's own scope, and (admins only) another user's. */
export function scopeEndpoints(transport: ApiTransport) {
  return {
    /** GET /scope/me: the acting user's scope. */
    me(): Promise<ApiResult<ResolvedScope>> {
      return transport.request({ path: '/scope/me', schema: resolvedScopeSchema });
    },
    forUser(userId: string): Promise<ApiResult<ResolvedScope>> {
      return transport.request({ path: `/users/${userId}/scope`, schema: resolvedScopeSchema });
    },
  };
}
