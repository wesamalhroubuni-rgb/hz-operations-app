import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  authSessionListSchema,
  changePasswordRequestSchema,
  idSchema,
  loginRequestSchema,
  loginResponseSchema,
  meResponseSchema,
  refreshRequestSchema,
  refreshResponseSchema,
  setPasswordRequestSchema,
  type AuthSession,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type RefreshRequest,
  type RefreshResponse,
  type SetPasswordRequest,
} from '@ops/shared';
import { z } from 'zod';
import { Authenticated } from '../authz/policy.decorator';
import { requireActor } from '../http/actor';
import { ApiDocs } from '../http/api-docs.decorator';
import { ApiException } from '../http/api-exception';
import { Public } from '../http/public.decorator';
import { ZodPipe } from '../http/zod.pipe';
import {
  assertOrigin,
  clearSessionCookies,
  readCredentials,
  requestMeta,
  setSessionCookies,
  type HttpRequestLike,
  type HttpResponseLike,
} from './auth-http';
import { AUTH_SETTINGS, type AuthSettings } from './auth-settings';
import { AuthService, GENERIC_UNAUTHENTICATED } from './auth.service';
import { AUTH_CLOCK, type Clock } from './clock';
import { CsrfTokens } from './csrf';
import type { SessionGrant } from './sessions';

/** A request without a body is the same as one with an empty object (web refresh, logout). */
const optionalRefreshBody = z.preprocess((value) => value ?? {}, refreshRequestSchema);

const COOKIE_NOTE =
  'A `web` client gets the tokens as httpOnly cookies and `tokens: null`; a `mobile` client ' +
  'gets them in `tokens` and no cookies.';

