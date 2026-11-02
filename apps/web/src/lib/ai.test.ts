import {
  updateOrganizationSchema,
  type AiUsageReport,
  type AnomalyFlag,
  type DailySummary,
  type OrganizationFull,
} from '@ops/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AiUsageReportView } from '@/components/ai/ai-usage-page';
import { AnomalyTable, SummaryView } from '@/components/ai/summary-view';

import {
  aiSettingsFormFrom,
  aiSettingsUpdateBody,
  anomalyLink,
  anomalyReason,
  dayRangeFrom,
  daysBetween,
  durationText,
  summaryKeyNumbers,
  summaryScopeText,
  toggleRecipientRole,
  type ReasonNames,
} from './ai';
import { capabilitiesFor } from './permissions';
import { routeAccess } from './navigation';

const ID = (n: number) => `0190f3a2-7c1e-7000-8000-${String(n).padStart(12, '0')}`;

const names: ReasonNames = {
  site: (id) => (id === ID(1) ? 'Harbour Project' : id ? 'Unknown' : ''),
  user: (id) => (id === ID(2) ? 'Ayla Kaya' : id ? 'Unknown' : ''),
  dayOf: (value) => value.slice(0, 10),
};

const base = {
  organizationId: ID(9),
  day: '2026-10-20',
  severity: 'medium' as const,
  siteId: null,
  teamId: null,
  userId: null,
  taskId: null,
  workLogId: null,
  logTypeId: null,
  createdAt: '2026-10-20T15:00:00.000Z',
};

const FLAGS: AnomalyFlag[] = [
  {
    ...base,
    id: ID(11),
    kind: 'no_activity_site',
    severity: 'high',
    siteId: ID(1),
    params: { lookbackDays: 14, lastLogAt: '2026-10-18T08:00:00.000Z', openTasks: 3 },
  },
  {
    ...base,
    id: ID(12),
    kind: 'slow_task',
    siteId: ID(1),
    taskId: ID(5),
    params: { ageHours: 120, medianHours: 30, factor: 4, sampleSize: 6, group: 'site' },
  },
  {
    ...base,
    id: ID(13),
    kind: 'repeated_rejections',
    userId: ID(2),
    params: { rejections: 4, windowDays: 7 },
  },
  {
    ...base,
    id: ID(14),
    kind: 'far_location',
    severity: 'low',
    siteId: ID(1),
    workLogId: ID(6),
    params: { distanceKm: 3.46, thresholdKm: 2, reference: 'site_coordinates', sampleSize: null },
  },
];

const STATS: DailySummary['stats'] = {
  day: '2026-10-20',
  timeZone: 'Europe/Istanbul',
  dayStart: '2026-10-19T21:00:00.000Z',
  dayEnd: '2026-10-20T21:00:00.000Z',
  logs: { total: 12, draft: 0, submitted: 4, approved: 7, rejected: 1, aiAssisted: 2 },
  reviews: { approved: 7, rejected: 1 },
  awaitingApproval: 4,
  tasks: { open: 9, overdue: 0, blocked: 2, completed: 5, created: 3 },
  workers: { active: 8, idle: 2 },
  bySite: [],
  byTeam: [],
  anomalies: {
    total: 4,
    byKind: { no_activity_site: 1, slow_task: 1, repeated_rejections: 1, far_location: 1 },
  },
};

const SUMMARY: DailySummary = {
  id: ID(20),
  organizationId: ID(9),
  recipientId: ID(21),
  day: '2026-10-20',
  timeZone: 'Europe/Istanbul',
  scope: {
    roles: ['supervisor'],
    orgWide: false,
    siteIds: [ID(1), ID(3)],
    teamIds: [ID(4)],
    peopleCount: 5,
  },
  stats: STATS,
  anomalies: FLAGS,
  narrative: 'A quiet day.\n<b>Harbour Project</b> had 12 logs.',
  narrativeSource: 'ai',
  locale: 'en',
  createdAt: '2026-10-20T15:00:00.000Z',
};

const ORG: OrganizationFull = {
  view: 'full',
  id: ID(9),
  name: 'HZ Demo',
  slug: 'hz-demo',
  workLogEditWindowHours: 24,
  offlineMaxBackdateDays: 7,
  timeZone: 'Europe/Istanbul',
  settings: { workLogEditWindowHours: 24, timeZone: 'Europe/Istanbul', featureX: true },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
};

