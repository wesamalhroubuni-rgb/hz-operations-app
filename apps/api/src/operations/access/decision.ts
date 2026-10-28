import type { ApiErrorCode } from '@ops/shared';
import { ApiException } from '../../platform/http';

/**
 * The answer of an action rule. A rule never throws and never touches the database: plain data
 * in, a decision out, so every rule can be unit tested as a table.
 *
 * - `not_found`: the caller may not see the record at all. The API answers 404, exactly as for
 *   a record that does not exist, so nothing reveals that it does.
 * - `forbidden`: the caller can see the record but may not do this to it. The API answers 403.
 * - `conflict`: nobody may do this to the record in its current state (for example a status
 *   move that does not exist). The API answers 409.
 *
 * A refusal may carry a specific error `code` (ADR-0008: `edit_window_closed`,
 * `already_reviewed`, `task_not_assigned`, ...) that a client branches on. The code decides the
 * status (`API_ERROR_STATUS` in @ops/shared); without one, the outcome's generic code is used.
 */
export type Decision =
  | { allowed: true }
  | {
      allowed: false;
      outcome: 'not_found' | 'forbidden' | 'conflict';
      reason: string;
      code?: ApiErrorCode;
    };

export const ALLOW: Decision = { allowed: true };

export function notVisible(): Decision {
  return { allowed: false, outcome: 'not_found', reason: 'The record is outside your scope' };
}

export function forbid(reason: string, code?: ApiErrorCode): Decision {
  return { allowed: false, outcome: 'forbidden', reason, ...(code ? { code } : {}) };
}

export function conflict(reason: string, code?: ApiErrorCode): Decision {
  return { allowed: false, outcome: 'conflict', reason, ...(code ? { code } : {}) };
}

/** The specific code of a refusal, or null (allowed, or a refusal with a generic code). */
export function codeOf(decision: Decision): ApiErrorCode | null {
  return decision.allowed ? null : (decision.code ?? null);
}

/** The first refusal of a list of decisions, or `ALLOW` when every one allows. */
export function allOf(...decisions: Decision[]): Decision {
  return decisions.find((decision) => !decision.allowed) ?? ALLOW;
}

/**
 * Turns a refusal into the HTTP error of the 404-versus-403 rule; does nothing when allowed.
 * This is the only place a decision becomes an exception.
 *
 * @param entity label of the record for the 404 message (`Work log`, `Task`, ...)
 */
export function enforce(decision: Decision, entity: string, id?: string): void {
  if (decision.allowed) {
    return;
  }
  if (decision.outcome !== 'not_found' && decision.code) {
    throw ApiException.of(decision.code, decision.reason);
  }
  switch (decision.outcome) {
    case 'not_found':
      throw ApiException.notFound(entity, id);
    case 'conflict':
      throw ApiException.conflict(decision.reason);
    case 'forbidden':
    default:
      throw ApiException.forbidden(decision.reason);
  }
}
