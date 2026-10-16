import { timingSafeEqual } from 'node:crypto';
import type { Clock } from './clock';
import { deriveKey, hmacSha256 } from './hashing';

/**
 * Access tokens: JWT, signed with HMAC-SHA256 (HS256), nothing else.
 *
 * - The header must be exactly `{"alg":"HS256","typ":"JWT"}`. Any other algorithm (including
 *   `none` and the asymmetric ones) is refused before the signature is looked at, so there is no
 *   algorithm confusion.
 * - `exp`, `iat`, the issuer and the audience are always verified.
 * - The signing key is derived from the configured secret, not the secret itself.
 *
 * A valid token only says who the bearer was when it was issued. The guard still checks the
 * session and the user in the database on every request.
 */

export const ACCESS_TOKEN_ISSUER = 'kaneri.auth';
export const ACCESS_TOKEN_AUDIENCE = 'kaneri.api';

/** Seconds a token's `iat` may lie in the future (clock differences between instances). */
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 2048;
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
  'base64url',
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** Organization id. */
  org: string;
  /** Session id. */
  sid: string;
}

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
}

export interface VerifyOptions {
  /**
   * Accept a correctly signed token whose `exp` has passed. Only for ending a session (logout):
   * an expired token still proves which session it belonged to.
   */
  ignoreExpiry?: boolean;
}

export class AccessTokenService {
  private readonly key: Buffer;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
    private readonly clock: Clock,
  ) {
    this.key = deriveKey(secret, 'access-token/v1');
  }

  sign(claims: AccessTokenClaims): IssuedAccessToken {
    const issuedAt = Math.floor(this.clock.now().getTime() / 1000);
    const expiresAt = issuedAt + this.ttlSeconds;
    const payload = Buffer.from(
      JSON.stringify({
        iss: ACCESS_TOKEN_ISSUER,
        aud: ACCESS_TOKEN_AUDIENCE,
        sub: claims.sub,
        org: claims.org,
        sid: claims.sid,
        iat: issuedAt,
        exp: expiresAt,
      }),
      'utf8',
    ).toString('base64url');
    const signature = hmacSha256(this.key, `${HEADER}.${payload}`).toString('base64url');
    return {
      token: `${HEADER}.${payload}.${signature}`,
      expiresAt: new Date(expiresAt * 1000),
    };
  }

  /** The claims of a valid token, or null. Never throws, and never says why it refused. */
  verify(token: unknown, options: VerifyOptions = {}): AccessTokenClaims | null {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      return null;
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const [header, payload, signature] = parts as [string, string, string];
    // Only the one header this service writes is accepted: HS256, nothing negotiable.
    if (header !== HEADER) {
      return null;
    }

    const expected = hmacSha256(this.key, `${header}.${payload}`);
    const given = Buffer.from(signature, 'base64url');
    if (
      given.length !== expected.length ||
      !timingSafeEqual(given, expected) ||
      given.toString('base64url') !== signature
    ) {
      return null;
    }

    let claims: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      claims = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    const now = Math.floor(this.clock.now().getTime() / 1000);
    const { iss, aud, sub, org, sid, iat, exp } = claims;
    if (iss !== ACCESS_TOKEN_ISSUER || aud !== ACCESS_TOKEN_AUDIENCE) {
      return null;
    }
    if (typeof iat !== 'number' || !Number.isInteger(iat) || iat > now + CLOCK_SKEW_SECONDS) {
      return null;
    }
    if (typeof exp !== 'number' || !Number.isInteger(exp) || exp <= iat) {
      return null;
    }
    if (!options.ignoreExpiry && exp <= now) {
      return null;
    }
    if (
      typeof sub !== 'string' ||
      typeof org !== 'string' ||
      typeof sid !== 'string' ||
      !UUID.test(sub) ||
      !UUID.test(org) ||
      !UUID.test(sid)
    ) {
      return null;
    }
    return { sub, org, sid };
  }
}