describe('flag reasons are written from the stored numbers', () => {
  it('renders each kind in words', () => {
    expect(FLAGS.map((flag) => anomalyReason(flag, names))).toEqual([
      'Harbour Project: no log on this day; 3 open tasks, last log 2 days earlier.',
      'Harbour Project: a task open for 5 days, 4 times the usual 30 hours of 6 similar tasks.',
      'Ayla Kaya: 4 rejected logs in the last 7 days.',
      "Harbour Project: a log 3.5 km from the site's position (the limit is 2 km).",
    ]);
  });

  it('falls back when a name is not visible or a site never had a log', () => {
    const flag = {
      ...FLAGS[0]!,
      siteId: null,
      params: { lookbackDays: 14, lastLogAt: null, openTasks: 1 },
    } as AnomalyFlag;
    expect(anomalyReason(flag, names)).toBe(
      'A site: no log on this day; 1 open task, no log in the last 14 days.',
    );
    expect(anomalyReason({ ...FLAGS[2]!, userId: null }, names)).toMatch(/^A worker:/);
  });

  it('links a flag to its task or log', () => {
    expect(anomalyLink(FLAGS[0]!)).toBeNull();
    expect(anomalyLink(FLAGS[1]!)?.href).toBe(`/tasks/${ID(5)}`);
    expect(anomalyLink(FLAGS[3]!)?.href).toBe(`/work-logs/${ID(6)}`);
  });

  it('durations and day arithmetic', () => {
    expect(durationText(1)).toBe('1 hour');
    expect(durationText(47.6)).toBe('48 hours');
    expect(durationText(48)).toBe('2 days');
    expect(daysBetween('2026-10-18', '2026-10-20')).toBe(2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });
});

describe('summary numbers and scope', () => {
  it('shows the stats, drawing attention only to non-zero problems', () => {
    const numbers = summaryKeyNumbers(STATS);
    expect(numbers.map((n) => [n.key, n.value, n.attention])).toEqual([
      ['logs', 12, false],
      ['awaiting', 4, true],
      ['open', 9, false],
      ['overdue', 0, false],
      ['blocked', 2, true],
      ['completed', 5, false],
      ['idle', 2, false],
      ['flags', 4, true],
    ]);
  });

  it('describes the scope', () => {
    expect(summaryScopeText(SUMMARY)).toBe('Covers your scope: 2 sites and 1 team.');
    expect(summaryScopeText({ scope: { ...SUMMARY.scope, orgWide: true } })).toBe(
      'Covers the whole organization.',
    );
  });
});

describe('day ranges from the URL', () => {
  it('uses a valid range, else the default days ending the given day', () => {
    expect(dayRangeFrom({ from: '2026-10-01', to: '2026-10-05' }, '2026-10-20', 7)).toEqual({
      from: '2026-10-01',
      to: '2026-10-05',
    });
    expect(dayRangeFrom({}, '2026-10-20', 7)).toEqual({ from: '2026-10-14', to: '2026-10-20' });
    expect(dayRangeFrom({ from: '2026-10-09', to: '2026-10-05' }, '2026-10-20', 7)).toEqual({
      from: '2026-09-29',
      to: '2026-10-05',
    });
    expect(dayRangeFrom({ from: 'nonsense' }, '2026-03-02', 3)).toEqual({
      from: '2026-02-28',
      to: '2026-03-02',
    });
  });
});

describe('AI settings: PATCH keeps every other setting and replaces settings.ai', () => {
  it('starts from the defaults', () => {
    expect(aiSettingsFormFrom(ORG)).toEqual({
      smartCaptureEnabled: false,
      dailySummaryEnabled: false,
      summaryTime: '18:00',
      summaryRecipientRoles: ['supervisor', 'manager'],
      dailyRequestLimit: '',
      dailyCostLimitUsd: '',
    });
  });

  it('sends the other keys unchanged and a valid ai object', () => {
    const result = aiSettingsUpdateBody(ORG, {
      ...aiSettingsFormFrom(ORG),
      dailySummaryEnabled: true,
      summaryTime: '17:30',
      summaryRecipientRoles: ['admin', 'supervisor'],
      dailyRequestLimit: '200',
      dailyCostLimitUsd: '2,5',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.body).toEqual({
      settings: {
        workLogEditWindowHours: 24,
        timeZone: 'Europe/Istanbul',
        featureX: true,
        ai: {
          smartCaptureEnabled: false,
          dailySummaryEnabled: true,
          summaryTime: '17:30',
          summaryRecipientRoles: ['supervisor', 'admin'],
          dailyRequestLimit: 200,
          dailyCostLimitUsd: 2.5,
        },
      },
    });
    expect(updateOrganizationSchema.safeParse(result.body).success).toBe(true);
  });

  it('leaves an empty limit out, so the server ceiling applies', () => {
    const withLimits = {
      ...ORG,
      settings: { ...ORG.settings, ai: { dailyRequestLimit: 5, dailyCostLimitUsd: 1 } },
    };
    const form = {
      ...aiSettingsFormFrom(withLimits),
      dailyRequestLimit: '',
      dailyCostLimitUsd: '',
    };
    const result = aiSettingsUpdateBody(withLimits, form);
    expect(result.ok && result.body.settings.ai).not.toHaveProperty('dailyRequestLimit');
    expect(result.ok && result.body.settings.ai).not.toHaveProperty('dailyCostLimitUsd');
  });

  it('refuses a bad time and bad limits', () => {
    const result = aiSettingsUpdateBody(ORG, {
      ...aiSettingsFormFrom(ORG),
      summaryTime: '24:00',
      dailyRequestLimit: '1.5',
      dailyCostLimitUsd: '-1',
    });
    expect(result).toEqual({
      ok: false,
      errors: { summaryTime: 'time', dailyRequestLimit: 'wholeNumber', dailyCostLimitUsd: 'range' },
    });
    expect(
      aiSettingsUpdateBody(ORG, { ...aiSettingsFormFrom(ORG), dailyRequestLimit: 'abc' }),
    ).toMatchObject({ ok: false, errors: { dailyRequestLimit: 'number' } });
  });

  it('toggles recipient roles in canonical order', () => {
    expect(toggleRecipientRole(['manager'], 'supervisor', true)).toEqual(['supervisor', 'manager']);
    expect(toggleRecipientRole(['supervisor', 'manager'], 'supervisor', false)).toEqual([
      'manager',
    ]);
  });
});

describe('who reaches the AI pages (UX mirror of the policies)', () => {
  it('summaries for supervisors and above, usage for admins; workers never', () => {
    expect(routeAccess('/summaries', capabilitiesFor(['supervisor']))).toBe('allowed');
    expect(routeAccess('/ai-usage', capabilitiesFor(['manager']))).toBe('not-for-role');
    expect(routeAccess('/ai-usage', capabilitiesFor(['admin']))).toBe('allowed');
    expect(routeAccess('/summaries', capabilitiesFor(['worker']))).toBe('worker');
  });
});

describe('rendering', () => {
  const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
    renderToStaticMarkup(element);

  it('shows the narrative as plain text, labelled AI-written, with numbers and reasons', () => {
    const html = render(
      createElement(SummaryView, {
        summary: SUMMARY,
        names,
        formatDay: (day) => day,
        formatTime: (value) => value,
      }),
    );
    expect(html).toContain('AI-written');
    // Escaped, never interpreted.
    expect(html).toContain('&lt;b&gt;Harbour Project&lt;/b&gt;');
    expect(html).not.toContain('<b>Harbour');
    expect(html).toContain('Ayla Kaya: 4 rejected logs in the last 7 days.');
    expect(html).toContain('High');
    expect(html).toContain(`/tasks/${ID(5)}`);
  });

  it('labels a template narrative as written by the system', () => {
    const html = render(
      createElement(SummaryView, {
        summary: { ...SUMMARY, narrativeSource: 'template', anomalies: [] },
        names,
        formatDay: (day) => day,
        formatTime: (value) => value,
      }),
    );
    expect(html).toContain('Written by the system');
    expect(html).not.toContain('AI-written');
    expect(html).toContain('Nothing unusual was flagged.');
  });

  it('an empty flag list says so', () => {
    expect(
      render(createElement(AnomalyTable, { flags: [], names, formatDay: (d) => d })),
    ).toContain('No unusual items in these days.');
  });

  it('renders the usage report with the limits and a test-provider note', () => {
    const report: AiUsageReport = {
      generatedAt: '2026-10-20T15:00:00.000Z',
      from: '2026-10-01',
      to: '2026-10-20',
      rows: [
        {
          day: '2026-10-20',
          feature: 'summary_narrative',
          provider: 'fake',
          model: 'fake-llm-1',
          requests: 3,
          ok: 2,
          invalidOutput: 1,
          failed: 0,
          timeout: 0,
          limited: 0,
          inputTokens: 900,
          outputTokens: 30,
          audioSeconds: 0,
          costUsd: 0.0093,
        },
      ],
      totals: {
        requests: 3,
        ok: 2,
        invalidOutput: 1,
        failed: 0,
        timeout: 0,
        limited: 0,
        inputTokens: 900,
        outputTokens: 30,
        audioSeconds: 0,
        costUsd: 0.0093,
      },
      today: { day: '2026-10-20', requests: 3, costUsd: 0.0093 },
      limits: {
        dailyRequestLimit: 500,
        dailyCostLimitUsd: 10,
        envDailyRequestLimit: 500,
        envDailyCostLimitUsd: 10,
        rateLimitPerUserPerMinute: 6,
      },
      providers: {
        llm: { name: 'fake', model: 'fake-llm-1' },
        speechToText: { name: 'openai', model: 'gpt-4o-transcribe' },
      },
    };
    const html = render(createElement(AiUsageReportView, { report, formatTime: (v) => v }));
    expect(html).toContain('3 of 500 requests');
    expect(html).toContain('Test provider (no API key set)');
    expect(html).toContain('openai · gpt-4o-transcribe');
    expect(html).toContain('Summary text');
  });
});
