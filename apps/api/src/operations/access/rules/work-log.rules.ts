import type { WorkLogStatus } from '@ops/shared';
import type { AccessContext } from '../access-context';
import { ALLOW, conflict, forbid, notVisible, type Decision } from '../decision';
import {
  anyOf,
  EVERYTHING,
  fieldIn,
  isVisible,
  visibilityWhere,
  type Visibility,
  type WhereFragment,
} from '../visibility';

/** What the rules need to know about a work log. */
export interface WorkLogFacts {
  authorId: string;
  siteId: string | null;
  teamId: string | null;
  status: WorkLogStatus;
  /** When the server stored the log: the start of the author's edit window. */
  createdAt: Date;
}

type WorkLogPlacement = Pick<WorkLogFacts, 'authorId' | 'siteId' | 'teamId'>;

/**
 * Who sees a work log: its author; whoever oversees the whole organization (manager, admin,
 * organization-wide supervisor); a supervisor when the log's site or team is in their scope or
 * its author is one of their people. A worker therefore sees their own logs only.
 */
export function workLogVisibility(context: AccessContext): Visibility<WorkLogPlacement> {
  const { scope } = context;
  if (scope.orgWide || scope.userIds === 'all') {
    return EVERYTHING;
  }
  return anyOf<WorkLogPlacement>(
    fieldIn('authorId', [context.userId, ...scope.userIds]),
    fieldIn('siteId', scope.siteIds),
    fieldIn('teamId', scope.teamIds),
  );
}

export function canSeeWorkLog(context: AccessContext, log: WorkLogPlacement): boolean {
  return isVisible(workLogVisibility(context), log);
}

/** Prisma `where` fragment of {@link canSeeWorkLog}; both read {@link workLogVisibility}. */
export function workLogVisibilityWhere(context: AccessContext): WhereFragment {
  return visibilityWhere(workLogVisibility(context));
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * True while the author may still change the log: up to and including `editWindowHours` after
 * `createdAt`. A log dated in the future (clock skew) counts as inside the window.
 */
export function isWithinEditWindow(createdAt: Date, now: Date, editWindowHours: number): boolean {
  return now.getTime() - createdAt.getTime() <= editWindowHours * HOUR_MS;
}

/**
 * The author's right to change their own log: not approved (409 `already_reviewed`), and inside
 * the edit window (403 `edit_window_closed`). Somebody else: 403 `forbidden`. The order is the
 * check order of ADR-0008 section 2.
 */
function authorMayChange(
  context: AccessContext,
  log: WorkLogFacts,
  now: Date,
  editWindowHours: number,
): Decision {
  if (log.authorId !== context.userId) {
    return forbid('Only the author can change a work log');
  }
  if (log.status === 'approved') {
    return conflict('An approved work log cannot be changed by its author', 'already_reviewed');
  }
  if (!isWithinEditWindow(log.createdAt, now, editWindowHours)) {
    return forbid(
      `The edit window of ${editWindowHours} hours for this work log has passed`,
      'edit_window_closed',
    );
  }
  return ALLOW;
}

/** A reviewer's right over a log they can see: supervisor or above, and never their own log. */
function reviewerMayAct(context: AccessContext, log: WorkLogFacts): Decision {
  if (!context.isSupervisorOrAbove) {
    return forbid('Only a supervisor, manager or admin can review a work log');
  }
  if (log.authorId === context.userId) {
    return forbid('You cannot review your own work log');
  }
  return ALLOW;
}

/**
 * Editing the content of a log: its author only, while it is not approved and inside the edit
 * window. Nobody else edits a log's content, whatever their role.
 */
export function canEditWorkLog(
  context: AccessContext,
  log: WorkLogFacts,
  now: Date,
  editWindowHours: number,
): Decision {
  if (!canSeeWorkLog(context, log)) {
    return notVisible();
  }
  return authorMayChange(context, log, now, editWindowHours);
}

/** Approving, rejecting or reopening: a supervisor or above who can see the log, never its author. */
export function canReviewWorkLog(context: AccessContext, log: WorkLogFacts): Decision {
  if (!canSeeWorkLog(context, log)) {
    return notVisible();
  }
  return reviewerMayAct(context, log);
}

/**
 * Archiving a log, and adding or archiving its attachments: the author under the same rule as
 * an edit, or a reviewer (supervisor or above who can see it, and not its author).
 */
export function canArchiveWorkLog(
  context: AccessContext,
  log: WorkLogFacts,
  now: Date,
  editWindowHours: number,
): Decision {
  if (!canSeeWorkLog(context, log)) {
    return notVisible();
  }
  return log.authorId === context.userId
    ? authorMayChange(context, log, now, editWindowHours)
    : reviewerMayAct(context, log);
}

export type WorkLogTransitionActor = 'author' | 'reviewer';

export interface WorkLogTransition {
  from: WorkLogStatus;
  to: WorkLogStatus;
  by: WorkLogTransitionActor;
}

/**
 * Every status move that exists, and who makes it. A move that is not listed is not possible
 * for anybody (409). `rejected -> submitted` is listed twice: the author resubmits, a reviewer
 * reopens.
 */
export const WORK_LOG_TRANSITIONS: readonly WorkLogTransition[] = [
  { from: 'draft', to: 'submitted', by: 'author' },
  { from: 'submitted', to: 'draft', by: 'author' },
  { from: 'rejected', to: 'submitted', by: 'author' },
  { from: 'submitted', to: 'approved', by: 'reviewer' },
  { from: 'submitted', to: 'rejected', by: 'reviewer' },
  { from: 'approved', to: 'submitted', by: 'reviewer' },
  { from: 'rejected', to: 'submitted', by: 'reviewer' },
  // Same decision again, to correct the reviewer's note (the service treats an unchanged note
  // as a no-op before these rules are consulted).
  { from: 'approved', to: 'approved', by: 'reviewer' },
  { from: 'rejected', to: 'rejected', by: 'reviewer' },
];

/**
 * Moving a log to another status, per {@link WORK_LOG_TRANSITIONS}. The author's moves follow
 * the edit rule (inside the window, not approved); a reviewer's moves follow the review rule
 * (never one's own log).
 */
export function canChangeWorkLogStatus(
  context: AccessContext,
  log: WorkLogFacts,
  to: WorkLogStatus,
  now: Date,
  editWindowHours: number,
): Decision {
  if (!canSeeWorkLog(context, log)) {
    return notVisible();
  }
  const moves = WORK_LOG_TRANSITIONS.filter(
    (transition) => transition.from === log.status && transition.to === to,
  );
  if (moves.length === 0) {
    return conflict(`A work log that is ${log.status} cannot become ${to}`);
  }

  const decide = (by: WorkLogTransitionActor): Decision | undefined =>
    moves.some((move) => move.by === by)
      ? by === 'author'
        ? authorMayChange(context, log, now, editWindowHours)
        : reviewerMayAct(context, log)
      : undefined;
  const asAuthor = decide('author');
  const asReviewer = decide('reviewer');
  if (asAuthor?.allowed || asReviewer?.allowed) {
    return ALLOW;
  }
  // Report the refusal that speaks to the caller: the author's rule to the author.
  const isAuthor = log.authorId === context.userId;
  return (
    (isAuthor ? (asAuthor ?? asReviewer) : (asReviewer ?? asAuthor)) ??
    forbid('You cannot change the status of this work log')
  );
}
