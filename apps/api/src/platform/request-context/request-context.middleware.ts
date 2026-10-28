/**
 * Request context middleware (reusable platform component).
 *
 * Host requirements: an Express-style HTTP adapter (`req.headers`, `req.originalUrl`,
 * `res.setHeader`, `res.on('finish')`) and the `REQUEST_ID_HEADER` constant from the shared
 * package. Nothing else.
 */
import { Logger } from '@nestjs/common';
import {
  CLIENT_SYNC_HEADER,
  CLIENT_SYNC_OFFLINE,
  clockSkewSecondsOf,
  DEVICE_TIME_HEADER,
  deviceTimeHeaderSchema,
  REQUEST_ID_HEADER,
} from '@ops/shared';
import { resolveCorrelationId } from './correlation-id';
import { RequestContext, type OfflineSyncInfo, type RequestContextStore } from './request-context';

/**
 * The offline-sync facts of a request (ADR-0008), or null when it does not carry
 * `x-client-sync: offline`. A missing, repeated or invalid `x-device-time` gives a null device
 * time (and skew); it never fails the request.
 */
export function offlineSyncOf(
  headers: Record<string, string | string[] | undefined>,
  receivedAt: Date,
): OfflineSyncInfo | null {
  const flag = headers[CLIENT_SYNC_HEADER];
  if (typeof flag !== 'string' || flag.trim().toLowerCase() !== CLIENT_SYNC_OFFLINE) {
    return null;
  }
  const raw = headers[DEVICE_TIME_HEADER];
  const deviceTime =
    typeof raw === 'string' && deviceTimeHeaderSchema.safeParse(raw.trim()).success
      ? raw.trim()
      : null;
  return {
    deviceTime,
    serverTime: receivedAt,
    clockSkewSeconds: clockSkewSecondsOf(deviceTime, receivedAt),
  };
}
import { DEFAULT_QUIET_PATHS, formatRequestLog, isQuietPath, pathOf } from './request-log';

const STORE = Symbol('platform.requestContextStore');

interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  [STORE]?: RequestContextStore;
}

interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  on(event: 'finish', listener: () => void): unknown;
}

export type RequestContextMiddleware = (
  request: RequestLike,
  response: ResponseLike,
  next: () => void,
) => void;

export interface RequestContextMiddlewareOptions {
  /** Paths (and everything below them) logged at debug level. Defaults to health and docs. */
  quietPaths?: readonly string[];
}

/**
 * Runs the rest of the request inside `RequestContext`, with a correlation id taken from the
 * `x-request-id` request header when it is sane (a new UUID otherwise) and echoed in the
 * `x-request-id` response header, and writes one structured log line when the response finishes.
 *
 * It is safe to install twice. The API does: once directly on the HTTP adapter in `main.ts`, so
 * the id and the log line exist even when the body parser rejects the request, and once from
 * `PlatformModule`, after the body parser. The second pass re-enters the same store, because
 * reading a request body can drop the asynchronous context; without it the acting user set later
 * by the guard would not be visible to the services.
 */
export function createRequestContextMiddleware(
  options: RequestContextMiddlewareOptions = {},
): RequestContextMiddleware {
  const logger = new Logger('Http');
  const quietPaths = options.quietPaths ?? DEFAULT_QUIET_PATHS;

  return (request, response, next) => {
    let store = request[STORE];
    if (!store) {
      store = {
        correlationId: resolveCorrelationId(request.headers[REQUEST_ID_HEADER]),
        actor: null,
        offlineSync: offlineSyncOf(request.headers, new Date()),
      };
      request[STORE] = store;
      response.setHeader(REQUEST_ID_HEADER, store.correlationId);

      const startedAt = process.hrtime.bigint();
      const context = store;
      const method = request.method ?? 'UNKNOWN';
      const path = pathOf(request.originalUrl ?? request.url);
      response.on('finish', () => {
        // Method, path, status, timing and ids only: never bodies, headers or query values.
        const line = formatRequestLog({
          method,
          path,
          status: response.statusCode,
          durationMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
          correlationId: context.correlationId,
          actorId: context.actor?.userId ?? null,
        });
        if (isQuietPath(path, quietPaths)) {
          logger.debug(line);
        } else {
          logger.log(line);
        }
      });
    }
    RequestContext.run(store, next);
  };
}
