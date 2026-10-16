import type { Organization } from '@ops/shared';
import type { AccessContext } from '../access-context';

/**
 * The shape the organization is returned in: admins get everything (`full`, with the settings),
 * every other signed-in user the name, the slug and the work-log edit window (`summary`).
 * Updating the organization is a route-level rule (admin only).
 */
export function organizationView(context: AccessContext): Organization['view'] {
  return context.isAdmin ? 'full' : 'summary';
}
