import type { SmartCaptureFailureReason } from '@ops/shared';
import { ApiException } from '../../../platform/http';
import type { AiFailureKind } from '../../../platform/ai';

/**
 * What a failed AI call means for a capture (ADR-0010 sections 6 and 7):
 * - `fail`: a normal outcome; the capture becomes `failed` with the reason, answered with 200
 *   ("couldn't understand, please fill in manually", transcript kept).
 * - `release`: nothing was decided; the capture goes back to `pending` (kept for a later try)
 *   and the request answers with the error.
 */
export type CaptureFailureOutcome =
  { kind: 'fail'; reason: SmartCaptureFailureReason } | { kind: 'release'; error: ApiException };

export function captureFailureOutcome(
  failure: AiFailureKind,
  retryAfterSeconds?: number,
): CaptureFailureOutcome {
  switch (failure) {
    case 'invalid_output':
      return { kind: 'fail', reason: 'output_invalid' };
    case 'refused':
      return { kind: 'fail', reason: 'refused' };
    case 'input_rejected':
      return { kind: 'fail', reason: 'input_unusable' };
    case 'rejected':
      // The provider refused the request itself (bad key, unknown model): a retry would be
      // refused too. The runner logged it as an error for the operator.
      return { kind: 'fail', reason: 'provider_rejected' };
    case 'limit_reached':
      return {
        kind: 'release',
        error: ApiException.of(
          'ai_limit_reached',
          "The organization's daily AI limit has been reached. Fill in the log by hand.",
        ),
      };
    case 'rate_limited':
      return {
        kind: 'release',
        error: ApiException.rateLimited(
          'Too many AI requests. Try again shortly.',
          retryAfterSeconds ?? 60,
        ),
      };
    case 'unavailable':
    case 'timeout':
      return {
        kind: 'release',
        error: ApiException.of(
          'ai_unavailable',
          'The AI service is unavailable right now. The capture is kept; try again later.',
        ),
      };
  }
}
