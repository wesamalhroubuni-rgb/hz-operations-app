import { ANOMALY_THRESHOLDS, anomalyParamsSchemas } from '@ops/shared';
import {
  dominantLogType,
  farLocationFlags,
  fingerprintOf,
  haversineKm,
  median,
  noActivitySiteFlags,
  repeatedRejectionFlags,
  siteReference,
  slowTaskFlags,
  type CandidateFlag,
  type CompletedTaskFacts,
  type SiteActivityFacts,
} from './anomaly-rules';

const HOUR = 3_600_000;
const AS_OF = new Date('2026-10-20T15:00:00.000Z');
const hoursBefore = (hours: number) => new Date(AS_OF.getTime() - hours * HOUR);

function expectValidParams(flags: CandidateFlag[]): void {
  for (const flag of flags) {
    expect(anomalyParamsSchemas[flag.kind].safeParse(flag.params).success).toBe(true);
  }
}

describe('anomaly rule helpers', () => {
  it('median of odd, even and empty lists', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('haversine distance of known points', () => {
    const istanbul = { latitude: 41.0082, longitude: 28.9784 };
    const ankara = { latitude: 39.9334, longitude: 32.8597 };
    expect(haversineKm(istanbul, ankara)).toBeGreaterThan(345);
    expect(haversineKm(istanbul, ankara)).toBeLessThan(352);
    expect(haversineKm(istanbul, istanbul)).toBe(0);
  });

  it('dominant log type: most frequent, ties to the smallest id, null without a type', () => {
    expect(dominantLogType(['b', 'a', 'b', null])).toBe('b');
    expect(dominantLogType(['b', 'a'])).toBe('a');
    expect(dominantLogType([null, null])).toBeNull();
  });

  it('fingerprints differ by kind, day and every subject, and are stable', () => {
    const a = fingerprintOf('slow_task', '2026-10-20', { taskId: 't1', siteId: 's1' });
    expect(a).toBe(fingerprintOf('slow_task', '2026-10-20', { siteId: 's1', taskId: 't1' }));
    expect(a).not.toBe(fingerprintOf('slow_task', '2026-10-21', { taskId: 't1', siteId: 's1' }));
    expect(a).not.toBe(fingerprintOf('slow_task', '2026-10-20', { taskId: 't1' }));
    expect(a).not.toBe(fingerprintOf('far_location', '2026-10-20', { taskId: 't1', siteId: 's1' }));
  });
});

describe('no_activity_site', () => {
  const site = (overrides: Partial<SiteActivityFacts>): SiteActivityFacts => ({
    siteId: 's1',
    openTasks: 0,
    overdueOpenTasks: 0,
    logsInLookback: 0,
    logsOnDay: 0,
    lastLogBeforeDay: null,
    ...overrides,
  });

  it('flags an active site without a log on the day', () => {
    const last = new Date('2026-10-18T09:00:00.000Z');
    const flags = noActivitySiteFlags([site({ logsInLookback: 4, lastLogBeforeDay: last })]);
    expect(flags).toEqual([
      {
        kind: 'no_activity_site',
        severity: 'medium',
        subjects: { siteId: 's1' },
        params: {
          lookbackDays: ANOMALY_THRESHOLDS.activeSiteLookbackDays,
          lastLogAt: last.toISOString(),
          openTasks: 0,
        },
      },
    ]);
    expectValidParams(flags);
  });

  it('an open task makes a site active; an overdue one makes the flag high', () => {
    expect(noActivitySiteFlags([site({ openTasks: 2 })])[0]).toMatchObject({
      severity: 'medium',
      params: { openTasks: 2, lastLogAt: null },
    });
    expect(noActivitySiteFlags([site({ openTasks: 2, overdueOpenTasks: 1 })])[0]?.severity).toBe(
      'high',
    );
  });

  it('no flag for an inactive site or a site with a log on the day', () => {
    expect(noActivitySiteFlags([site({})])).toEqual([]);
    expect(noActivitySiteFlags([site({ openTasks: 3, logsInLookback: 5, logsOnDay: 1 })])).toEqual(
      [],
    );
  });
});

describe('slow_task', () => {
  const done = (
    hours: number,
    overrides: Partial<CompletedTaskFacts> = {},
  ): CompletedTaskFacts => ({
    siteId: 's1',
    createdAt: hoursBefore(hours + 10),
    completedAt: hoursBefore(10),
    dominantLogTypeId: 'lt1',
    ...overrides,
  });
  const sample = (count: number, hours: number, overrides: Partial<CompletedTaskFacts> = {}) =>
    Array.from({ length: count }, () => done(hours, overrides));
  const open = (ageHours: number, dominantLogTypeId: string | null = 'lt1') => ({
    taskId: 't1',
    siteId: 's1' as string | null,
    createdAt: hoursBefore(ageHours),
    dominantLogTypeId,
  });

  it('flags a task older than 3x the median of its site and log type', () => {
    const flags = slowTaskFlags([open(31)], sample(5, 10), AS_OF);
    expect(flags).toEqual([
      {
        kind: 'slow_task',
        severity: 'medium',
        subjects: { taskId: 't1', siteId: 's1', logTypeId: 'lt1' },
        params: {
          ageHours: 31,
          medianHours: 10,
          factor: 3.1,
          sampleSize: 5,
          group: 'site_log_type',
        },
      },
    ]);
    expectValidParams(flags);
  });

  it('exactly 3x is not flagged; over 6x is high', () => {
    expect(slowTaskFlags([open(30)], sample(5, 10), AS_OF)).toEqual([]);
    expect(slowTaskFlags([open(61)], sample(5, 10), AS_OF)[0]?.severity).toBe('high');
    expect(slowTaskFlags([open(60)], sample(5, 10), AS_OF)[0]?.severity).toBe('medium');
  });

  it('falls back to the site when the log-type sample is below 5, and needs 5 there', () => {
    const mixed = [...sample(4, 10), ...sample(2, 10, { dominantLogTypeId: 'other' })];
    const flags = slowTaskFlags([open(40)], mixed, AS_OF);
    expect(flags[0]).toMatchObject({
      subjects: { taskId: 't1', siteId: 's1' },
      params: { group: 'site', sampleSize: 6 },
    });
    expect(flags[0]?.subjects).not.toHaveProperty('logTypeId');
    expect(slowTaskFlags([open(400)], sample(4, 10), AS_OF)).toEqual([]);
  });

  it('a task without logs of a type is compared with its site', () => {
    expect(slowTaskFlags([open(40, null)], sample(5, 10), AS_OF)[0]?.params).toMatchObject({
      group: 'site',
    });
  });

  it('ignores other sites, tasks without a site and a zero median', () => {
    expect(slowTaskFlags([open(400)], sample(5, 10, { siteId: 's2' }), AS_OF)).toEqual([]);
    expect(slowTaskFlags([{ ...open(400), siteId: null }], sample(5, 10), AS_OF)).toEqual([]);
    expect(slowTaskFlags([open(400)], sample(5, 0), AS_OF)).toEqual([]);
  });
});

describe('repeated_rejections', () => {
  it('needs 3 rejections; 5 or more is high', () => {
    expect(repeatedRejectionFlags(['u1', 'u1', 'u2'])).toEqual([]);
    const flags = repeatedRejectionFlags(['u1', 'u1', 'u1', 'u2', 'u2', 'u2', 'u2', 'u2']);
    expect(flags).toEqual([
      {
        kind: 'repeated_rejections',
        severity: 'medium',
        subjects: { userId: 'u1' },
        params: { rejections: 3, windowDays: ANOMALY_THRESHOLDS.repeatedRejectionsWindowDays },
      },
      {
        kind: 'repeated_rejections',
        severity: 'high',
        subjects: { userId: 'u2' },
        params: { rejections: 5, windowDays: ANOMALY_THRESHOLDS.repeatedRejectionsWindowDays },
      },
    ]);
    expectValidParams(flags);
  });
});

describe('far_location', () => {
  const site = { latitude: 41, longitude: 29 };
  // About 0.009 degrees of latitude is 1 km.
  const northBy = (km: number) => ({ latitude: 41 + km / 111.2, longitude: 29 });

  it('the site coordinates win; otherwise the median of at least 5 logs', () => {
    expect(siteReference(site, [])).toEqual({
      ...site,
      reference: 'site_coordinates',
      sampleSize: null,
    });
    const logs = [northBy(0), northBy(0.1), northBy(0.2), northBy(0.3), northBy(50)];
    expect(siteReference({ latitude: null, longitude: null }, logs)).toMatchObject({
      reference: 'median_of_logs',
      sampleSize: 5,
      latitude: northBy(0.2).latitude,
    });
    expect(siteReference({ latitude: null, longitude: 29 }, logs.slice(0, 4))).toBeNull();
  });

  it('flags a log more than 2 km away: low, and medium over 10 km', () => {
    const references = new Map([['s1', siteReference(site, [])!]]);
    const flags = farLocationFlags(
      [
        { workLogId: 'near', siteId: 's1', ...northBy(1.9) },
        { workLogId: 'far', siteId: 's1', ...northBy(3) },
        { workLogId: 'farther', siteId: 's1', ...northBy(12) },
        { workLogId: 'unknown-site', siteId: 's2', ...northBy(50) },
      ],
      references,
    );
    expect(flags.map((flag) => [flag.subjects.workLogId, flag.severity])).toEqual([
      ['far', 'low'],
      ['farther', 'medium'],
    ]);
    expect(flags[0]).toMatchObject({
      subjects: { workLogId: 'far', siteId: 's1' },
      params: { thresholdKm: 2, reference: 'site_coordinates', sampleSize: null },
    });
    expect((flags[0]!.params as { distanceKm: number }).distanceKm).toBeCloseTo(3, 1);
    expectValidParams(flags);
  });
});
