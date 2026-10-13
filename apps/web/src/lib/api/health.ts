import { healthResponseSchema, type HealthResponse } from '@ops/shared';

/** Outcome of one call to the API's GET /health endpoint. */
export type ApiHealthResult =
  | { reachable: true; health: HealthResponse }
  | { reachable: false; reason: 'network' | 'invalid-response' };

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Asks the API for its health.
 *
 * The API answers HTTP 503 with a normal health body when the database is
 * down, so the body is parsed whatever the status code is. This function
 * never throws: every failure becomes an "unreachable" result.
 */
export async function fetchApiHealth(
  apiUrl: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ApiHealthResult> {
  let body: unknown;

  try {
    const response = await fetch(`${apiUrl.replace(/\/+$/, '')}/health`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.json();
  } catch (error) {
    // A body that is not JSON means something answered, but not our API.
    if (error instanceof SyntaxError) {
      return { reachable: false, reason: 'invalid-response' };
    }
    return { reachable: false, reason: 'network' };
  }

  const parsed = healthResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { reachable: false, reason: 'invalid-response' };
  }

  return { reachable: true, health: parsed.data };
}
