import { RequestContext, type RequestActor } from '../request-context/request-context';
import { ApiException } from './api-exception';

/**
 * The acting user of the current request. Throws 401 when there is none, so a service can never
 * run a tenant-scoped query without knowing the organization.
 */
export function requireActor(): RequestActor {
  const actor = RequestContext.actor();
  if (!actor) {
    throw ApiException.unauthenticated('This request has no acting user');
  }
  return actor;
}
