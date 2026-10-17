import type { LogType, ResolvedScope, Site, Task, Team, WorkLog } from '@ops/shared';

import { parseIso } from './dates';

// Rules the phone applies to work logs before asking the API: whether the author may still edit
// a log, which log types to offer first, where a new log probably belongs. The API enforces the
// real rules; these only decide what the screens show.

const HOUR_MS = 60 * 60 * 1000;

/** The moment the author's edit window closes: `createdAt` plus the organization's window. */
export function editWindowEndsAt(
  log: Pick<WorkLog, 'createdAt'>,
  editWindowHours: number,
): Date | null {
  const created = parseIso(log.createdAt);
  return created === null ? null : new Date(created.getTime() + editWindowHours * HOUR_MS);
}

/**
 * Mirrors the API's `canEditWorkLog` for the author: their own log, not archived, not approved,
 * and inside the edit window counted from `createdAt` (the edge itself still counts as inside).
 */
export function canEditWorkLog(
  log: Pick<WorkLog, 'authorId' | 'status' | 'createdAt' | 'archivedAt'>,
  userId: string,
  now: Date,
  editWindowHours: number,
): boolean {
  if (log.authorId !== userId || log.archivedAt !== null || log.status === 'approved') {
    return false;
  }
  const endsAt = editWindowEndsAt(log, editWindowHours);
  return endsAt !== null && now.getTime() <= endsAt.getTime();
}

/** A rejected log can be sent for review again by its author while it is still editable. */
export function canResubmitWorkLog(
  log: Pick<WorkLog, 'authorId' | 'status' | 'createdAt' | 'archivedAt'>,
  userId: string,
  now: Date,
  editWindowHours: number,
): boolean {
  return log.status === 'rejected' && canEditWorkLog(log, userId, now, editWindowHours);
}

/** A draft (created on the web, for instance) can be submitted by its author. */
export function canSubmitDraft(
  log: Pick<WorkLog, 'authorId' | 'status' | 'createdAt' | 'archivedAt'>,
  userId: string,
  now: Date,
  editWindowHours: number,
): boolean {
  return log.status === 'draft' && canEditWorkLog(log, userId, now, editWindowHours);
}

/**
 * Log types in the order to offer them: the ones the worker used most in `recentLogs` first,
 * then the others by name. Archived types are left out.
 */
export function orderLogTypesByUse(
  logTypes: readonly LogType[],
  recentLogs: readonly Pick<WorkLog, 'logTypeId'>[],
): LogType[] {
  const uses = new Map<string, number>();
  for (const log of recentLogs) {
    if (log.logTypeId !== null) {
      uses.set(log.logTypeId, (uses.get(log.logTypeId) ?? 0) + 1);
    }
  }
  return logTypes
    .filter((type) => type.archivedAt === null)
    .sort((a, b) => {
      const byUse = (uses.get(b.id) ?? 0) - (uses.get(a.id) ?? 0);
      return byUse !== 0 ? byUse : a.name.localeCompare(b.name);
    });
}

export interface Placement {
  siteId: string | null;
  teamId: string | null;
}

/**
 * Where a new log probably belongs. From the task when there is one (its site and team).
 * Otherwise the worker's only site and only team, when they work at exactly one (`memberOf`
 * from `/scope/me`) and it is in the list of active sites/teams they can pick from; anything
 * less obvious is left for the worker to choose.
 */
export function defaultPlacement(input: {
  task?: Pick<Task, 'siteId' | 'teamId'> | null;
  memberOf?: ResolvedScope['memberOf'] | null;
  sites: readonly Pick<Site, 'id' | 'archivedAt'>[];
  teams: readonly Pick<Team, 'id' | 'archivedAt'>[];
}): Placement {
  if (input.task) {
    return { siteId: input.task.siteId, teamId: input.task.teamId };
  }
  const only = (
    ids: readonly string[] | undefined,
    list: readonly { id: string; archivedAt: string | null }[],
  ) => {
    if (!ids || ids.length !== 1) return null;
    const id = ids[0] ?? null;
    return list.some((item) => item.id === id && item.archivedAt === null) ? id : null;
  };
  const memberOf = input.memberOf;
  if (!memberOf || memberOf.orgWide) {
    return { siteId: null, teamId: null };
  }
  return {
    siteId: only(memberOf.siteIds, input.sites),
    teamId: only(memberOf.teamIds, input.teams),
  };
}
