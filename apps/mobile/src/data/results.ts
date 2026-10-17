import type { ApiErrorDetail, ApiFailure, ApiResult } from '@ops/shared';

// What every write of the data layer resolves to. Screens branch on `ok` and on `error.kind`;
// they never see an `ApiFailure` or an HTTP status.

export type WriteErrorKind =
  /** No connection or no answer in time: the same write can be tried again as it is. */
  | 'network'
  /** The input was refused; `details` say which fields (400 / 422). */
  | 'invalid'
  /** Visible, but this user may not do this (403), e.g. the edit window closed. */
  | 'forbidden'
  /** The record is gone or out of reach (404). */
  | 'notFound'
  /** The record changed meanwhile or is in a state that does not allow this (409). */
  | 'conflict'
  /** The session ended; the app returns to sign-in on its own. */
  | 'signedOut'
  /** The server failed (5xx) or answered something unexpected. */
  | 'server';

export interface WriteError {
  kind: WriteErrorKind;
  /** The API's message, for logs and as a fallback; screens show translated text by `kind`. */
  message: string;
  details: ApiErrorDetail[];
}

export type WriteResult<Data> = { ok: true; data: Data } | { ok: false; error: WriteError };

export function toWriteError(failure: ApiFailure): WriteError {
  switch (failure.kind) {
    case 'network':
    case 'timeout':
      return { kind: 'network', message: failure.message, details: [] };
    case 'invalid-response':
      return { kind: 'server', message: failure.message, details: [] };
    case 'http': {
      const details = failure.error.details ?? [];
      const status = failure.status;
      const kind: WriteErrorKind =
        status === 400 || status === 422
          ? 'invalid'
          : status === 401
            ? 'signedOut'
            : status === 403
              ? 'forbidden'
              : status === 404
                ? 'notFound'
                : status === 409
                  ? 'conflict'
                  : status === 408 || status === 429
                    ? 'network'
                    : 'server';
      return { kind, message: failure.message, details };
    }
  }
}

export function fromApiResult<Data>(result: ApiResult<Data>): WriteResult<Data> {
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, error: toWriteError(result.failure) };
}

/** Failures worth a "Try again" button that repeats the same write unchanged. */
export function isRetryableWriteError(error: WriteError): boolean {
  return error.kind === 'network' || error.kind === 'server';
}

/** A failed read, thrown into the query cache so `error` carries the reason. */
export class ReadError extends Error {
  constructor(readonly error: WriteError) {
    super(error.message);
    this.name = 'ReadError';
  }
}
