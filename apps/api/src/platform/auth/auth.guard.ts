/**
 * The one global guard of the application (reusable platform component). It authenticates every
 * request and applies the route's policy. There is no other way to get an acting user.
 *
 * For each request, in this order:
 * 1. `@Public()` routes pass, with no acting user.
 * 2. Authenticate. The access token comes from the `Authorization: Bearer` header; only when
 *    the request has no `Authorization` header at all, from the access cookie. A request that
 *    sends an unusable `Authorization` header is refused; it never falls back to the cookie.
 *    The token (JWT, HS256) must verify, and then THE DATABASE IS ASKED, on every request: the
 *    session must exist, not be revoked or expired, and belong to the user and organization in
 *    the token; the user must exist and not be archived. This is what makes sign-out, password
 *    changes and the archiving of a user effective at once.
 *    A session started by a `web` client is only accepted from the cookie, one started by a
 *    `mobile` client only from the header.
 * 3. CSRF, for requests authenticated by cookie that are not GET, HEAD or OPTIONS: the `Origin`
 *    header must name one of the allowed origins, and the `x-csrf-token` header must carry the
 *    token of this session (see ./csrf.ts). Refused with 403.
 * 4. The acting user is put in `RequestContext`.
 * 5. Policy. A route with no policy at all is refused (fail closed) and logged as a programming
 *    error. `@Authenticated()` passes. Any other policy name is put to the host's
 *    `RequestAuthorizer`; when the host provides none, the route is refused.
 *
 * Every 401 carries the same message, whatever the reason.
 *
 * Host requirements: the tables in ./auth-db.ts, the settings in ./auth-settings.ts, and
 * optionally a `RequestAuthorizer` under `REQUEST_AUTHORIZER`.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AUTHENTICATED_POLICY, POLICY_KEY, DEVELOPMENT_ONLY_KEY } from '../authz/policy.decorator';
import { REQUEST_AUTHORIZER, type RequestAuthorizer } from '../authz/request-authorizer';
import { ApiException } from '../http/api-exception';
import { IS_PUBLIC_KEY } from '../http/public.decorator';
import { RequestContext, type RequestActor } from '../request-context/request-context';
import { AccessTokenService } from './access-token';
import { AUTH_DATABASE, type AuthDatabase } from './auth-db';
import {
  assertOrigin,
  CROSS_SITE_REFUSED,
  csrfHeaderOf,
  readCredentials,
  type HttpRequestLike,
} from './auth-http';
import { AUTH_SETTINGS, type AuthSettings } from './auth-settings';
import { GENERIC_UNAUTHENTICATED } from './auth.service';
import { CsrfTokens, isSafeMethod } from './csrf';
import { SessionService } from './sessions';

export const ROUTE_NOT_AVAILABLE = 'You are not allowed to use this route';

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_DATABASE) private readonly db: AuthDatabase,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    private readonly accessTokens: AccessTokenService,
    private readonly sessions: SessionService,
    private readonly csrf: CsrfTokens,
    @Optional() @Inject(REQUEST_AUTHORIZER) private readonly authorizer?: RequestAuthorizer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(DEVELOPMENT_ONLY_KEY, targets) ===
        true &&
      this.settings.nodeEnv !== 'development' &&
      this.settings.nodeEnv !== 'test'
    ) {
      // Same answer as a route that does not exist (Nest's own wording), for everyone.
      const request = context
        .switchToHttp()
        .getRequest<{ method?: string; originalUrl?: string; url?: string }>();
      throw new NotFoundException(
        `Cannot ${request.method ?? 'GET'} ${request.originalUrl ?? request.url ?? ''}`,
      );
    }
    if (this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<HttpRequestLike>();
    const actor = await this.authenticate(request);
    RequestContext.setActor(actor);

    const policy = this.reflector.getAllAndOverride<unknown>(POLICY_KEY, targets);
    if (typeof policy !== 'string' || policy === '') {
      this.logger.error(
        `PROGRAMMING ERROR: route ${context.getClass().name}.${context.getHandler().name} ` +
          'declares no policy. Add @Policy(...), @Authenticated() or @Public(). ' +
          'The request was refused.',
      );
      throw ApiException.forbidden(ROUTE_NOT_AVAILABLE);
    }
    if (policy === AUTHENTICATED_POLICY) {
      return true;
    }
    if (!this.authorizer) {
      this.logger.error(
        `No RequestAuthorizer is provided: route with policy "${policy}" was refused.`,
      );
      throw ApiException.forbidden(ROUTE_NOT_AVAILABLE);
    }
    await this.authorizer.authorize({ policy, actor });
    return true;
  }

  /** Steps 2 and 3. Throws 401 (always the same) or 403 (CSRF). */
  async authenticate(request: HttpRequestLike): Promise<RequestActor> {
    const credentials = readCredentials(request);
    const viaCookie = !credentials.hasAuthorization;
    const token = viaCookie ? credentials.accessCookie : credentials.bearer;
    const claims = this.accessTokens.verify(token);
    if (!claims) {
      throw ApiException.unauthenticated(GENERIC_UNAUTHENTICATED);
    }

    const session = await this.sessions.findActive(this.db, claims.sid);
    if (
      !session ||
      session.userId !== claims.sub ||
      session.organizationId !== claims.org ||
      (session.client === 'web') !== viaCookie
    ) {
      throw ApiException.unauthenticated(GENERIC_UNAUTHENTICATED);
    }
    const user = await this.db.user.findUnique({ where: { id: session.userId } });
    if (!user || user.archivedAt !== null || user.organizationId !== session.organizationId) {
      throw ApiException.unauthenticated(GENERIC_UNAUTHENTICATED);
    }

    if (viaCookie && !isSafeMethod(request.method)) {
      assertOrigin(request, this.settings.allowedOrigins, { required: true });
      if (!this.csrf.matches(session.id, csrfHeaderOf(request))) {
        throw ApiException.forbidden(CROSS_SITE_REFUSED);
      }
    }

    return { userId: user.id, organizationId: user.organizationId, sessionId: session.id };
  }
}
