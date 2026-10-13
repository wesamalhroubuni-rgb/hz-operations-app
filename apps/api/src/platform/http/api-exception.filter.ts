import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { REQUEST_ID_HEADER, type ApiError, type ApiErrorCode } from '@ops/shared';
import { RequestContext } from '../request-context/request-context';
import { ApiException } from './api-exception';

interface ResponseLike {
  status(code: number): { json(body: unknown): void };
  getHeader?(name: string): unknown;
}

const STATUS_CODES: Record<number, ApiErrorCode> = {
  [HttpStatus.BAD_REQUEST]: 'validation_failed',
  [HttpStatus.UNAUTHORIZED]: 'unauthenticated',
  [HttpStatus.FORBIDDEN]: 'forbidden',
  [HttpStatus.NOT_FOUND]: 'not_found',
  [HttpStatus.CONFLICT]: 'conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'unprocessable',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'service_unavailable',
};

/** Database errors caused by the request itself, keyed by the ORM error code. */
const DATABASE_ERRORS: Record<string, { status: HttpStatus; code: ApiErrorCode; message: string }> =
  {
    P2002: {
      status: HttpStatus.CONFLICT,
      code: 'conflict',
      message: 'A record with the same unique value already exists',
    },
    P2003: {
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'unprocessable',
      message: 'The request refers to a record that does not exist or is still in use',
    },
    P2025: { status: HttpStatus.NOT_FOUND, code: 'not_found', message: 'The record was not found' },
  };

/**
 * Turns every thrown error into the standard error body. Unexpected errors are logged with the
 * correlation id and answered with a generic 500, so internals never reach the client.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ResponseLike>();
    const body = this.toBody(exception, correlationIdOf(response));
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, correlationId: string | null): ApiError {
    const base = {
      correlationId,
      timestamp: new Date().toISOString(),
    };

    if (exception instanceof ApiException) {
      return {
        statusCode: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
        ...base,
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      return {
        statusCode,
        code: STATUS_CODES[statusCode] ?? (statusCode >= 500 ? 'internal_error' : 'unprocessable'),
        message: statusCode >= 500 ? 'Internal server error' : exception.message,
        ...base,
      };
    }

    const databaseError = DATABASE_ERRORS[errorCodeOf(exception)];
    if (databaseError) {
      return {
        statusCode: databaseError.status,
        code: databaseError.code,
        message: databaseError.message,
        ...base,
      };
    }

    const clientError = clientErrorOf(exception);
    if (clientError) {
      return { ...clientError, ...base };
    }

    this.logger.error(
      `Unhandled error [${base.correlationId ?? 'no-request'}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal_error',
      message: 'Internal server error',
      ...base,
    };
  }
}

function errorCodeOf(exception: unknown): string {
  return typeof exception === 'object' &&
    exception !== null &&
    'code' in exception &&
    typeof exception.code === 'string'
    ? exception.code
    : '';
}

/**
 * The correlation id of the failing request. Errors raised before the request context exists
 * (or after it was lost, as can happen in the body parser) still find it in the response header.
 */
function correlationIdOf(response: ResponseLike): string | null {
  const fromContext = RequestContext.correlationId();
  if (fromContext) {
    return fromContext;
  }
  const header = response.getHeader?.(REQUEST_ID_HEADER);
  return typeof header === 'string' && header !== '' ? header : null;
}

/**
 * Errors raised by HTTP middleware (body too large, unsupported encoding, ...) carry a numeric
 * 4xx `status` instead of being framework exceptions. They are the caller's fault, not a 500.
 */
function clientErrorOf(
  exception: unknown,
): Pick<ApiError, 'statusCode' | 'code' | 'message'> | null {
  if (typeof exception !== 'object' || exception === null) {
    return null;
  }
  const candidate = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) {
    return null;
  }
  return {
    statusCode: status,
    code: STATUS_CODES[status] ?? 'unprocessable',
    message:
      candidate.expose === true && exception instanceof Error
        ? exception.message
        : 'The request could not be processed',
  };
}
