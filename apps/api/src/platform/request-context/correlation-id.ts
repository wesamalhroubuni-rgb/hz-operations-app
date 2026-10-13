import { randomUUID } from 'node:crypto';

/** Longest correlation id accepted from a caller. */
export const MAX_CORRELATION_ID_LENGTH = 64;

// Letters, digits and a few separators only: the value is written to logs, to the audit log and
// back into a response header, so it must not be able to carry line breaks, quotes or markup.
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * The caller's correlation id when it is safe to reuse, otherwise null. A header sent more than
 * once (an array) is rejected rather than guessed at.
 */
export function sanitizeCorrelationId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 &&
    trimmed.length <= MAX_CORRELATION_ID_LENGTH &&
    SAFE_CORRELATION_ID.test(trimmed)
    ? trimmed
    : null;
}

/** The correlation id of a request: the caller's when it is sane, a new UUID otherwise. */
export function resolveCorrelationId(headerValue: unknown): string {
  return sanitizeCorrelationId(headerValue) ?? randomUUID();
}
