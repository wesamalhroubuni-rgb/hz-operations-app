import { isRetryableApiErrorCode, type ApiFailure, type UploadFailure } from '@ops/shared';

import type { QueueItemError } from './types';

// How the sync engine judges a failed request of a queued write (ADR-0008, section 9):
//
// - `retryable`: may pass by itself (no answer, timeout, 408, 429, 5xx, `request_in_progress`, a
//   body this client cannot read). Retried automatically with backoff, never given up.
// - `permanent`: the server judged the write and refused it (a conflict rule, validation, 403,
//   404). Kept until the worker retries, copies, resubmits or discards it.
// - `needsSignIn`: a 401 the transport could not fix by refreshing the session. The run stops,
//   the item goes back to `pending`, and the queue waits for the same user to sign in again.
//
// `connection` marks a failure without any answer: the run stops there instead of trying the
// next items on a link that is down.

export type FailureDisposition = 'retryable' | 'permanent' | 'needsSignIn';

export interface ClassifiedFailure {
  disposition: FailureDisposition;
  connection: boolean;
  error: QueueItemError;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Judges a failed API call of a queued write. */
export function classifyApiFailure(failure: ApiFailure): ClassifiedFailure {
  switch (failure.kind) {
    case 'network':
      return {
        disposition: 'retryable',
        connection: true,
        error: { code: 'network', message: failure.message, status: null },
      };
    case 'timeout':
      return {
        disposition: 'retryable',
        connection: true,
        error: { code: 'timeout', message: failure.message, status: null },
      };
    case 'invalid-response':
      // A proxy page, a captive portal or a server mid-deploy: nothing was judged. Retrying is
      // safe (idempotency key / clientId) and never loses the write.
      return {
        disposition: 'retryable',
        connection: false,
        error: { code: 'invalid_response', message: failure.message, status: failure.status },
      };
    case 'http': {
      const code = failure.error.code;
      const error: QueueItemError = { code, message: failure.message, status: failure.status };
      if (failure.status === 401 || code === 'unauthenticated') {
        return { disposition: 'needsSignIn', connection: false, error };
      }
      if (isRetryableApiErrorCode(code) || isRetryableStatus(failure.status)) {
        return { disposition: 'retryable', connection: false, error };
      }
      return { disposition: 'permanent', connection: false, error };
    }
  }
}

/** Judges a failed photo upload (one of its four steps). */
export function classifyUploadFailure(failure: UploadFailure): ClassifiedFailure {
  if (failure.api !== null) {
    const classified = classifyApiFailure(failure.api);
    // The helper knows better for one case: `complete` without the bytes (409 `conflict`) is
    // worth sending again.
    if (classified.disposition === 'permanent' && failure.retryable) {
      return { ...classified, disposition: 'retryable' };
    }
    return classified;
  }
  const status = failure.putStatus ?? 0;
  if (status === 0) {
    return {
      disposition: 'retryable',
      connection: true,
      error: { code: 'network', message: failure.message, status: null },
    };
  }
  return failure.retryable
    ? {
        disposition: 'retryable',
        connection: false,
        error: { code: 'service_unavailable', message: failure.message, status },
      }
    : {
        disposition: 'permanent',
        connection: false,
        error: { code: 'unprocessable', message: failure.message, status },
      };
}

/** A local failure (the database or the file system threw): kept and retried. */
export function classifyLocalError(error: unknown): ClassifiedFailure {
  return {
    disposition: 'retryable',
    connection: false,
    error: {
      code: 'internal_error',
      message: error instanceof Error ? error.message : 'Unexpected local error',
      status: null,
    },
  };
}
