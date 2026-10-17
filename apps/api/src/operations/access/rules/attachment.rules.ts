import type { AttachmentStatus } from '@ops/shared';
import type { AccessContext } from '../access-context';
import type { Decision } from '../decision';
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
