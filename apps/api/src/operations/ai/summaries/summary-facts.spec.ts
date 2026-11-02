import type { AnomalyFlag, DailySummaryStats } from '@ops/shared';
import {
  allowedNumbers,
  buildNarrativeFacts,
  checkNarrative,
  NARRATIVE_MAX_CHARACTERS,
  normalizeDigits,
  substitutePeople,
} from './summary-facts';
import { renderDailySummaryNotification, templateNarrative } from './summary-messages';

function statsFixture(overrides: Partial<DailySummaryStats> = {}): DailySummaryStats {
  return {
    day: '2026-10-20',
    timeZone: 'Europe/Istanbul',
    dayStart: '2026-10-19T21:00:00.000Z',
    dayEnd: '2026-10-20T21:00:00.000Z',
    logs: { total: 12, draft: 1, submitted: 4, approved: 6, rejected: 1, aiAssisted: 2 },
    reviews: { approved: 6, rejected: 1 },
    awaitingApproval: 4,
    tasks: { open: 9, overdue: 3, blocked: 2, completed: 5, created: 7 },
    workers: { active: 8, idle: 11 },
    bySite: [
      {
        id: 's1',
        name: 'Harbour Project',
        logs: 10,
        tasksOpen: 6,
        tasksOverdue: 3,
        tasksBlocked: 2,
        tasksCompleted: 4,
      },
      {
        id: 's9',
        name: null,
        logs: 2,
        tasksOpen: 0,
        tasksOverdue: 0,
        tasksBlocked: 0,
        tasksCompleted: 0,
      },
    ],
    byTeam: [],
    anomalies: {
      total: 2,
      byKind: { no_activity_site: 1, slow_task: 0, repeated_rejections: 1, far_location: 0 },
    },
    ...overrides,
  };
}

const flags: AnomalyFlag[] = [
  {
    id: 'f1',
    organizationId: 'o',
    day: '2026-10-20',
    kind: 'no_activity_site',
    severity: 'high',
    siteId: 's2',
    teamId: null,
    userId: null,
    taskId: null,
    workLogId: null,
    logTypeId: null,
    params: { lookbackDays: 14, lastLogAt: '2026-10-18T08:00:00.000Z', openTasks: 13 },
    createdAt: '2026-10-20T15:00:00.000Z',
  },
  {
    id: 'f2',
    organizationId: 'o',
    day: '2026-10-20',
    kind: 'repeated_rejections',
    severity: 'medium',
    siteId: null,
    teamId: null,
    userId: 'u1',
    taskId: null,
    workLogId: null,
    logTypeId: null,
    params: { rejections: 17, windowDays: 7 },
    createdAt: '2026-10-20T15:00:00.000Z',
  },
];

const input = () => ({
  stats: statsFixture(),
  anomalies: flags,
  names: {
    sites: new Map([['s2', 'Depot 42']]),
    tasks: new Map<string, string>(),
    users: new Map([['u1', 'Ayşe Demir']]),
  },
  completedTaskTitles: ['Replace valve'],
});

describe('narrative facts', () => {
  it('names people only by reference and holds no display name, e-mail or log text', () => {
    const { facts, people } = buildNarrativeFacts(input());
    const text = JSON.stringify(facts);
    expect(people).toEqual(new Map([['P1', 'Ayşe Demir']]));
    expect(text).toContain('"person":"P1"');
    expect(text).not.toContain('Ayşe');
    expect(text).not.toContain('@');
    expect(text).toContain('Depot 42');
    // The unnamed site row (not visible by itself) is not given to the model.
    expect(text).not.toContain('"name":null');
    // The last log date becomes a day count relative to the summary day.
    expect(text).toContain('"daysSinceLastLog":2');
  });

  it('a flag whose person is not visible gets no reference', () => {
    const { facts, people } = buildNarrativeFacts({
      ...input(),
      names: { ...input().names, users: new Map() },
    });
    expect(people.size).toBe(0);
    expect(JSON.stringify(facts)).toContain('"person":null');
  });
});

