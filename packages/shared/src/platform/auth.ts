import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema, isoDateTimeSchema } from '../common/primitives.js';

// The wire contract of sign-in, sessions and password setting. The server side lives in the
// API's reusable platform auth module; the web and mobile apps use `authEndpoints` below.

/** How a client holds its session: `web` in httpOnly cookies, `mobile` as bearer tokens. */
export const AUTH_CLIENTS = ['web', 'mobile'] as const;
export const authClientSchema = z.enum(AUTH_CLIENTS);
export type AuthClient = z.infer<typeof authClientSchema>;

/**
 * Names of the httpOnly cookies the API sets for `web` clients. Scripts cannot read them; the
 * names are shared so server-side code of the web app (route protection) can test for their
 * presence. The access cookie is sent on every path, the refresh cookie only below `/auth`.
 */
export const AUTH_ACCESS_COOKIE = 'access_token';
export const AUTH_REFRESH_COOKIE = 'refresh_token';

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * Policy for a NEW password: length matters more than character classes. The server adds the
 * checks that need context (not equal to the user's own identifiers, not a well-known password).
 */
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `must be at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(PASSWORD_MAX_LENGTH, `must be at most ${PASSWORD_MAX_LENGTH} characters`);

/** What a person types to sign in: their email, phone number or username. */
export const loginIdentifierSchema = z.string().trim().min(1).max(320);

export const loginRequestSchema = z.strictObject({
  identifier: loginIdentifierSchema,
  /** Not checked against the policy here: an old password may predate it. */
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /**
   * Slug of the organization. Only needed when the same identifier exists in more than one
   * organization; a deployment for one client can leave it out.
   */
  organizationSlug: z.string().trim().min(1).max(100).optional(),
  client: authClientSchema,
  /** A label the user will recognise in their list of sessions, e.g. "Pixel 8". */
  deviceName: z.string().trim().min(1).max(100).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** The signed-in user, as the user sees themselves. `roles` are highest first. */
export const authUserSchema = z.object({
  id: idSchema,
  organizationId: idSchema,
  organizationName: z.string(),
  displayName: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  username: z.string().nullable(),
  /** Every role the user holds through an active membership, highest first. */
  roles: z.array(z.string()),
  /** The highest of `roles`, or null for a user with no active membership. */
  role: z.string().nullable(),
  /**
   * The user's language (Phase 6, `User.locale`). Optional on the wire so an older API still
   * parses; read it with `localeOf`, which falls back to `en`.
   */
  locale: z.string().optional(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** Bearer tokens, returned to `mobile` clients only. Web clients get cookies instead. */
export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: isoDateTimeSchema,
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

const sessionRefSchema = z.object({ id: idSchema, expiresAt: isoDateTimeSchema });

/** Present in every answer that starts or renews a session. */
const sessionGrantShape = {
  accessTokenExpiresAt: isoDateTimeSchema,
  /** `mobile` only; null for `web`. */
  tokens: authTokensSchema.nullable(),
  /** `web` only; null for `mobile`. Send it back in the `x-csrf-token` header. */
  csrfToken: z.string().nullable(),
};

export const loginResponseSchema = z.object({
  user: authUserSchema,
  session: sessionRefSchema,
  ...sessionGrantShape,
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

/** `mobile` sends its refresh token in the body; `web` sends an empty body (the cookie is used). */
export const refreshRequestSchema = z.strictObject({
  refreshToken: z.string().min(1).max(512).optional(),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;

export const refreshResponseSchema = z.object({
  session: sessionRefSchema,
  ...sessionGrantShape,
});
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

export const meResponseSchema = z.object({
  user: authUserSchema,
  session: sessionRefSchema,
  /** `web` only: lets a reloaded page recover its CSRF token. Null for `mobile`. */
  csrfToken: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Sets the password with a one-time code: first activation and password reset alike. */
export const setPasswordRequestSchema = z.strictObject({
  code: z.string().trim().min(1).max(200),
  password: newPasswordSchema,
});
export type SetPasswordRequest = z.infer<typeof setPasswordRequestSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** One of the user's own sessions (devices). Never contains a token. */
export const authSessionSchema = z.object({
  id: idSchema,
  client: authClientSchema,
  deviceName: z.string().nullable(),
  userAgent: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  lastUsedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  /** True for the session this request was made with. */
  current: z.boolean(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const authSessionListSchema = z.object({ items: z.array(authSessionSchema) });

export const AUTH_CODE_PURPOSES = ['activation', 'password_reset'] as const;
export const authCodePurposeSchema = z.enum(AUTH_CODE_PURPOSES);
export type AuthCodePurpose = z.infer<typeof authCodePurposeSchema>;

/**
 * What an admin gets back after issuing a one-time code. Delivery to the user (email, SMS) is
 * not built yet, so in DEVELOPMENT ONLY the code and a ready-made link are included for the
 * admin to pass on. In any other environment both are null.
 */
export const issuedCodeSchema = z.object({
  purpose: authCodePurposeSchema,
  expiresAt: isoDateTimeSchema,
  code: z.string().nullable(),
  link: z.string().nullable(),
});
export type IssuedCode = z.infer<typeof issuedCodeSchema>;

const emptySchema = z.unknown();

export function authEndpoints(transport: ApiTransport) {
  return {
    login(body: LoginRequest): Promise<ApiResult<LoginResponse>> {
      return transport.request({
        method: 'POST',
        path: '/auth/login',
        body,
        schema: loginResponseSchema,
        skipAuthRefresh: true,
      });
    },
    /** Renews the session. `mobile` passes its refresh token; `web` passes nothing. */
    refresh(body: RefreshRequest = {}): Promise<ApiResult<RefreshResponse>> {
      return transport.request({
        method: 'POST',
        path: '/auth/refresh',
        body,
        schema: refreshResponseSchema,
        skipAuthRefresh: true,
      });
    },
    me(): Promise<ApiResult<MeResponse>> {
      return transport.request({ path: '/auth/me', schema: meResponseSchema });
    },
    /** Ends the current session (this device). */
    logout(body?: RefreshRequest): Promise<ApiResult<unknown>> {
      return transport.request({
        method: 'POST',
        path: '/auth/logout',
        // `mobile` may pass its refresh token, so the session ends even when the access token
        // has expired; `web` sends nothing (the cookies identify the session).
        ...(body ? { body } : {}),
        schema: emptySchema,
        skipAuthRefresh: true,
      });
    },
    /** Ends every session of the user, on every device. */
    logoutAll(): Promise<ApiResult<unknown>> {
      return transport.request({ method: 'POST', path: '/auth/logout-all', schema: emptySchema });
    },
    sessions(): Promise<ApiResult<{ items: AuthSession[] }>> {
      return transport.request({ path: '/auth/sessions', schema: authSessionListSchema });
    },
    revokeSession(id: string): Promise<ApiResult<unknown>> {
      return transport.request({
        method: 'DELETE',
        path: `/auth/sessions/${id}`,
        schema: emptySchema,
      });
    },
    /** Activation and password reset: sets the password with the one-time code. */
    setPassword(body: SetPasswordRequest): Promise<ApiResult<unknown>> {
      return transport.request({
        method: 'POST',
        path: '/auth/set-password',
        body,
        schema: emptySchema,
        skipAuthRefresh: true,
      });
    },
    changePassword(body: ChangePasswordRequest): Promise<ApiResult<unknown>> {
      return transport.request({
        method: 'POST',
        path: '/auth/change-password',
        body,
        schema: emptySchema,
      });
    },
  };
}
