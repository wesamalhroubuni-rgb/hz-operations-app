import type { AttachmentStatus } from '@ops/shared';
import type { AccessContext } from '../access-context';
import { ALLOW, forbid, type Decision } from '../decision';
import type { WhereFragment } from '../visibility';
import {
  canArchiveWorkLog,
  canSeeWorkLog,
  workLogVisibilityWhere,
  type WorkLogFacts,
} from './work-log.rules';

/** Attachments a work log may hold at once (pending and ready, not archived). */
export const MAX_ATTACHMENTS_PER_WORK_LOG = 20;

/**
 * Attachments follow their work log.
 *
 * Reading: whoever can see the log sees its `ready` attachments. A `pending` attachment (the
 * upload has been started but not verified) is seen only by the person uploading it: for
 * everybody else it does not exist yet (404, and absent from lists).
 * Adding, completing or archiving one: the log's author while they may still change the log (not
 * approved, inside the edit window), or a reviewer (supervisor or above who can see the log and
 * did not write it). That is exactly the rule for archiving the log, so it is reused, not
 * repeated.
 */
export function canChangeAttachments(
  context: AccessContext,
  workLog: WorkLogFacts,
  now: Date,
  editWindowHours: number,
): Decision {
  return canArchiveWorkLog(context, workLog, now, editWindowHours);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** True while `now` is at most `days` after `since`. */
export function isWithinDays(since: Date, now: Date, days: number): boolean {
  return now.getTime() - since.getTime() <= days * DAY_MS;
}

/** What the upload rules read from a work log, on top of {@link WorkLogFacts}. */
export interface UploadWorkLogFacts extends WorkLogFacts {
  /** The photo clientIds declared in the log's create request (ADR-0008). */
  declaredAttachmentClientIds: readonly string[];
}

/**
 * Starting a photo upload on a log (ADR-0008 section 5): the normal rule
 * ({@link canChangeAttachments}), or, for the log's author, a photo that is part of the original
 * submission: its `clientId` was declared in the log's create request and the log reached the
 * server at most `graceDays` ago, whatever the edit window and the log's status.
 *
 * Refusals for the author: a clientId that was not declared (or none) once the window closed is
 * 403 `attachment_not_declared`; a declared one after the grace period is 403
 * `edit_window_closed`. Everything else answers as the normal rule does. Whether the log is
 * archived is checked by the caller afterwards (409 `record_archived`).
 */
export function canStartAttachmentUpload(
  context: AccessContext,
  workLog: UploadWorkLogFacts,
  clientId: string | null,
  now: Date,
  editWindowHours: number,
  graceDays: number,
): Decision {
  const normal = canChangeAttachments(context, workLog, now, editWindowHours);
  if (normal.allowed || normal.outcome === 'not_found' || workLog.authorId !== context.userId) {
    return normal;
  }
  const declared = clientId !== null && workLog.declaredAttachmentClientIds.includes(clientId);
  if (declared) {
    return isWithinDays(workLog.createdAt, now, graceDays)
      ? ALLOW
      : forbid(
          `Photos declared with this work log could be added for ${graceDays} days after it was received; that time has passed`,
          'edit_window_closed',
        );
  }
  return normal.code === 'edit_window_closed'
    ? forbid(
        'The edit window of this work log has passed and this photo was not part of its original submission',
        'attachment_not_declared',
      )
    : normal;
}

/**
 * Renewing the upload URL of, or completing, a pending attachment: the normal rule, or the
 * person who started it within `graceDays` of its start (its start was already judged, so a
 * window that closed meanwhile does not strand the photo). Archived records are checked by the
 * caller.
 */
export function canContinueAttachmentUpload(
  context: AccessContext,
  workLog: WorkLogFacts,
  attachment: { uploadedById: string; createdAt: Date },
  now: Date,
  editWindowHours: number,
  graceDays: number,
): Decision {
  const normal = canChangeAttachments(context, workLog, now, editWindowHours);
  if (normal.allowed || normal.outcome === 'not_found') {
    return normal;
  }
  return attachment.uploadedById === context.userId &&
    isWithinDays(attachment.createdAt, now, graceDays)
    ? ALLOW
    : normal;
}

export interface AttachmentFacts {
  status: AttachmentStatus;
  uploadedById: string;
  workLog: Pick<WorkLogFacts, 'authorId' | 'siteId' | 'teamId'>;
}

/** The in-memory form of {@link attachmentVisibilityWhere}. */
export function canSeeAttachment(context: AccessContext, attachment: AttachmentFacts): boolean {
  return (
    canSeeWorkLog(context, attachment.workLog) &&
    (attachment.status === 'ready' || attachment.uploadedById === context.userId)
  );
}

/**
 * Prisma `where` fragment for attachments: the parent work log must be visible, and the
 * attachment must be ready or uploaded by the caller.
 */
export function attachmentVisibilityWhere(context: AccessContext): WhereFragment {
  return {
    workLog: workLogVisibilityWhere(context),
    OR: [{ status: 'ready' }, { uploadedById: context.userId }],
  };
}
