/**
 * The HTTP side of sign-in: reading credentials from a request, writing and clearing the session
 * cookies, and the Origin check. Pure functions over Express-style request and response objects.
 *
 * Cookies (web clients only):
 * - `access_token`: the access token. `HttpOnly; SameSite=Lax; Path=/`. The cookie is kept as
 *   long as the session can be renewed, although the token inside expires after minutes: an
 *   expired token is answered with 401, the client renews, and server-side code of the web app
 *   can use the presence of the cookie as "probably signed in".
 * - `refresh_token`: the refresh token. `HttpOnly; SameSite=Lax; Path=/auth`, so it is sent to
 *   the sign-in routes only.
 * Both are `Secure` outside development and test, and carry `Domain` when one is configured.
 */
import { AUTH_ACCESS_COOKIE, AUTH_REFRESH_COOKIE, CSRF_HEADER } from '@ops/shared';
import { ApiException } from '../http/api-exception';
import type { AuthSettings } from './auth-settings';
import { isAllowedOrigin } from './csrf';
import type { RequestMeta } from './auth.service';
import type { SessionGrant } from './sessions';

export const REFRESH_COOKIE_PATH = '/auth';

/** The one answer to a request refused by the CSRF checks. */
export const CROSS_SITE_REFUSED = 'This request was refused as a cross-site request';

export interface HttpRequestLike {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

export interface HttpResponseLike {
  append(name: string, value: string): unknown;
  setHeader(name: string, value: string): unknown;
}

type CookieSettings = Pick<AuthSettings, 'cookieDomain' | 'cookieSecure'>;

function single(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Parses a `Cookie` header. Malformed pairs are skipped; the first value of a name wins. */
export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  const text = Array.isArray(header) ? header.join('; ') : (header ?? '');
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (name === '' || Object.hasOwn(cookies, name)) {
      continue;
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // Not valid percent-encoding: not one of ours.
    }
  }
  return cookies;
}

export interface CookieOptions {
  path: string;
  /** Seconds. 0 deletes the cookie. */
  maxAge: number;
  domain?: string;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (options.domain) {
    parts.push(`Domain=${options.domain}`);
  }
  if (options.secure) {
    parts.push('Secure');
  }
  if (options.maxAge <= 0) {
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  return parts.join('; ');
}

export interface RequestCredentials {
  /** True when the request has an `Authorization` header at all, usable or not. */
  hasAuthorization: boolean;
  /** The token of an `Authorization: Bearer <token>` header. */
  bearer: string | null;
  accessCookie: string | null;
  refreshCookie: string | null;
}

export function readCredentials(request: HttpRequestLike): RequestCredentials {
  const authorization = single(request.headers.authorization);
  const match = authorization
    ? /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization.trim())
    : null;
  const cookies = parseCookies(request.headers.cookie);
  return {
    hasAuthorization: request.headers.authorization !== undefined,
    bearer: match?.[1] ?? null,
    accessCookie: cookies[AUTH_ACCESS_COOKIE] || null,
    refreshCookie: cookies[AUTH_REFRESH_COOKIE] || null,
  };
}

export function requestMeta(request: HttpRequestLike): RequestMeta {
  return {
    ip: request.ip ?? request.socket?.remoteAddress ?? null,
    userAgent: single(request.headers['user-agent']),
  };
}

export function csrfHeaderOf(request: HttpRequestLike): string | null {
  return single(request.headers[CSRF_HEADER]);
}

/**
 * The Origin check. A request that names an origin must name an allowed one. A request that
 * names none is refused when `required` (anything that reads or writes the session cookies: a
 * browser always sends `Origin` on such a request) and let through otherwise (a mobile app or
 * a script, which holds no cookies an attacker could ride on).
 */
export function assertOrigin(
  request: HttpRequestLike,
  allowed: readonly string[],
  options: { required: boolean },
): void {
  const origin = request.headers.origin;
  if (origin === undefined && !options.required) {
    return;
  }
  if (!isAllowedOrigin(origin, allowed)) {
    throw ApiException.forbidden(CROSS_SITE_REFUSED);
  }
}

/** Sets both session cookies from a grant. */
export function setSessionCookies(
  response: HttpResponseLike,
  grant: SessionGrant,
  settings: CookieSettings,
  now: Date,
): void {
  const maxAge = (grant.refreshTokenExpiresAt.getTime() - now.getTime()) / 1000;
  const common = { maxAge, domain: settings.cookieDomain, secure: settings.cookieSecure };
  response.append(
    'Set-Cookie',
    serializeCookie(AUTH_ACCESS_COOKIE, grant.accessToken, { ...common, path: '/' }),
  );
  response.append(
    'Set-Cookie',
    serializeCookie(AUTH_REFRESH_COOKIE, grant.refreshToken, {
      ...common,
      path: REFRESH_COOKIE_PATH,
    }),
  );
}

/** Deletes both session cookies in the browser. */
export function clearSessionCookies(response: HttpResponseLike, settings: CookieSettings): void {
  const common = { maxAge: 0, domain: settings.cookieDomain, secure: settings.cookieSecure };
  response.append('Set-Cookie', serializeCookie(AUTH_ACCESS_COOKIE, '', { ...common, path: '/' }));
  response.append(
    'Set-Cookie',
    serializeCookie(AUTH_REFRESH_COOKIE, '', { ...common, path: REFRESH_COOKIE_PATH }),
  );
}