/**
 * Sign-in, session renewal, sign-out and password setting. HTTP only: the rules are in
 * `AuthService`. Every answer of these routes carries `Cache-Control: no-store` (set by a
 * middleware in `PlatformModule`, so errors carry it too).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly csrf: CsrfTokens,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    @Inject(AUTH_CLOCK) private readonly clock: Clock,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Sign in with an email, phone number or username',
    description:
      `${COOKIE_NOTE} Every failure (unknown account, wrong password, locked, not activated) ` +
      'answers 401 with the same message. A `web` sign-in must come from an allowed origin.',
    body: loginRequestSchema,
    response: loginResponseSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.TOO_MANY_REQUESTS],
  })
  async login(
    @Body(new ZodPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: HttpRequestLike,
    @Res({ passthrough: true }) response: HttpResponseLike,
  ): Promise<LoginResponse> {
    // A web sign-in sets cookies, so it must come from the web app itself (login CSRF).
    assertOrigin(request, this.settings.allowedOrigins, { required: body.client === 'web' });
    const { user, grant } = await this.auth.login(body, requestMeta(request));
    return { user, ...this.deliver(response, grant) };
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiDocs({
    summary: 'Renew the session with the refresh token',
    description:
      'A `mobile` client sends its refresh token in the body; a `web` client sends an empty ' +
      `body and the cookie is used. The refresh token is replaced on every call. ${COOKIE_NOTE} ` +
      'Sending a refresh token that was already used ends the whole session.',
    body: refreshRequestSchema,
    response: refreshResponseSchema,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.TOO_MANY_REQUESTS],
  })
  async refresh(
    @Body(new ZodPipe(optionalRefreshBody)) body: RefreshRequest,
    @Req() request: HttpRequestLike,
    @Res({ passthrough: true }) response: HttpResponseLike,
  ): Promise<RefreshResponse> {
    const fromCookie = body.refreshToken === undefined;
    assertOrigin(request, this.settings.allowedOrigins, { required: fromCookie });
    const token = body.refreshToken ?? readCredentials(request).refreshCookie;
    const result = await this.auth.refresh(
      token,
      requestMeta(request),
      fromCookie ? 'cookie' : 'body',
    );
    if (!result.ok) {
      // The loser of a race between two tabs must not delete the cookies the winner just set.
      if (fromCookie && !result.keepCookies) {
        clearSessionCookies(response, this.settings);
      }
      throw ApiException.unauthenticated(GENERIC_UNAUTHENTICATED);
    }
    return this.deliver(response, result.grant);
  }

  @Authenticated()
  @Get('me')
  @ApiDocs({
    summary: 'The signed-in user and the current session',
    description: 'For a `web` session the answer also carries the CSRF token again.',
    response: meResponseSchema,
  })
  async me(): Promise<MeResponse> {
    const { user, session } = await this.auth.me(requireActor());
    return {
      user,
      session: { id: session.id, expiresAt: session.expiresAt.toISOString() },
      csrfToken: session.client === 'web' ? this.csrf.tokenFor(session.id) : null,
    };
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'Sign out of this device',
    description:
      'Ends the session named by the access token (an expired one is accepted here) or, ' +
      'failing that, by the refresh token (cookie, or `refreshToken` in the body), and clears ' +
      'the cookies. Always answers 204, also when the session had already ended.',
    body: refreshRequestSchema,
    status: HttpStatus.NO_CONTENT,
    errors: [HttpStatus.FORBIDDEN],
  })
  async logout(
    @Body(new ZodPipe(optionalRefreshBody)) body: RefreshRequest,
    @Req() request: HttpRequestLike,
    @Res({ passthrough: true }) response: HttpResponseLike,
  ): Promise<void> {
    const credentials = readCredentials(request);
    const viaCookie = !credentials.hasAuthorization && body.refreshToken === undefined;
    const hasCookies = credentials.accessCookie !== null || credentials.refreshCookie !== null;
    if (viaCookie && hasCookies) {
      assertOrigin(request, this.settings.allowedOrigins, { required: true });
    }
    await this.auth.logout({
      accessToken: viaCookie ? credentials.accessCookie : credentials.bearer,
      refreshToken: body.refreshToken ?? (viaCookie ? credentials.refreshCookie : null),
    });
    if (hasCookies) {
      clearSessionCookies(response, this.settings);
    }
  }

  @Authenticated()
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'Sign out of every device',
    description: 'Ends every session of the signed-in user, this one included.',
    status: HttpStatus.NO_CONTENT,
    errors: [HttpStatus.FORBIDDEN],
  })
  async logoutAll(
    @Req() request: HttpRequestLike,
    @Res({ passthrough: true }) response: HttpResponseLike,
  ): Promise<void> {
    await this.auth.logoutAll(requireActor());
    this.clearCookiesIfSent(request, response);
  }

  @Authenticated()
  @Get('sessions')
  @ApiDocs({
    summary: 'List your own active sessions (devices)',
    response: authSessionListSchema,
  })
  async sessions(): Promise<{ items: AuthSession[] }> {
    return { items: await this.auth.listSessions(requireActor()) };
  }

  @Authenticated()
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'End one of your own sessions',
    description: "Another user's session id is answered with 404, like one that does not exist.",
    params: { id: idSchema },
    status: HttpStatus.NO_CONTENT,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND],
  })
  async revokeSession(
    @Param('id', new ZodPipe(idSchema)) id: string,
    @Req() request: HttpRequestLike,
    @Res({ passthrough: true }) response: HttpResponseLike,
  ): Promise<void> {
    const { current } = await this.auth.revokeSession(requireActor(), id);
    if (current) {
      this.clearCookiesIfSent(request, response);
    }
  }

  @Public()
  @Post('set-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'Set the password with a one-time code (activation and reset)',
    description:
      'The code travels in the body, never in the URL. It works once. Every session of the ' +
      'user ends; sign in afterwards. An unknown, used or expired code answers 422; a password ' +
      'the policy refuses answers 400 and does not use the code up.',
    body: setPasswordRequestSchema,
    status: HttpStatus.NO_CONTENT,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.UNPROCESSABLE_ENTITY, HttpStatus.TOO_MANY_REQUESTS],
  })
  async setPassword(
    @Body(new ZodPipe(setPasswordRequestSchema)) body: SetPasswordRequest,
    @Req() request: HttpRequestLike,
  ): Promise<void> {
    assertOrigin(request, this.settings.allowedOrigins, { required: false });
    await this.auth.setPassword(body, requestMeta(request));
  }

  @Authenticated()
  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiDocs({
    summary: 'Change your own password',
    description:
      'Checks the current password (400 with `currentPassword` in the details when it is ' +
      'wrong) and ends your other sessions; this one stays signed in.',
    body: changePasswordRequestSchema,
    status: HttpStatus.NO_CONTENT,
    errors: [HttpStatus.FORBIDDEN, HttpStatus.TOO_MANY_REQUESTS],
  })
  async changePassword(
    @Body(new ZodPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
  ): Promise<void> {
    await this.auth.changePassword(requireActor(), body);
  }

  /** Hands a grant to the client the way its kind of session holds it. */
  private deliver(response: HttpResponseLike, grant: SessionGrant): RefreshResponse {
    const session = {
      id: grant.session.id,
      expiresAt: grant.session.expiresAt.toISOString(),
    };
    const accessTokenExpiresAt = grant.accessTokenExpiresAt.toISOString();
    if (grant.session.client === 'web') {
      setSessionCookies(response, grant, this.settings, this.clock.now());
      return {
        session,
        accessTokenExpiresAt,
        tokens: null,
        csrfToken: this.csrf.tokenFor(grant.session.id),
      };
    }
    return {
      session,
      accessTokenExpiresAt,
      tokens: {
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        refreshTokenExpiresAt: grant.refreshTokenExpiresAt.toISOString(),
      },
      csrfToken: null,
    };
  }

  private clearCookiesIfSent(request: HttpRequestLike, response: HttpResponseLike): void {
    const credentials = readCredentials(request);
    if (credentials.accessCookie !== null || credentials.refreshCookie !== null) {
      clearSessionCookies(response, this.settings);
    }
  }
}
