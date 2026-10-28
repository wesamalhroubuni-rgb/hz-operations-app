/**
 * The pure rules of `Idempotency-Key` handling (reusable platform component, ADR-0008 section 4).
 * No database, no framework: the service and the interceptor apply them.
 */
import { createHash } from 'node:crypto';
import type { ApiErrorCode } from '@ops/shared';

/** The shape of the client's key: a UUID (any version). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * JSON with the keys of every object sorted, so two bodies that differ only in key order (or in
 * whitespace) hash the same. `undefined` members are dropped, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(',')}}`;
}

/** SHA-256 (hex) of the method, the path (no query string) and the canonical JSON body. */
export function idempotencyRequestHash(method: string, path: string, body: unknown): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body ?? null)}`)
    .digest('hex');
}

/** The path of a request URL without its query string or fragment. */
export function requestPathOf(url: string | undefined): string {
  if (!url) {
    return '/';
  }
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end) || '/';
}

/** A stored claim, as far as the rules are concerned. */
export interface IdempotencyClaimState {
  requestHash: string;
  statusCode: number | null;
  lockedUntil: Date;
  expiresAt: Date;
}

/**
 * What a repeat of a key finds:
 * - `expired`: the row outlived its retention (the cleanup has not run yet): treat the key as new;
 * - `reused`: another request (method, path or body) under the same key: 422;
 * - `replay`: the first request finished with a final answer: send it again;
 * - `in_progress`: the first request still holds the lock: 409;
 * - `take_over`: the first request's lock ran out without an answer (its process died): run again.
 */
export type IdempotencyRepeat = 'expired' | 'reused' | 'replay' | 'in_progress' | 'take_over';

export function classifyRepeat(
  existing: IdempotencyClaimState,
  requestHash: string,
  now: Date,
): IdempotencyRepeat {
  if (existing.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (existing.requestHash !== requestHash) {
    return 'reused';
  }
  if (existing.statusCode !== null) {
    return 'replay';
  }
  return existing.lockedUntil.getTime() > now.getTime() ? 'in_progress' : 'take_over';
}

/**
 * Whether an answer is final, so it is stored and replayed: every 2xx, and 400, 403, 404, 409,
 * 422. Not final (the claim is released and a retry runs again): 401 (sign in again), 408, 429,
 * 5xx, and `request_in_progress`.
 */
export function isFinalAnswer(statusCode: number, code?: ApiErrorCode | null): boolean {
  if (code === 'request_in_progress') {
    return false;
  }
  if (statusCode >= 200 && statusCode < 300) {
    return true;
  }
  return [400, 403, 404, 409, 422].includes(statusCode);
}
