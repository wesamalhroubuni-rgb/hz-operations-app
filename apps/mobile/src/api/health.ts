import { healthResponseSchema, type HealthResponse } from '@ops/shared';

export const HEALTH_TIMEOUT_MS = 5000;

export type HealthFailureReason = 'timeout' | 'network' | 'invalid-response';

export type HealthCheckResult =
  | { reachable: true; health: HealthResponse }
  | { reachable: false; reason: HealthFailureReason; message: string };

export interface FetchHealthOptions {
  timeoutMs?: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Calls GET {apiUrl}/health and validates the body.
 *
 * Never throws: every failure is returned as `{ reachable: false }` so the UI can
 * render it. The API answers 503 with a valid body when the database is down, so
 * the body is parsed whatever the HTTP status is.
 */
export async function fetchHealth(
  apiUrl: string,
  { timeoutMs = HEALTH_TIMEOUT_MS }: FetchHealthOptions = {},
): Promise<HealthCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${apiUrl}/health`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const body: unknown = await response.json();
    const parsed = healthResponseSchema.safeParse(body);

    if (!parsed.success) {
      return {
        reachable: false,
        reason: 'invalid-response',
        message: `Unexpected response from the API (HTTP ${response.status}).`,
      };
    }
    return { reachable: true, health: parsed.data };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        reachable: false,
        reason: 'timeout',
        message: `The API did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      };
    }
    if (error instanceof SyntaxError) {
      return {
        reachable: false,
        reason: 'invalid-response',
        message: 'The API response was not valid JSON.',
      };
    }
    return {
      reachable: false,
      reason: 'network',
      message: 'Could not connect to the API.',
    };
  } finally {
    clearTimeout(timer);
  }
}
