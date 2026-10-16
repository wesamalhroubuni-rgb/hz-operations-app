import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** SHA-256 of a high-entropy secret (refresh token, one-time code), as lower-case hex. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * A key for one purpose, derived from the configured secret. Each use (signing tokens, CSRF,
 * fingerprints) gets its own key, so a value made for one can never be replayed as another.
 */
export function deriveKey(secret: string, purpose: string): Buffer {
  return createHmac('sha256', secret).update(`kaneri.auth/${purpose}`, 'utf8').digest();
}

export function hmacSha256(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/** Compares two strings in constant time. Different lengths are simply unequal. */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) {
    // Still do one comparison, so the time does not depend on where the lengths differ.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
