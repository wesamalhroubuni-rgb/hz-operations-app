import type { z } from 'zod';
import { apiErrorSchema, type ApiError } from '../common/errors.js';
import { healthResponseSchema, type HealthResponse } from '../health.js';

/** Header carrying the request's correlation id, in both directions. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Header carrying the CSRF token. Required on every state-changing request that is authenticated
 * by cookie (the web app). Requests authenticated by a bearer token (mobile) do not need it.
 */
export const CSRF_HEADER = 'x-csrf-token';

export const DEFAULT_API_TIMEOUT_MS = 10_000;

/** Why a call produced no usable data. */
export type ApiFailure =
  /** No response at all: offline, DNS failure, connection refused, CORS. */
  | { kind: 'network'; message: string }
  /** No response within the timeout. */
  | { kind: 'timeout'; message: string }
  /** Something answered, but not with a body this client understands. */
  | { kind: 'invalid-response'; status: number; message: string }
  /** The API answered with its standard error body. */
  | { kind: 'http'; status: number; message: string; error: ApiError };

/** Every client call resolves to this; calls never throw. */
export type ApiResult<Data> =
  { ok: true; status: number; data: Data } | { ok: false; failure: ApiFailure };

export type QueryValue = string | number | boolean | null | undefined;

export interface ApiRequest<Schema extends z.ZodType> {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path below the base URL, starting with a slash. */
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Schema of the success body. The body is validated before it reaches the caller. */
  schema: Schema;
  /** Non-2xx statuses whose body is still a valid success body (GET /health answers 503). */
  alsoAccept?: readonly number[];
  timeoutMs?: number;
  /**
   * Set on the sign-in, refresh and set-password calls themselves: a 401 from them is the
   * answer, not a reason to refresh the session and try again.
   */
  skipAuthRefresh?: boolean;
}

/**
 * How the transport authenticates requests and recovers from an expired access token. The web
 * app relies on cookies (`credentials: 'include'`) and supplies only the CSRF token; the mobile
 * app supplies the bearer token. Both supply `refresh`.
 */
export interface ApiAuthHooks {
  /** Bearer token for the Authorization header, or null when there is none (cookie sessions). */
  getAccessToken?: () => string | null | Promise<string | null>;
  /** CSRF token for cookie sessions; sent on every request that is not GET or HEAD. */
  getCsrfToken?: () => string | null;
  /**
   * Obtains a new access token. Resolves true when the session was renewed. Called at most once
   * per failed request, and concurrent 401s share one call.
   */
  refresh?: () => Promise<boolean>;
  /** The session could not be renewed: the user must sign in again. */
  onAuthLost?: () => void;
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Defaults to the global fetch. Pass a stub in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra headers for every request. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** `include` makes the browser send and store the API's cookies (the web app). */
  credentials?: 'include' | 'omit' | 'same-origin';
  auth?: ApiAuthHooks;
}

export interface ApiTransport {
  request<Schema extends z.ZodType>(
    request: ApiRequest<Schema>,
  ): Promise<ApiResult<z.infer<Schema>>>;
}

function buildUrl(baseUrl: string, path: string, query?: Record<string, QueryValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  return parts.length > 0 ? `${url}?${parts.join('&')}` : url;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * The one place that performs HTTP calls to the API. It adds headers and a timeout, parses the
 * body, validates it against the given schema, and turns every outcome into an `ApiResult`.
 * Endpoint groups (see `createApiClient`) are thin functions on top of it.
 */
export function createApiTransport(options: ApiClientOptions): ApiTransport {
  const doFetch = options.fetch ?? fetch;
  const auth = options.auth;
  let refreshing: Promise<boolean> | null = null;

  /** One refresh at a time: every request that hit a 401 meanwhile waits for the same answer. */
  function refreshOnce(): Promise<boolean> {
    if (!auth?.refresh) {
      return Promise.resolve(false);
    }
    refreshing ??= auth
      .refresh()
      .catch(() => false)
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  return {
    async request(request) {
      const first = await send(request);
      if (
        first.ok ||
        request.skipAuthRefresh ||
        first.failure.kind !== 'http' ||
        first.failure.status !== 401
      ) {
        return first;
      }
      // The access token expired or was revoked. Renew the session once and repeat the request
      // once; a second 401 is final, so there is no loop.
      if (!(await refreshOnce())) {
        auth?.onAuthLost?.();
        return first;
      }
      const second = await send(request);
      if (!second.ok && second.failure.kind === 'http' && second.failure.status === 401) {
        auth?.onAuthLost?.();
      }
      return second;
    },
  };

  async function send<Schema extends z.ZodType>(
    request: ApiRequest<Schema>,
  ): Promise<ApiResult<z.infer<Schema>>> {
    {
      const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);

      let status: number;
      let ok: boolean;
      let text: string;
      try {
        const headers: Record<string, string> = {
          Accept: 'application/json',
          ...(await options.getHeaders?.()),
        };
        if (request.body !== undefined) {
          headers['Content-Type'] = 'application/json';
        }
        const method = request.method ?? 'GET';
        const accessToken = await auth?.getAccessToken?.();
        if (accessToken) {
          headers.Authorization = `Bearer ${accessToken}`;
        }
        const csrfToken = method === 'GET' ? null : auth?.getCsrfToken?.();
        if (csrfToken) {
          headers[CSRF_HEADER] = csrfToken;
        }
        const response = await doFetch(buildUrl(options.baseUrl, request.path, request.query), {
          method,
          headers,
          ...(options.credentials ? { credentials: options.credentials } : {}),
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal: controller.signal,
        });
        status = response.status;
        ok = response.ok;
        text = await response.text();
      } catch (error) {
        return timedOut
          ? {
              ok: false,
              failure: { kind: 'timeout', message: `No response within ${timeoutMs} ms` },
            }
          : { ok: false, failure: { kind: 'network', message: messageOf(error) } };
      } finally {
        clearTimeout(timer);
      }

      let body: unknown;
      try {
        body = text === '' ? undefined : JSON.parse(text);
      } catch {
        return {
          ok: false,
          failure: { kind: 'invalid-response', status, message: 'The response body is not JSON' },
        };
      }

      if (ok || request.alsoAccept?.includes(status)) {
        const parsed = request.schema.safeParse(body);
        return parsed.success
          ? { ok: true, status, data: parsed.data }
          : {
              ok: false,
              failure: {
                kind: 'invalid-response',
                status,
                message: 'The response body does not match the expected shape',
              },
            };
      }

      const problem = apiErrorSchema.safeParse(body);
      return problem.success
        ? {
            ok: false,
            failure: { kind: 'http', status, message: problem.data.message, error: problem.data },
          }
        : {
            ok: false,
            failure: { kind: 'invalid-response', status, message: `Unexpected HTTP ${status}` },
          };
    }
  }
}

/** Endpoints that exist before any domain module: the health check. */
export function healthEndpoints(transport: ApiTransport) {
  return {
    /**
     * GET /health. The API answers 503 with a normal health body when the database is down, so
     * that is a successful call whose data says `database: 'down'`.
     */
    get(options?: { timeoutMs?: number }): Promise<ApiResult<HealthResponse>> {
      return transport.request({
        path: '/health',
        schema: healthResponseSchema,
        alsoAccept: [503],
        timeoutMs: options?.timeoutMs,
      });
    },
  };
}
