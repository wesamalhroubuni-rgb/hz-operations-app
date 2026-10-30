import { renderNotification } from '../notifications/notification-messages';
import { POLICIES } from '../access/policies';
import { canUpdateUser } from '../access/rules/user.rules';
import { contextFor, orgWideContextFor } from '../access/testing';
import { historyChanges, isOfflineChange } from '../history/record-history.service';
import { daysOfRange } from '../reports/reports.service';
import { excerptOf } from '../work-logs/work-log-query';
import { placeActivity } from './dashboard.service';

// Pure pieces of the Phase 6 API additions (ADR-0009).

describe('Phase 6 policies', () => {
  it.each([
    'dashboard.read',
    'directory.read',
    'work_log.review',
    'export.work_logs',
    'export.tasks',
    'report.read',
  ] as const)('%s is for supervisors, managers and admins only', (name) => {
    expect([...POLICIES[name].roles].sort()).toEqual(['admin', 'manager', 'supervisor']);
  });
});

describe('a user changing themselves', () => {
  const worker = contextFor('worker', ['worker']);
  it('may change their own locale and name, nothing else, and nobody else', () => {
    expect(canUpdateUser(worker, 'worker', ['locale']).allowed).toBe(true);
    expect(canUpdateUser(worker, 'worker', ['displayName', 'locale']).allowed).toBe(true);
    expect(canUpdateUser(worker, 'worker', ['locale', 'email']).allowed).toBe(false);
    expect(canUpdateUser(worker, 'other', ['locale']).allowed).toBe(false);
    expect(canUpdateUser(orgWideContextFor('root', 'admin'), 'other', ['locale']).allowed).toBe(
      true,
    );
  });
});

describe('notifications in the recipient locale', () => {
  it('falls back to English for Turkish, Arabic, regional tags and unknown locales', () => {
    const english = renderNotification('work_log.rejected', { note: 'Blurry' }, 'en');
    for (const locale of ['tr', 'ar', 'tr-TR', 'xx', '']) {
      expect(renderNotification('work_log.rejected', { note: 'Blurry' }, locale)).toEqual(english);
    }
  });

  it('keeps the push text generic in every locale', () => {
    for (const locale of ['en', 'tr', 'ar']) {
      const message = renderNotification('task.assigned', { taskTitle: 'Secret pump' }, locale);
      expect(message.title).toContain('Secret pump');
      expect(JSON.stringify(message.push)).not.toContain('Secret pump');
    }
  });
});

describe('record history shaping', () => {
  it('keeps only the allowed fields of a stored diff', () => {
    const stored = {
      status: { from: 'submitted', to: 'approved' },
      version: { from: 1, to: 2 },
      organizationId: { from: 'a', to: 'b' },
      clientId: { from: 'x', to: 'y' },
    };
    expect(historyChanges(stored, ['status', 'review'])).toEqual({
      status: { from: 'submitted', to: 'approved' },
    });
    expect(historyChanges({ version: { from: 1, to: 2 } }, ['status'])).toBeNull();
    expect(historyChanges(null, ['status'])).toBeNull();
    expect(historyChanges([1], ['status'])).toBeNull();
  });

  it('reports only the offline flag of the metadata', () => {
    expect(isOfflineChange({ via: 'offline_sync', deviceTime: 'x' })).toBe(true);
    expect(isOfflineChange({ droppedReferences: ['taskId'] })).toBe(false);
    expect(isOfflineChange(null)).toBe(false);
  });
});

describe('dashboard place rows', () => {
  it('merges log and task counts, keeps the no-place row last among equals, and links filters', () => {
    const rows = placeActivity(
      {
        logs: new Map<string | null, number>([
          ['s1', 3],
          [null, 1],
          ['s2', 1],
        ]),
        tasks: new Map<string | null, number>([
          ['s3', 2],
          ['s2', 0],
        ]),
      },
      new Map([
        ['s1', 'North'],
        ['s2', 'South'],
      ]),
      'siteId',
      { occurredFrom: 'F', occurredTo: 'T' },
    );
    expect(rows.map((row) => [row.id, row.name, row.logsToday, row.tasksOpen])).toEqual([
      ['s1', 'North', 3, 0],
      ['s2', 'South', 1, 0],
      [null, null, 1, 0],
      ['s3', null, 0, 2],
    ]);
    expect(rows[0]!.logsFilter).toEqual({ siteId: 's1', occurredFrom: 'F', occurredTo: 'T' });
    expect(rows[0]!.tasksFilter).toEqual({ siteId: 's1', open: 'true' });
    expect(rows[2]!.logsFilter).toEqual({ occurredFrom: 'F', occurredTo: 'T' });
  });
});

describe('report days and excerpts', () => {
  it('lists every local day of an exclusive range, across a DST change', () => {
    // Berlin, 2026-10-24 00:00 to 2026-10-27 00:00 local (clocks go back on 2026-10-25).
    const days = daysOfRange(
      new Date('2026-10-23T22:00:00.000Z'),
      new Date('2026-10-26T23:00:00.000Z'),
      'Europe/Berlin',
    );
    expect(days).toEqual(['2026-10-24', '2026-10-25', '2026-10-26']);
  });

  it('cuts text to the length with an ellipsis and flattens whitespace', () => {
    expect(excerptOf(null, 10)).toBeNull();
    expect(excerptOf('   ', 10)).toBeNull();
    expect(excerptOf('a\n b', 10)).toBe('a b');
    expect(excerptOf('abcdefghijkl', 5)).toBe('abcd…');
  });
});
