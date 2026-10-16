import { SetMetadata } from '@nestjs/common';

export const POLICY_KEY = 'platform:policy';

export const DEVELOPMENT_ONLY_KEY = 'platform:developmentOnly';

/**
 * Marks a route (or controller) that exists only in development and test. In any other
 * environment the guard answers 404 before anything else, signed in or not, so the route cannot
 * even be detected.
 */
export const DevelopmentOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(DEVELOPMENT_ONLY_KEY, true);

/** The policy of a route that only requires a signed-in user and acts on that user alone. */
export const AUTHENTICATED_POLICY = 'authenticated';

/**
 * Declares the policy a route is governed by, by name (`work_log.read`, `user.manage`, ...).
 * Every route must carry either `@Policy(...)`, `@Authenticated()` or `@Public()`: a route with
 * none is refused (fail closed), and a test fails the build.
 *
 * The decorator only names the policy. What the name means is decided by the host application's
 * `RequestAuthorizer` (see ./request-authorizer.ts), so the platform stays free of domain rules.
 */
export const Policy = (name: string): MethodDecorator & ClassDecorator =>
  SetMetadata(POLICY_KEY, name);

/** Shorthand for a route any signed-in user may call about themselves (their session, profile). */
export const Authenticated = (): MethodDecorator & ClassDecorator =>
  SetMetadata(POLICY_KEY, AUTHENTICATED_POLICY);
