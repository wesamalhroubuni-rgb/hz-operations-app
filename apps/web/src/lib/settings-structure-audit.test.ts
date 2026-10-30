import type { AuditEvent, OrganizationFull, Site } from '@ops/shared';
import { describe, expect, it } from 'vitest';

import { IDS } from './__fixtures__/agent-c-fixtures';
import { auditDiffRows, offlineSyncOf } from './audit';
import {
  EDITED_SETTING_KEYS,
  organizationUpdateBody,
  settingsFormFrom,
  timeZoneOptions,
} from './settings';
import {
  descendantIds,
  fetchAllPages,
  flattenTree,
  parentOptions,
  updateSiteBody,
  siteFormFrom,
} from './structure';

const ORG: OrganizationFull = {
  view: 'full',
  id: IDS.org,
  name: 'HZ Demo',
  slug: 'hz-demo',
  workLogEditWindowHours: 24,
  offlineMaxBackdateDays: 7,
  timeZone: 'Europe/Istanbul',
  settings: { workLogEditWindowHours: 24, featureX: true },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
};

describe('settings: PATCH replaces the whole settings object', () => {
  it('always sends every edited key and keeps other stored keys', () => {
    const result = organizationUpdateBody(ORG, {
      ...settingsFormFrom(ORG),
      timeZone: 'Europe/Berlin',
    });
    expect(result).toEqual({
      ok: true,
      body: {
        name: 'HZ Demo',
        settings: {
          featureX: true,
          workLogEditWindowHours: 24,
          offlineMaxBackdateDays: 7,
          timeZone: 'Europe/Berlin',
        },
      },
    });
    if (result.ok) {
      for (const key of EDITED_SETTING_KEYS) expect(result.body.settings).toHaveProperty(key);
    }
  });

  it('sends defaults in force even when the stored settings lack them', () => {
    const bare = { ...ORG, settings: {} };
    const result = organizationUpdateBody(bare, settingsFormFrom(bare));
    expect(result.ok && Object.keys(result.body.settings).sort()).toEqual(
      [...EDITED_SETTING_KEYS].sort(),
    );
  });

  it('validates every field', () => {
    const result = organizationUpdateBody(ORG, {
      name: ' ',
      timeZone: 'Mars/Base',
      workLogEditWindowHours: '0',
      offlineMaxBackdateDays: '2.5',
    });
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'required',
        timeZone: 'timeZone',
        workLogEditWindowHours: 'range',
        offlineMaxBackdateDays: 'wholeNumber',
      },
    });
  });

  it('lists IANA zones including the current one', () => {
    const zones = timeZoneOptions('Europe/Istanbul');
    expect(zones).toContain('Europe/Istanbul');
    expect(zones).toContain('UTC');
    expect(new Set(zones).size).toBe(zones.length);
  });
});

const place = (
  id: string,
  name: string,
  parentId: string | null,
  archivedAt: string | null = null,
) => ({
  id,
  name,
  parentId,
  archivedAt,
});

describe('structure trees', () => {
  const items = [
    place('b', 'Beta', null),
    place('a', 'Alpha', null),
    place('a1', 'Alpha 1', 'a'),
    place('a11', 'Deep', 'a1'),
    place('o', 'Orphan', 'missing'),
  ];

  it('lists parents before children, siblings by name, orphans as roots', () => {
    expect(flattenTree(items).map((row) => `${row.depth}:${row.item.id}`)).toEqual([
      '0:a',
      '1:a1',
      '2:a11',
      '0:b',
      '0:o',
    ]);
  });

  it('never offers a place, or its descendants, as its own parent', () => {
    expect([...descendantIds(items, 'a')].sort()).toEqual(['a', 'a1', 'a11']);
    expect(parentOptions(items, 'a').map((option) => option.value)).toEqual(['b', 'o']);
  });

  it('survives a cycle in bad data', () => {
    const rows = flattenTree([place('x', 'X', 'y'), place('y', 'Y', 'x')]);
    expect(rows.map((row) => row.item.id).sort()).toEqual(['x', 'y']);
  });

  it('reads every page', async () => {
    const all = await fetchAllPages(async (page) => ({
      items: page < 3 ? [page] : [],
      total: 2,
      page,
      pageSize: 100,
    }));
    expect(all).toEqual({ items: [1, 2], total: 2, complete: true });
  });

  it('sends only changed site fields', () => {
    const site: Site = {
      id: IDS.site,
      organizationId: IDS.org,
      parentId: null,
      name: 'North',
      code: 'N-01',
      description: null,
      address: null,
      latitude: 41,
      longitude: 29,
      createdAt: ORG.createdAt,
      updatedAt: ORG.updatedAt,
      archivedAt: null,
    };
    expect(
      updateSiteBody(site, { ...siteFormFrom(site), latitude: '41,5', code: '' }, 'nan'),
    ).toEqual({
      ok: true,
      body: { code: null, latitude: 41.5 },
    });
    expect(updateSiteBody(site, { ...siteFormFrom(site), longitude: 'east' }, 'nan')).toEqual({
      ok: false,
      errors: { longitude: 'nan' },
    });
  });
});

describe('audit detail', () => {
  const event = {
    changes: {
      title: { from: 'A', to: 'B' },
      customFields: { from: { token_no: '[redacted]' }, to: { token_no: '[redacted]' } },
      dueAt: { from: null, to: '2026-10-30T10:00:00Z' },
    },
    metadata: {
      via: 'offline_sync',
      deviceTime: '2026-10-28T10:00:00.000Z',
      serverTime: '2026-10-28T10:05:00.000Z',
      clockSkewSeconds: 300,
    },
  } as unknown as AuditEvent;

  it('shows the redacted diff sorted by field and marks hidden values', () => {
    expect(auditDiffRows(event)).toEqual([
      {
        field: 'customFields',
        from: '{"token_no":"[redacted]"}',
        to: '{"token_no":"[redacted]"}',
        redacted: true,
      },
      { field: 'dueAt', from: '—', to: '2026-10-30T10:00:00Z', redacted: false },
      { field: 'title', from: 'A', to: 'B', redacted: false },
    ]);
    expect(auditDiffRows({ changes: null })).toEqual([]);
  });

  it('reads the offline-sync metadata', () => {
    expect(offlineSyncOf(event)).toMatchObject({ via: 'offline_sync', clockSkewSeconds: 300 });
    expect(offlineSyncOf({ metadata: null })).toBeNull();
  });
});
