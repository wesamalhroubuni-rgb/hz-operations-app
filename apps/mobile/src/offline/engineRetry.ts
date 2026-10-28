import type { RetryPolicy } from './types';

/** ADR-0008: first delay 2 s, doubling, capped at 15 minutes, full jitter, no attempt limit. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 15 * 60 * 1000;

/** Exponential backoff with full jitter: random in [0, min(max, base * 2^(attempt-1))]. */
export function createRetryPolicy(
  options: { baseDelayMs?: number; maxDelayMs?: number } = {},
): RetryPolicy {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
  return {
    baseDelayMs,
    maxDelayMs,
    delayMs(attempt, random = Math.random) {
      const step = Math.max(1, Math.floor(attempt));
      // 2^(step-1) overflows to Infinity for large steps; min() keeps the cap.
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(step - 1, 52));
      const fraction = Math.min(1, Math.max(0, random()));
      return Math.round(ceiling * fraction);
    },
  };
}
