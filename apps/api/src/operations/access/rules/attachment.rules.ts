import type { AccessContext } from '../access-context';
import type { Decision } from '../decision';
import type { WhereFragment } from '../visibility';
import { canArchiveWorkLog, workLogVisibilityWhere, type WorkLogFacts } from './work-log.rules';

/**
 * Attachments follow their work log.
 *
 * Reading: whoever can see the log sees its attachments.
 * Adding or archiving one: the log's author while they may still change the log (not approved,
 * inside the edit window), or a reviewer (supervisor or above who can see the log and did not
 * write it). That is exactly the rule for archiving the log, so it is reused, not repeated.
 */
export function canChangeAttachments(
  context: AccessContext,
  workLog: WorkLogFacts,
  now: Date,
  editWindowHours: number,
): Decision {
  return canArchiveWorkLog(context, workLog, now, editWindowHours);
}

/** Prisma `where` fragment for attachments: the parent work log must be visible. */
export function attachmentVisibilityWhere(context: AccessContext): WhereFragment {
  return { workLog: workLogVisibilityWhere(context) };
}
