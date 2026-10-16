import { constantTimeEquals, deriveKey, hmacSha256 } from './hashing';

/**
 * CSRF protection for requests authenticated by cookie (the web app).
 *
 * The token is `base64url(HMAC-SHA256(key, sessionId))`, where `key` is derived from the signing
 * secret for this purpose only. So:
 * - it is bound to one session: a token of another session, or of a session that has ended, is
 *   useless;
 * - nothing is stored: the server recomputes it and compares in constant time;
 * - it is the same for the whole life of the session, so it survives token refreshes, and a
 *   reloaded page gets it back from `GET /auth/me`;
 * - a page of another origin cannot learn it (CORS does not let it read the API's answers) and
 *   cannot compute it (the key never leaves the server).
 *
 * It is returned in response bodies and sent back in the `x-csrf-token` header; a cross-site
 * form or image cannot set that header. The `Origin` check is the second, independent barrier.
 */
export class CsrfTokens {
  private readonly key: Buffer;

  constructor(secret: string) {
    this.key = deriveKey(secret, 'csrf/v1');
  }

  tokenFor(sessionId: string): string {
    return hmacSha256(this.key, sessionId).toString('base64url');
  }

  matches(sessionId: string, presented: unknown): boolean {
    if (typeof presented !== 'string' || presented.length === 0 || presented.length > 128) {
      return false;
    }
    return constantTimeEquals(this.tokenFor(sessionId), presented);
  }
}

/** Methods that do not change state and therefore need no CSRF check. */
export function isSafeMethod(method: string | undefined): boolean {
  const upper = (method ?? '').toUpperCase();
  return upper === 'GET' || upper === 'HEAD' || upper === 'OPTIONS';
}

/**
 * True when the `Origin` header names one of the allowed origins. A missing header, `null`, and
 * several values are all refused: browsers send exactly one on every cross-site write.
 */
export function isAllowedOrigin(origin: unknown, allowed: readonly string[]): boolean {
  if (typeof origin !== 'string' || origin === '' || origin === 'null') {
    return false;
  }
  const normalized = origin.replace(/\/+$/, '').toLowerCase();
  return allowed.some((item) => item.replace(/\/+$/, '').toLowerCase() === normalized);
}