describe('narrative check', () => {
  const { facts, people } = buildNarrativeFacts(input());
  const allowed = allowedNumbers(facts);
  const check = (text: string) => checkNarrative(text, allowed, people);

  it('accepts numbers from the facts, date parts and digits inside names', () => {
    expect(allowed.has(12)).toBe(true);
    expect(allowed.has(2026)).toBe(true);
    expect(allowed.has(42)).toBe(true);
    expect(
      check('On 2026-10-20, 12 logs were recorded; Depot 42 had none. P1 had 17 rejections.'),
    ).toBeNull();
    expect(check('Fake narrative.')).toBeNull();
  });

  it('refuses a number that is not in the facts', () => {
    expect(check('There were 13 logs and 99 tasks.')).toMatch(/99/);
    expect(check('Logs rose by 50%.')).toMatch(/50/);
  });

  it('checks Arabic-Indic digits like ASCII ones', () => {
    expect(normalizeDigits('١٢ ۴۲')).toBe('12 42');
    expect(check('سجل ١٢')).toBeNull();
    expect(check('سجل ٩٩')).toMatch(/99/);
  });

  it('refuses unknown person references, empty and too long text', () => {
    expect(check('P2 was rejected 17 times.')).toMatch(/P2/);
    expect(check('   ')).toMatch(/empty/);
    expect(check('a'.repeat(NARRATIVE_MAX_CHARACTERS + 1))).toMatch(/longer/);
  });

  it('the digits of a reference are not numbers of the text', () => {
    expect(check('P1 needs a look.')).toBeNull();
  });

  it('substitutes display names after the check', () => {
    expect(substitutePeople(' P1 had 17 rejections. ', people)).toBe(
      'Ayşe Demir had 17 rejections.',
    );
  });
});

describe('template narrative and notification texts', () => {
  it('is built from the stats only, and passes its own number check', () => {
    const stats = statsFixture();
    const text = templateNarrative(stats, 'en');
    expect(text).toContain('Daily summary for 2026-10-20.');
    expect(text).toContain('12 work logs were recorded');
    expect(text).toContain('9 open, 3 overdue, 2 blocked');
    expect(text).toContain('Most activity: Harbour Project (10 logs).');
    expect(text).toContain('2 unusual items were flagged');
    const { facts } = buildNarrativeFacts({ ...input(), anomalies: [] });
    expect(checkNarrative(text, allowedNumbers({ facts, stats }), new Map())).toBeNull();
  });

  it('says so when nothing happened', () => {
    const empty = statsFixture({
      logs: { total: 0, draft: 0, submitted: 0, approved: 0, rejected: 0, aiAssisted: 0 },
      bySite: [],
      anomalies: {
        total: 0,
        byKind: { no_activity_site: 0, slow_task: 0, repeated_rejections: 0, far_location: 0 },
      },
    });
    const text = templateNarrative(empty, 'en');
    expect(text).toContain('No work logs were recorded.');
    expect(text).toContain('No unusual items were flagged.');
  });

  it('falls back to English, key by key, for other and unknown locales', () => {
    expect(templateNarrative(statsFixture(), 'tr')).toBe(templateNarrative(statsFixture(), 'en'));
    expect(templateNarrative(statsFixture(), 'xx')).toBe(templateNarrative(statsFixture(), 'en'));
  });

  it('the push text is generic; the counts stay in the in-app text', () => {
    const message = renderDailySummaryNotification(
      { day: '2026-10-20', logs: 12, overdue: 3, anomalies: 1 },
      'ar',
    );
    expect(message.push).toEqual({ title: 'Daily summary', body: 'Your daily summary is ready.' });
    expect(message.title).toBe('Daily summary for 2026-10-20');
    expect(message.body).toContain('12 work logs, 3 overdue tasks, 1 unusual item');
  });
});
