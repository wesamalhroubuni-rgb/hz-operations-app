/**
 * Applies `Idempotency-Key` to the routes marked `@Idempotent()` (reusable platform component,
 * ADR-0008 section 4). Registered globally by `PlatformModule`; every other route ignores the
 * header. Runs after the guard (the acting user is known) and around the validation pipes and
 * the handler, so a refused body is a final answer like any other.
 *
 * - No header: the route runs as usual.
 * - A header that is not a UUID: 400.
 * - First use: the key is claimed, the route runs, a final answer (2xx, 400, 403, 404, 409,
 *   422) is stored for 14 days; a non-final one (401, 408, 429, 5xx, `request_in_progress`)
 *   releases the claim so a retry runs again.
 * - Repeat with the same method, path and body: the stored status and body, with the header
 *   `idempotent-replayed: true`; while the first still runs, 409 `request_in_progress`.
 * - Repeat with a different request: 422 `idempotency_key_reused`.
 *
 * Keys are per organization and user: a stored answer is only ever returned to its own user.
 * See `idempotency.service.ts` for why the claim, the write and the answer are safe in sequence.
 */
import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  type ApiErrorCode,
  type ApiErrorDetail,
} from '@ops/shared';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { ApiException } from '../http/api-exception';
import { describeKnownError } from '../http/api-exception.filter';
import { RequestContext } from '../request-context/request-context';
import { IDEMPOTENT_KEY } from './idempotent.decorator';
import {
  idempotencyRequestHash,
  isFinalAnswer,
  isValidIdempotencyKey,
  requestPathOf,
} from './idempotency';
import { IdempotencyService, type IdempotencyClaim } from './idempotency.service';

interface RequestLike {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface ResponseLike {
  statusCode: number;
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
}

/** The stored form of an error answer: enough to throw the same error again. */
interface StoredError {
  code: ApiErrorCode;
  message: string;
  details?: ApiErrorDetail[];
}

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Idempotency');

  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      context.getType() !== 'http' ||
      !this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle();
    }
    const http = context.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    if (header === undefined) {
      return next.handle();
    }
    if (!isValidIdempotencyKey(header)) {
      throw ApiException.validation(
        [{ path: IDEMPOTENCY_KEY_HEADER, message: 'must be a UUID' }],
        'The Idempotency-Key header must be a UUID',
      );
    }
    const actor = RequestContext.actor();
    if (!actor) {
      return next.handle();
    }
    return from(this.run(request, http.getResponse<ResponseLike>(), next, actor, header));
  }

  private async run(
    request: RequestLike,
    response: ResponseLike,
    next: CallHandler,
    actor: { userId: string; organizationId: string },
    key: string,
  ): Promise<unknown> {
    const method = (request.method ?? 'GET').toUpperCase();
    const path = requestPathOf(request.originalUrl ?? request.url);
    const begin = await this.idempotency.begin({
      organizationId: actor.organizationId,
      userId: actor.userId,
      key,
      method,
      path,
      requestHash: idempotencyRequestHash(method, path, request.body),
    });

    switch (begin.kind) {
      case 'reused':
        throw ApiException.of(
          'idempotency_key_reused',
          'This Idempotency-Key was already used for a different request',
        );
      case 'in_progress':
        throw ApiException.of(
          'request_in_progress',
          'A request with this Idempotency-Key is still being processed. Try again shortly.',
        );
      case 'replay': {
        response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
        const { statusCode, body } = begin.answer;
        if (statusCode >= 400) {
          const stored = body as StoredError;
          throw new ApiException(
            statusCode as HttpStatus,
            stored.code,
            stored.message,
            stored.details,
          );
        }
        response.status(statusCode);
        return body;
      }
      case 'claimed':
        return this.runClaimed(begin.claim, response, next);
    }
  }

  private async runClaimed(
    claim: IdempotencyClaim,
    response: ResponseLike,
    next: CallHandler,
  ): Promise<unknown> {
    let body: unknown;
    try {
      body = await lastValueFrom(next.handle(), { defaultValue: undefined });
    } catch (error) {
      const known = describeKnownError(error);
      if (known && isFinalAnswer(known.statusCode, known.code)) {
        const stored: StoredError = {
          code: known.code,
          message: known.message,
          ...(known.details ? { details: known.details } : {}),
        };
        await this.settle(() =>
          this.idempotency.complete(claim, { statusCode: known.statusCode, body: stored }),
        );
      } else {
        await this.settle(() => this.idempotency.release(claim));
      }
      throw error;
    }
    const statusCode = response.statusCode;
    await this.settle(() =>
      isFinalAnswer(statusCode)
        ? this.idempotency.complete(claim, { statusCode, body })
        : this.idempotency.release(claim),
    );
    return body;
  }

  /**
   * Bookkeeping after the route ran. A failure here must not change the route's answer: the
   * claim then stays locked until `IDEMPOTENCY_LOCK_SECONDS` pass and a retry takes it over
   * (safe, see idempotency.service.ts).
   */
  private async settle(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(
        `Could not store the idempotency outcome: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }
}
