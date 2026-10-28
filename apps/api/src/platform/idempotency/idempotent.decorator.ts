import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { IDEMPOTENCY_KEY_HEADER } from '@ops/shared';

export const IDEMPOTENT_KEY = 'platform:idempotent';

/**
 * Marks a write route whose `Idempotency-Key` header is honoured (ADR-0008 section 4): a repeat
 * with the same key and request replays the stored answer. See `idempotency.interceptor.ts`.
 */
export const Idempotent = (): MethodDecorator =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, true),
    ApiHeader({
      name: IDEMPOTENCY_KEY_HEADER,
      required: false,
      description:
        'A client-generated UUID, the same on every retry of this write. A repeat replays the ' +
        'stored answer (header `idempotent-replayed: true`); the same key with a different ' +
        'request answers 422 `idempotency_key_reused`; while the first request still runs, 409 ' +
        '`request_in_progress`. Kept 14 days.',
    }),
  );
