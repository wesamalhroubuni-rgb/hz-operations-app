import type { RequestActor } from '../request-context/request-context';

/**
 * The seam between authentication (platform) and authorization rules (host application).
 *
 * After the platform's guard has authenticated a request, it reads the route's policy name and,
 * unless the route is `@Public()` or `@Authenticated()`, asks the host's `RequestAuthorizer`
 * whether this actor may use this route at all (the function-level check). The authorizer throws
 * `ApiException.forbidden(...)` to refuse, and may prepare whatever per-request state the host's
 * services need for the object-level checks (resolved scope, roles).
 *
 * The host provides it under `REQUEST_AUTHORIZER` from a GLOBAL module. If no authorizer is
 * provided, every route with a named policy is refused.
 *
 * CONTRACT: the token and the interface are fixed.
 */
export const REQUEST_AUTHORIZER = Symbol('platform.requestAuthorizer');

export interface AuthorizationRequest {
  /** The name given to `@Policy(...)` on the route. */
  policy: string;
  actor: RequestActor;
}

export interface RequestAuthorizer {
  /** Resolves when the actor may use the route; throws an `ApiException` otherwise. */
  authorize(request: AuthorizationRequest): Promise<void>;
}
