import type {
  ApiErrorCode,
  BulkWorkLogStatusInput,
  BulkWorkLogStatusResult,
  WorkLog,
} from '@ops/shared';

import { t, type TranslationKey } from '@/i18n';
import { ApiCallError } from '@/lib/api/errors';
import { canReviewWorkLog, type Capabilities } from '@/lib/permissions';

/**
 * Review rules as the dashboard shows them (UX only: the API decides, ADR-0005). The one rule
 * the UI must never get wrong is self-approval: a reviewer's own log never gets Approve /
 * Reject, is never selectable for a bulk review, and the detail page says why. Pure, so tested.
 */

type ReviewableLog = Pick<WorkLog, 'id' | 'authorId' | 'status' | 'archivedAt' | 'version'>;

export type ReviewState =
  /** Buttons to offer; `approve` / `reject` are false for the status the log already has. */
  | { kind: 'available'; approve: boolean; reject: boolean }
  /** The caller wrote the log: no buttons, an explanation instead. */
  | { kind: 'self' }
  | { kind: 'notReviewer' }
  | { kind: 'archived' }
  | { kind: 'draft' };

export function reviewStateOf(
  capabilities: Capabilities,
  callerId: string,
  log: Pick<WorkLog, 'authorId' | 'status' | 'archivedAt'>,
): ReviewState {
  if (!capabilities.reviewWorkLogs) {
    return { kind: 'notReviewer' };
  }
  if (log.authorId === callerId) {
    return { kind: 'self' };
  }
  if (log.archivedAt !== null) {
    return { kind: 'archived' };
  }
  if (!canReviewWorkLog(capabilities, callerId, log)) {
    return { kind: 'draft' };
  }
  return {
    kind: 'available',
    approve: log.status !== 'approved',
    reject: log.status !== 'rejected',
  };
}

/** The explanation shown instead of the buttons, or null when the buttons are shown. */
export function reviewStateMessage(state: ReviewState): string | null {
  switch (state.kind) {
    case 'available':
      return null;
    case 'self':
      return t('workLogs.review.self');
    case 'notReviewer':
      return t('workLogs.review.notReviewer');
    case 'archived':
      return t('workLogs.review.archived');
    case 'draft':
      return t('workLogs.review.draft');
  }
}

/** What the list page offers a role (UX only). */
export interface WorkLogListFeatures {
  /** Row checkboxes and the bulk Approve / Reject buttons. */
  bulkReview: boolean;
  exportCsv: boolean;
  report: boolean;
  map: boolean;
}

export function workLogListFeatures(capabilities: Capabilities): WorkLogListFeatures {
  return {
    bulkReview: capabilities.reviewWorkLogs,
    exportCsv: capabilities.exportData,
    report: capabilities.viewOverview,
    map: capabilities.viewOverview,
  };
}

/** May this row get a checkbox for bulk review? Never the caller's own log. */
export function isBulkSelectable(
  capabilities: Capabilities,
  callerId: string,
  log: ReviewableLog,
): boolean {
  return canReviewWorkLog(capabilities, callerId, log);
}

/**
 * The bulk request's items: the selected rows of the page that may still be reviewed, with
 * their version (optimistic concurrency). A selected id that is not selectable (the caller's own
 * log, an archived or draft one, a row no longer on the page) is dropped, so the UI never even
 * asks the server for a self-approval.
 */
export function bulkItemsOf(
  rows: readonly ReviewableLog[],
  selected: ReadonlySet<string>,
  capabilities: Capabilities,
  callerId: string,
): BulkWorkLogStatusInput['items'] {
  return rows
    .filter((row) => selected.has(row.id) && isBulkSelectable(capabilities, callerId, row))
    .map((row) => ({ id: row.id, expectedVersion: row.version }));
}

/** The selection kept after the page's rows changed: only ids still on the page and selectable. */
export function pruneSelection(
  selected: ReadonlySet<string>,
  rows: readonly ReviewableLog[],
  capabilities: Capabilities,
  callerId: string,
): Set<string> {
  const allowed = new Set(
    rows.filter((row) => isBulkSelectable(capabilities, callerId, row)).map((row) => row.id),
  );
  return new Set([...selected].filter((id) => allowed.has(id)));
}

const REVIEW_ERROR_KEYS: Partial<Record<ApiErrorCode, TranslationKey>> = {
  forbidden: 'workLogs.review.errors.forbidden',
  not_found: 'workLogs.review.errors.notFound',
  version_conflict: 'workLogs.review.errors.versionConflict',
  already_reviewed: 'workLogs.review.errors.alreadyReviewed',
  record_archived: 'workLogs.review.errors.archived',
  edit_window_closed: 'workLogs.review.errors.editWindowClosed',
  conflict: 'workLogs.review.errors.conflict',
};

/**
 * The sentence for a refused review, from the server's typed reason (`code`). Validation errors
 * keep the server's own message, which names the field.
 */
export function reviewRefusalMessage(error: { code: ApiErrorCode; message: string }): string {
  if (error.code === 'validation_failed' || error.code === 'unprocessable') {
    return t('workLogs.review.errors.validation', { message: error.message });
  }
  const key = REVIEW_ERROR_KEYS[error.code];
  return key ? t(key) : error.message;
}

/** The refusal reason of a failed single review call, or null when it is not an API refusal. */
export function reviewErrorOf(error: unknown): { code: ApiErrorCode; message: string } | null {
  if (error instanceof ApiCallError && error.failure.kind === 'http') {
    return { code: error.failure.error.code, message: error.failure.error.message };
  }
  return null;
}

export interface BulkOutcomeRow {
  id: string;
  ok: boolean;
  /** The translated refusal, for a failed item. */
  reason: string | null;
}

/** Per-item lines of a bulk result, in request order. */
export function bulkOutcomeRows(result: BulkWorkLogStatusResult): BulkOutcomeRow[] {
  return result.results.map((item) =>
    item.ok
      ? { id: item.id, ok: true, reason: null }
      : { id: item.id, ok: false, reason: reviewRefusalMessage(item.error) },
  );
}
