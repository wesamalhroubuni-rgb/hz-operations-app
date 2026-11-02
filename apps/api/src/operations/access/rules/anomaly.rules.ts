import type { AccessContext } from '../access-context';
import { MATCH_NOTHING, type WhereFragment } from '../visibility';

/**
 * Anomaly flags (Phase 7, ADR-0011 section 2): a flag is visible only when the reader can see
 * EVERY subject set on it (site, team, user, task, work log; log types are visible to every
 * member). A flag table row has no relations to its subjects, so the visible ids of each kind are
 * resolved first, through each resource's own visibility filter
 * (`resolveVisibleAnomalySubjects` in `operations/ai/anomalies/`), and this module turns them
 * into the one `where` used by `GET /ai/anomalies` and by the daily summaries.
 */

/** Per subject kind: every id is visible (`'all'`), or exactly these ids. */
export type VisibleIds = 'all' | readonly string[];

export interface VisibleAnomalySubjects {
  siteIds: VisibleIds;
  teamIds: VisibleIds;
  userIds: VisibleIds;
  taskIds: VisibleIds;
  workLogIds: VisibleIds;
}

/** The subject columns of a flag. */
export interface AnomalySubjectFacts {
  siteId: string | null;
  teamId: string | null;
  userId: string | null;
  taskId: string | null;
  workLogId: string | null;
  logTypeId: string | null;
}

const SUBJECTS = [
  ['siteId', 'siteIds'],
  ['teamId', 'teamIds'],
  ['userId', 'userIds'],
  ['taskId', 'taskIds'],
  ['workLogId', 'workLogIds'],
] as const;

/** Only a supervisor or above (or the system) reads flags; a worker sees none. */
function readsFlags(context: AccessContext): boolean {
  return context.system || context.isSupervisorOrAbove;
}

/** The in-memory predicate: may this flag be seen, given the visible subject ids? */
export function canSeeAnomalyFlag(
  context: AccessContext,
  visible: VisibleAnomalySubjects,
  flag: AnomalySubjectFacts,
): boolean {
  if (!readsFlags(context)) {
    return false;
  }
  return SUBJECTS.every(([column, kind]) => {
    const id = flag[column];
    const ids = visible[kind];
    return id === null || ids === 'all' || ids.includes(id);
  });
}

/**
 * The same rule as a Prisma `where` fragment over `AnomalyFlag`: for each subject column, null
 * or one of the visible ids. Put it under `AND` next to the organization and the filters.
 */
export function anomalyFlagVisibilityWhere(
  context: AccessContext,
  visible: VisibleAnomalySubjects,
): WhereFragment {
  if (!readsFlags(context)) {
    return MATCH_NOTHING;
  }
  const and: WhereFragment[] = [];
  for (const [column, kind] of SUBJECTS) {
    const ids = visible[kind];
    if (ids !== 'all') {
      and.push({ OR: [{ [column]: null }, { [column]: { in: [...new Set(ids)] } }] });
    }
  }
  return and.length === 0 ? {} : { AND: and };
}
