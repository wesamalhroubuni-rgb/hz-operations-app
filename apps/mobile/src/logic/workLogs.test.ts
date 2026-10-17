import type { LogType, WorkLog } from '@ops/shared';

import {
  canEditWorkLog,
  canResubmitWorkLog,
  canSubmitDraft,
  defaultPlacement,
  editWindowEndsAt,
  orderLogTypesByUse,
} from './workLogs';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-16T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

function log(
  overrides: Partial<Pick<WorkLog, 'authorId' | 'status' | 'createdAt' | 'archivedAt'>> = {},
) {
  return {
    authorId: ME,
    status: 'submitted' as WorkLog['status'],
    createdAt: hoursAgo(1),
    archivedAt: null,
    ...overrides,
  };
}

describe('edit window (mirrors the API rule for the author)', () => {
  it('allows the author inside the window while not approved', () => {
    expect(canEditWorkLog(log(), ME, NOW, 24)).toBe(true);
    expect(canEditWorkLog(log({ status: 'rejected' }), ME, NOW, 24)).toBe(true);
    expect(canEditWorkLog(log({ status: 'draft' }), ME, NOW, 24)).toBe(true);
  });

  it('counts the edge of the window as inside and a millisecond later as outside', () => {
    const created = hoursAgo(24);
    expect(canEditWorkLog(log({ createdAt: created }), ME, NOW, 24)).toBe(true);
    const justOver = new Date(Date.parse(created) - 1).toISOString();
    expect(canEditWorkLog(log({ createdAt: justOver }), ME, NOW, 24)).toBe(false);
  });

  it('follows the organization window', () => {
    expect(canEditWorkLog(log({ createdAt: hoursAgo(30) }), ME, NOW, 24)).toBe(false);
    expect(canEditWorkLog(log({ createdAt: hoursAgo(30) }), ME, NOW, 48)).toBe(true);
  });

  it('refuses an approved or archived log, and anyone but the author', () => {
    expect(canEditWorkLog(log({ status: 'approved' }), ME, NOW, 24)).toBe(false);
    expect(canEditWorkLog(log({ archivedAt: hoursAgo(0) }), ME, NOW, 24)).toBe(false);
    expect(canEditWorkLog(log({ authorId: OTHER }), ME, NOW, 24)).toBe(false);
  });

  it('says when the window closes', () => {
    expect(editWindowEndsAt(log({ createdAt: '2026-10-16T00:00:00Z' }), 24)?.toISOString()).toBe(
      '2026-10-17T00:00:00.000Z',
    );
    expect(editWindowEndsAt({ createdAt: 'garbage' }, 24)).toBeNull();
  });

  it('offers resubmitting only for a rejected log still in the window', () => {
    expect(canResubmitWorkLog(log({ status: 'rejected' }), ME, NOW, 24)).toBe(true);
    expect(canResubmitWorkLog(log({ status: 'submitted' }), ME, NOW, 24)).toBe(false);
    expect(
      canResubmitWorkLog(log({ status: 'rejected', createdAt: hoursAgo(25) }), ME, NOW, 24),
    ).toBe(false);
    expect(canSubmitDraft(log({ status: 'draft' }), ME, NOW, 24)).toBe(true);
    expect(canSubmitDraft(log({ status: 'rejected' }), ME, NOW, 24)).toBe(false);
  });
});

function logType(id: string, name: string, archivedAt: string | null = null): LogType {
  return {
    id,
    organizationId: OTHER,
    key: name.toLowerCase(),
    name,
    description: null,
    fields: [],
    version: 1,
    createdAt: hoursAgo(100),
    updatedAt: hoursAgo(100),
    archivedAt,
  };
}

describe('orderLogTypesByUse', () => {
  const inspection = logType('a', 'Inspection');
  const delivery = logType('b', 'Delivery');
  const cleaning = logType('c', 'Cleaning');
  const old = logType('d', 'Old', hoursAgo(5));

  it('puts the most used first, then the rest by name, without archived types', () => {
    const recent = [
      { logTypeId: 'a' },
      { logTypeId: 'b' },
      { logTypeId: 'b' },
      { logTypeId: null },
      { logTypeId: 'd' },
    ];
    expect(
      orderLogTypesByUse([inspection, delivery, cleaning, old], recent).map((type) => type.name),
    ).toEqual(['Delivery', 'Inspection', 'Cleaning']);
  });

  it('sorts by name when nothing was logged yet', () => {
    expect(
      orderLogTypesByUse([inspection, delivery, cleaning], []).map((type) => type.name),
    ).toEqual(['Cleaning', 'Delivery', 'Inspection']);
  });
});

describe('defaultPlacement', () => {
  const sites = [
    { id: 's1', archivedAt: null },
    { id: 's2', archivedAt: null },
  ];
  const teams = [{ id: 't1', archivedAt: null }];

  it('takes site and team from the task', () => {
    expect(
      defaultPlacement({ task: { siteId: 's2', teamId: null }, memberOf: null, sites, teams }),
    ).toEqual({ siteId: 's2', teamId: null });
  });

  it("uses the worker's only site and only team", () => {
    expect(
      defaultPlacement({
        memberOf: { orgWide: false, siteIds: ['s1'], teamIds: ['t1'] },
        sites,
        teams,
      }),
    ).toEqual({ siteId: 's1', teamId: 't1' });
  });

  it('leaves the choice open when there are several, none, or the site is not pickable', () => {
    expect(
      defaultPlacement({
        memberOf: { orgWide: false, siteIds: ['s1', 's2'], teamIds: [] },
        sites,
        teams,
      }),
    ).toEqual({ siteId: null, teamId: null });
    expect(
      defaultPlacement({
        memberOf: { orgWide: false, siteIds: ['gone'], teamIds: ['t1'] },
        sites,
        teams,
      }),
    ).toEqual({ siteId: null, teamId: 't1' });
    expect(
      defaultPlacement({
        memberOf: { orgWide: true, siteIds: ['s1'], teamIds: ['t1'] },
        sites,
        teams,
      }),
    ).toEqual({ siteId: null, teamId: null });
  });
});
