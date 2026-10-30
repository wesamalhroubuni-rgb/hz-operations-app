import { describe, expect, it } from 'vitest';

import { IDS, makeUserFull } from './__fixtures__/agent-c-fixtures';
import { editableUserFields, updateUserBody, userActions, userFormFrom } from './people';
import { capabilitiesFor } from './permissions';
import { createOrgTime, daysOfRange, presetDays } from './time';

// Test-writer pass on the Phase 6 web rules (UX only; the API is the authority, ADR-0005):
// sessions and other people's locales are admin-only in the UI too, and days, "today" and
// ranges follow the organization's zone across daylight-saving changes and odd offsets.

const HOUR = 3_600_000;
const admin = capabilitiesFor(['admin']);
const manager = capabilitiesFor(['manager']);
const supervisor = capabilitiesFor(['supervisor']);
const worker = capabilitiesFor(['worker']);

describe('sessions and locales in the people screen', () => {
  it('offers the sessions panel to admins only, even when a full profile is on screen', () => {
    const user = makeUserFull();
    expect(userActions(admin, user, false).sessions).toBe(true);
    for (const capabilities of [manager, supervisor, worker]) {
      expect(userActions(capabilities, user, false).sessions).toBe(false);
      expect(userActions(capabilities, makeUserFull({ id: IDS.me }), true).sessions).toBe(false);
    }
  });

  it('lets a non-admin change their own language but never anyone else’s', () => {
    const other = makeUserFull({ locale: 'en' });
    const form = { ...userFormFrom(other), locale: 'tr' as const };
    expect(updateUserBody(other, form, editableUserFields(manager, false))).toEqual({
      ok: true,
      body: null,
    });
    const self = makeUserFull({ id: IDS.me, locale: 'en' });
    expect(updateUserBody(self, { ...form }, editableUserFields(supervisor, true))).toEqual({
      ok: true,
      body: { locale: 'tr' },
    });
    expect(updateUserBody(other, form, editableUserFields(admin, false))).toEqual({
      ok: true,
      body: { locale: 'tr' },
    });
  });

  it('never sends an identifier a non-admin changed in their own form', () => {
    const self = makeUserFull({ id: IDS.me });
    const form = {
      ...userFormFrom(self),
      email: 'new@example.test',
      username: 'renamed',
      displayName: 'New Name',
    };
    const result = updateUserBody(self, form, editableUserFields(worker, true));
    expect(result).toEqual({ ok: true, body: { displayName: 'New Name' } });
  });
});

describe('organization days across daylight saving and odd offsets', () => {
  it('Berlin: "today" switches at local midnight, and the fall-back day has 25 hours', () => {
    const berlin = createOrgTime('Europe/Berlin', 'en-GB');
    expect(berlin.today(new Date('2026-10-25T22:59:00Z'))).toBe('2026-10-25');
    expect(berlin.today(new Date('2026-10-25T23:00:00Z'))).toBe('2026-10-26');
    const day = berlin.range('2026-10-25', '2026-10-25');
    expect(Date.parse(day.to) - Date.parse(day.from)).toBe(25 * HOUR);
    const spring = berlin.range('2026-03-29', '2026-03-29');
    expect(Date.parse(spring.to) - Date.parse(spring.from)).toBe(23 * HOUR);
    // The repeated 02:30 is shown twice, the instants stay apart.
    expect(berlin.time('2026-10-25T00:30:00Z')).toBe('02:30');
    expect(berlin.time('2026-10-25T01:30:00Z')).toBe('02:30');
  });

  it.each(['Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'America/Santiago', 'UTC'])(
    '%s: a picked range of days survives the round trip through the URL',
    (zone) => {
      const time = createOrgTime(zone, 'en-GB');
      for (const [from, to] of [
        ['2026-03-01', '2026-03-31'],
        ['2026-09-05', '2026-09-07'],
        ['2026-10-24', '2026-10-26'],
        ['2026-11-01', '2026-11-01'],
        ['2026-12-31', '2027-01-01'],
      ] as const) {
        const range = time.range(from, to);
        expect([zone, daysOfRange(range, zone)]).toEqual([zone, { from, to }]);
      }
    },
  );

  it('the same instant is a different day for differently placed organizations', () => {
    const instant = new Date('2026-10-28T20:30:00Z');
    expect(createOrgTime('Europe/Istanbul').today(instant)).toBe('2026-10-28');
    expect(createOrgTime('Asia/Kolkata').today(instant)).toBe('2026-10-29');
    expect(createOrgTime('America/New_York').today(instant)).toBe('2026-10-28');
    expect(createOrgTime('Pacific/Kiritimati').today(instant)).toBe('2026-10-29');
  });

  it('presets cross month and year ends in the organization’s calendar', () => {
    expect(presetDays('yesterday', '2027-01-01')).toEqual({ from: '2026-12-31', to: '2026-12-31' });
    expect(presetDays('last7Days', '2026-03-03')).toEqual({ from: '2026-02-25', to: '2026-03-03' });
    expect(presetDays('last30Days', '2028-03-01')).toEqual({
      from: '2028-02-01', // 2028 is a leap year: 29 days back from 1 March is 1 February
      to: '2028-03-01',
    });
    expect(presetDays('thisMonth', '2026-11-01')).toEqual({ from: '2026-11-01', to: '2026-11-01' });
  });
});
