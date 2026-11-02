import { buildAccessContext, systemAccessContext, type AccessContext } from '../access-context';
import { MATCH_NOTHING } from '../visibility';
import {
  anomalyFlagVisibilityWhere,
  canSeeAnomalyFlag,
  type AnomalySubjectFacts,
  type VisibleAnomalySubjects,
} from './anomaly.rules';

const ORG = 'org';

function contextOf(role: 'worker' | 'supervisor' | 'manager'): AccessContext {
  return buildAccessContext({
    userId: 'me',
    organizationId: ORG,
    active: true,
    roles: [role],
    orgWide: role === 'manager',
    siteIds: role === 'supervisor' ? ['s1'] : [],
    teamIds: [],
    userIds: role === 'manager' ? 'all' : ['u1'],
    colleagueIds: [],
    memberOf: { orgWide: false, siteIds: [], teamIds: [] },
  });
}

const flag = (overrides: Partial<AnomalySubjectFacts>): AnomalySubjectFacts => ({
  siteId: null,
  teamId: null,
  userId: null,
  taskId: null,
  workLogId: null,
  logTypeId: null,
  ...overrides,
});

const visible: VisibleAnomalySubjects = {
  siteIds: ['s1'],
  teamIds: [],
  userIds: ['u1'],
  taskIds: ['t1'],
  workLogIds: 'all',
};

describe('anomaly flag visibility', () => {
  it('a flag is visible only when every subject set on it is visible', () => {
    const supervisor = contextOf('supervisor');
    expect(canSeeAnomalyFlag(supervisor, visible, flag({ siteId: 's1' }))).toBe(true);
    expect(canSeeAnomalyFlag(supervisor, visible, flag({ siteId: 's1', taskId: 't1' }))).toBe(true);
    expect(canSeeAnomalyFlag(supervisor, visible, flag({ siteId: 's1', taskId: 't2' }))).toBe(
      false,
    );
    expect(canSeeAnomalyFlag(supervisor, visible, flag({ siteId: 's2' }))).toBe(false);
    expect(canSeeAnomalyFlag(supervisor, visible, flag({ teamId: 'x' }))).toBe(false);
    expect(canSeeAnomalyFlag(supervisor, visible, flag({ workLogId: 'any', logTypeId: 'l' }))).toBe(
      true,
    );
  });

  it('a worker sees no flag; the system and an org-wide reader see what is visible', () => {
    expect(canSeeAnomalyFlag(contextOf('worker'), visible, flag({ siteId: 's1' }))).toBe(false);
    expect(anomalyFlagVisibilityWhere(contextOf('worker'), visible)).toEqual(MATCH_NOTHING);
    const all: VisibleAnomalySubjects = {
      siteIds: 'all',
      teamIds: 'all',
      userIds: 'all',
      taskIds: 'all',
      workLogIds: 'all',
    };
    expect(anomalyFlagVisibilityWhere(systemAccessContext(ORG), all)).toEqual({});
    expect(anomalyFlagVisibilityWhere(contextOf('manager'), all)).toEqual({});
  });

  it('the where fragment says the same as the predicate', () => {
    expect(anomalyFlagVisibilityWhere(contextOf('supervisor'), visible)).toEqual({
      AND: [
        { OR: [{ siteId: null }, { siteId: { in: ['s1'] } }] },
        { OR: [{ teamId: null }, { teamId: { in: [] } }] },
        { OR: [{ userId: null }, { userId: { in: ['u1'] } }] },
        { OR: [{ taskId: null }, { taskId: { in: ['t1'] } }] },
      ],
    });
  });
});
