import type { RateLimitRule } from './rate-limiter';

/**
 * Everything configurable about sign-in, as one plain object. The application builds it from
 * `ConfigService` (see `authSettingsFromConfig`); tests build it by hand or override single
 * values.
 */
export interface AuthSettings {
  /** `development`, `test` or `production`. Anything else behaves as production. */
  nodeEnv: string;
  /** Signs access tokens; the CSRF key and the fingerprint key are derived from it. */
  secret: string;
  accessTokenTtlSeconds: number;
  /** How long a session survives without a refresh (sliding). */
  refreshTokenTtlMs: number;
  /** How long a session lives at most. */
  sessionAbsoluteTtlMs: number;
  /** See `SessionService.rotate`. */
  refreshReuseGraceMs: number;
  activationCodeTtlMs: number;
  resetCodeTtlMs: number;
  maxFailedLogins: number;
  lockoutMs: number;
  cookieDomain: string | undefined;
  /** `Secure` on the session cookies: on in production. */
  cookieSecure: boolean;
  /** Origins a browser may call from: the CORS list, and the allow-list of the CSRF check. */
  allowedOrigins: readonly string[];
  /** Base of the links sent with one-time codes, without a trailing slash. */
  webAppUrl: string;
  rateLimits: AuthRateLimits;
}

export interface AuthRateLimits {
  loginPerIp: RateLimitRule;
  loginPerIdentifier: RateLimitRule;
  refreshPerIp: RateLimitRule;
  refreshPerToken: RateLimitRule;
  setPasswordPerIp: RateLimitRule;
  setPasswordPerCode: RateLimitRule;
  changePasswordPerUser: RateLimitRule;
}

export const AUTH_SETTINGS = Symbol('platform.authSettings');

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimits = {
  loginPerIp: { limit: 20, windowSeconds: 60 },
  // Above the lockout threshold on purpose: the lockout answers first, without a 429.
  loginPerIdentifier: { limit: 10, windowSeconds: 300 },
  refreshPerIp: { limit: 120, windowSeconds: 60 },
  refreshPerToken: { limit: 10, windowSeconds: 60 },
  setPasswordPerIp: { limit: 10, windowSeconds: 60 },
  setPasswordPerCode: { limit: 5, windowSeconds: 600 },
  changePasswordPerUser: { limit: 5, windowSeconds: 300 },
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Builds the settings from a configuration reader (`ConfigService.get`). The numeric settings
 * fall back to their documented defaults when the reader does not answer; the secret does not:
 * without a secret of at least 32 characters this throws, whatever the environment.
 *
 * Host requirements: configuration keys `NODE_ENV`, `AUTH_ACCESS_TOKEN_SECRET`,
 * `AUTH_ACCESS_TOKEN_TTL_SECONDS`, `AUTH_REFRESH_TOKEN_TTL_DAYS`,
 * `AUTH_SESSION_ABSOLUTE_TTL_DAYS`, `AUTH_REFRESH_REUSE_GRACE_SECONDS`,
 * `AUTH_ACTIVATION_CODE_TTL_HOURS`, `AUTH_RESET_CODE_TTL_MINUTES`, `AUTH_MAX_FAILED_LOGINS`,
 * `AUTH_LOCKOUT_MINUTES`, `AUTH_COOKIE_DOMAIN`, `CORS_ORIGINS` (string array), `WEB_APP_URL`,
 * and optionally `AUTH_RATE_LIMITS` (a partial `AuthRateLimits`, for tests).
 */
export function authSettingsFromConfig(get: (key: string) => unknown): AuthSettings {
  const secret = get('AUTH_ACCESS_TOKEN_SECRET');
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('AUTH_ACCESS_TOKEN_SECRET must be set to at least 32 characters');
  }
  const nodeEnv = get('NODE_ENV');
  const environment = typeof nodeEnv === 'string' ? nodeEnv : 'production';
  const origins = get('CORS_ORIGINS');
  const cookieDomain = get('AUTH_COOKIE_DOMAIN');
  const webAppUrl = get('WEB_APP_URL');
  const rateLimits = get('AUTH_RATE_LIMITS');

  const refreshTokenTtlMs = numberOr(get('AUTH_REFRESH_TOKEN_TTL_DAYS'), 30) * DAY;
  return {
    nodeEnv: environment,
    secret,
    accessTokenTtlSeconds: numberOr(get('AUTH_ACCESS_TOKEN_TTL_SECONDS'), 900),
    refreshTokenTtlMs,
    sessionAbsoluteTtlMs: Math.max(
      numberOr(get('AUTH_SESSION_ABSOLUTE_TTL_DAYS'), 90) * DAY,
      refreshTokenTtlMs,
    ),
    refreshReuseGraceMs: numberOr(get('AUTH_REFRESH_REUSE_GRACE_SECONDS'), 10) * SECOND,
    activationCodeTtlMs: numberOr(get('AUTH_ACTIVATION_CODE_TTL_HOURS'), 72) * HOUR,
    resetCodeTtlMs: numberOr(get('AUTH_RESET_CODE_TTL_MINUTES'), 60) * MINUTE,
    maxFailedLogins: numberOr(get('AUTH_MAX_FAILED_LOGINS'), 5),
    lockoutMs: numberOr(get('AUTH_LOCKOUT_MINUTES'), 15) * MINUTE,
    cookieDomain:
      typeof cookieDomain === 'string' && cookieDomain !== '' ? cookieDomain : undefined,
    // Unknown environments get production behaviour, the safe side.
    cookieSecure: environment !== 'development' && environment !== 'test',
    allowedOrigins: Array.isArray(origins)
      ? origins.filter((item): item is string => typeof item === 'string')
      : [],
    webAppUrl: typeof webAppUrl === 'string' ? webAppUrl.replace(/\/+$/, '') : '',
    rateLimits: {
      ...DEFAULT_AUTH_RATE_LIMITS,
      ...(typeof rateLimits === 'object' && rateLimits !== null
        ? (rateLimits as Partial<AuthRateLimits>)
        : {}),
    },
  };
}

/** True only in development: the one environment where a one-time code may be shown or logged. */
export function isDevelopment(settings: Pick<AuthSettings, 'nodeEnv'>): boolean {
  return settings.nodeEnv === 'development';
}
