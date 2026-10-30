import type { ApiErrorCode, ApiFailure, ApiResult } from '@ops/shared';

import { t, type TranslationKey } from '@/i18n';

/**
 * The bridge between the API client (calls resolve to an `ApiResult` and never throw) and
 * TanStack Query (a failed query must throw). `unwrap` turns a failure into an `ApiCallError`,
 * which keeps the `ApiFailure` so a page can branch on `status` / `code`.
 */
export class ApiCallError extends Error {
  readonly failure: ApiFailure;

  constructor(failure: ApiFailure) {
    super(failure.message);
    this.name = 'ApiCallError';
    this.failure = failure;
  }

  get status(): number | null {
    return 'status' in this.failure ? this.failure.status : null;
  }

  get code(): ApiErrorCode | null {
    return this.failure.kind === 'http' ? this.failure.error.code : null;
  }
}

/** The client is not configured (no NEXT_PUBLIC_API_URL). */
export class ApiNotConfiguredError extends Error {
  constructor() {
    super('The API client is not configured');
    this.name = 'ApiNotConfiguredError';
  }
}

/** The data of a successful call; throws `ApiCallError` otherwise (for query functions). */
export function unwrap<Data>(result: ApiResult<Data>): Data {
  if (result.ok) {
    return result.data;
  }
  throw new ApiCallError(result.failure);
}

export function failureOf(error: unknown): ApiFailure | null {
  return error instanceof ApiCallError ? error.failure : null;
}

/** HTTP status of a failed call, or null (network, timeout, not an API error). */
export function statusOf(error: unknown): number | null {
  return error instanceof ApiCallError ? error.status : null;
}

/** True for a 404: missing, or outside the caller's scope (ADR-0005 answers both the same). */
export function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404;
}

/** Retry a failed query only when it may pass by itself (no answer, timeout, 429, 5xx). */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) {
    return false;
  }
  const failure = failureOf(error);
  if (failure === null) {
    return false;
  }
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return true;
  }
  const status = 'status' in failure ? failure.status : 0;
  return status === 429 || status >= 500;
}

const STATUS_MESSAGES: Record<number, TranslationKey> = {
  401: 'states.signedOut',
  403: 'states.forbiddenBody',
  404: 'states.notFoundBody',
  409: 'states.conflict',
  429: 'states.rateLimited',
};

/**
 * A sentence for the user. For a 400 or 422 the API's own message is the most useful (it names
 * the field); for the others a translated sentence by status. Never shows a stack or a body.
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiNotConfiguredError) {
    return t('states.notConfigured');
  }
  const failure = failureOf(error);
  if (failure === null) {
    return t('states.errorTitle');
  }
  switch (failure.kind) {
    case 'network':
      return t('states.offline');
    case 'timeout':
      return t('states.timeout');
    case 'invalid-response':
      return t('states.invalidResponse');
    case 'http': {
      if (failure.status === 400 || failure.status === 422) {
        return failure.error.message;
      }
      const key = STATUS_MESSAGES[failure.status];
      return key ? t(key) : failure.error.message;
    }
  }
}
