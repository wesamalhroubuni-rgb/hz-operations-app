import { HttpException, HttpStatus } from '@nestjs/common';
import type { ApiErrorCode, ApiErrorDetail } from '@ops/shared';

/**
 * The one exception type services and controllers throw for an expected failure. The exception
 * filter turns it into the standard error body (`apiErrorSchema` in @ops/shared).
 */
export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: ApiErrorDetail[],
    /** Seconds the caller should wait; the filter sends it as the `Retry-After` header. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message, status);
  }

  /** Too many attempts. Answers 429 with a `Retry-After` header. */
  static rateLimited(
    message = 'Too many attempts. Try again later.',
    retryAfterSeconds = 60,
  ): ApiException {
    return new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      'rate_limited',
      message,
      undefined,
      Math.max(1, Math.ceil(retryAfterSeconds)),
    );
  }

  static validation(details: ApiErrorDetail[], message = 'The request is not valid'): ApiException {
    return new ApiException(HttpStatus.BAD_REQUEST, 'validation_failed', message, details);
  }

  static unauthenticated(message: string): ApiException {
    return new ApiException(HttpStatus.UNAUTHORIZED, 'unauthenticated', message);
  }

  static forbidden(message: string): ApiException {
    return new ApiException(HttpStatus.FORBIDDEN, 'forbidden', message);
  }

  static notFound(entity: string, id?: string): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'not_found',
      id ? `${entity} ${id} was not found` : `${entity} was not found`,
    );
  }

  static conflict(message: string, details?: ApiErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.CONFLICT, 'conflict', message, details);
  }

  /** The request is well-formed but breaks a rule (a reference to another organization, ...). */
  static unprocessable(message: string, details?: ApiErrorDetail[]): ApiException {
    return new ApiException(HttpStatus.UNPROCESSABLE_ENTITY, 'unprocessable', message, details);
  }
}
