import { describe, expect, it } from 'vitest';

import {
  addDays,
  DEFAULT_TIME_ZONE,
  dayKeySchema,
  formatDayKey,
  formatInTimeZone,
  formatSortableInTimeZone,
  isValidTimeZone,
  timeZoneOf,
  timeZoneOffsetMs,
  timeZoneSchema,
  zonedDayKey,
  zonedDayStart,
  zonedDaysRange,
  zonedParts,
  zonedTimeToInstant,
} from './time-zone.js';

const HOUR = 60 * 60 * 1000;

describe('time zone validation', () => {
  it('accepts IANA names and refuses anything else', () => {
    expect(isValidTimeZone('Europe/Istanbul')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Asia/Riyadh')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone('x'.repeat(65))).toBe(false);
    expect(timeZoneSchema.safeParse('Europe/Berlin').success).toBe(true);
    expect(timeZoneSchema.safeParse('Not/AZone').success).toBe(false);
  });

  it('reads the setting, falling back to Europe/Istanbul', () => {
    expect(DEFAULT_TIME_ZONE).toBe('Europe/Istanbul');
    expect(timeZoneOf({ timeZone: 'Europe/Berlin' })).toBe('Europe/Berlin');
    expect(timeZoneOf({ timeZone: 'nonsense' })).toBe(DEFAULT_TIME_ZONE);
    expect(timeZoneOf({})).toBe(DEFAULT_TIME_ZONE);
    expect(timeZoneOf(null)).toBe(DEFAULT_TIME_ZONE);
  });

  it('checks day keys', () => {
    expect(dayKeySchema.safeParse('2026-10-28').success).toBe(true);
    expect(dayKeySchema.safeParse('2026-02-30').success).toBe(false);
    expect(dayKeySchema.safeParse('2026-10-28T00:00').success).toBe(false);
    expect(dayKeySchema.safeParse('28/10/2026').success).toBe(false);
  });
});

describe('wall clock in a zone', () => {
  it('reads Istanbul (UTC+3 all year)', () => {
    expect(zonedParts('2026-10-28T21:30:00Z', 'Europe/Istanbul')).toEqual({
      year: 2026,
      month: 10,
      day: 29,
      hour: 0,
      minute: 30,
      second: 0,
    });
    expect(timeZoneOffsetMs('2026-01-15T12:00:00Z', 'Europe/Istanbul')).toBe(3 * HOUR);
    expect(timeZoneOffsetMs('2026-07-15T12:00:00Z', 'Europe/Istanbul')).toBe(3 * HOUR);
  });

  it('follows daylight saving in Berlin', () => {
    expect(timeZoneOffsetMs('2026-01-15T12:00:00Z', 'Europe/Berlin')).toBe(1 * HOUR);
    expect(timeZoneOffsetMs('2026-07-15T12:00:00Z', 'Europe/Berlin')).toBe(2 * HOUR);
  });

  it('turns a wall time back into the instant, including around DST changes', () => {
    const wall = { year: 2026, month: 10, day: 28, hour: 14, minute: 5, second: 0 };
    expect(zonedTimeToInstant(wall, 'Europe/Istanbul').toISOString()).toBe(
      '2026-10-28T11:05:00.000Z',
    );
    // Berlin, 2026-10-25: 02:30 happens twice; the first one (CEST, +2) is chosen.
    expect(
      zonedTimeToInstant(
        { ...wall, month: 10, day: 25, hour: 2, minute: 30 },
        'Europe/Berlin',
      ).toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
    // Berlin, 2026-03-29: 02:30 does not exist; an instant after the gap is returned.
    const skipped = zonedTimeToInstant(
      { ...wall, month: 3, day: 29, hour: 2, minute: 30 },
      'Europe/Berlin',
    );
    expect(zonedParts(skipped, 'Europe/Berlin').hour).toBe(3);
  });
});

describe('days', () => {
  it('names the day of an instant in the zone, not in UTC', () => {
    // 22:30 UTC on the 28th is already the 29th in Istanbul.
    expect(zonedDayKey('2026-10-28T22:30:00Z', 'Europe/Istanbul')).toBe('2026-10-29');
    expect(zonedDayKey('2026-10-28T22:30:00Z', 'UTC')).toBe('2026-10-28');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('gives the local midnight of a day', () => {
    expect(zonedDayStart('2026-10-28', 'Europe/Istanbul').toISOString()).toBe(
      '2026-10-27T21:00:00.000Z',
    );
    expect(zonedDayStart('2026-10-28', 'UTC').toISOString()).toBe('2026-10-28T00:00:00.000Z');
  });

  it('builds the inclusive-lower, exclusive-upper range of whole days', () => {
    expect(zonedDaysRange('2026-10-28', '2026-10-28', 'Europe/Istanbul')).toEqual({
      from: '2026-10-27T21:00:00.000Z',
      to: '2026-10-28T21:00:00.000Z',
    });
    // The Berlin fall-back day has 25 hours.
    const range = zonedDaysRange('2026-10-25', '2026-10-25', 'Europe/Berlin');
    expect(Date.parse(range.to) - Date.parse(range.from)).toBe(25 * HOUR);
  });
});

describe('formatting', () => {
  it('writes the time in the organization zone, whatever the viewer zone', () => {
    const text = formatInTimeZone('2026-10-28T11:05:00Z', {
      timeZone: 'Europe/Istanbul',
      locale: 'en-GB',
      style: 'time',
    });
    expect(text).toBe('14:05');
    expect(
      formatInTimeZone('2026-10-28T11:05:00Z', {
        timeZone: 'Europe/Istanbul',
        locale: 'en-GB',
        style: 'date',
      }),
    ).toBe('28 Oct 2026');
  });

  it('never throws', () => {
    expect(formatInTimeZone(null, { timeZone: 'UTC' })).toBe('');
    expect(formatInTimeZone('not a date', { timeZone: 'UTC' })).toBe('');
    expect(
      formatInTimeZone('2026-10-28T11:05:00Z', { timeZone: 'UTC', locale: '!!', style: 'time' }),
    ).not.toBe('');
  });

  it('writes the sortable export form', () => {
    expect(formatSortableInTimeZone('2026-10-28T22:30:00Z', 'Europe/Istanbul')).toBe(
      '2026-10-29 01:30',
    );
    expect(formatSortableInTimeZone(null, 'UTC')).toBe('');
  });

  it('writes a day key without shifting it', () => {
    expect(formatDayKey('2026-10-28', 'en-GB')).toBe('28 Oct 2026');
  });
});

describe('day boundaries hold in every kind of zone, every day of the year', () => {
  const ZONES = [
    'UTC',
    'Europe/Istanbul', // +3, no DST
    'Europe/Berlin', // +1/+2
    'America/New_York', // -5/-4
    'America/Santiago', // DST starts at midnight: 00:00 is skipped on that day
    'Asia/Kolkata', // +5:30
    'America/St_Johns', // -3:30/-2:30
    'Pacific/Chatham', // +12:45/+13:45
    'Asia/Riyadh', // +3
  ];
  const DAYS = Array.from({ length: 366 }, (_, i) => addDays('2026-01-01', i));

  it.each(ZONES)(
    '%s: each day starts at its first instant and the ranges tile the year',
    (zone) => {
      for (const day of DAYS) {
        const start = zonedDayStart(day, zone);
        expect([day, zonedDayKey(start, zone)]).toEqual([day, day]);
        expect([day, zonedDayKey(start.getTime() - 1, zone)]).toEqual([day, addDays(day, -1)]);
        const range = zonedDaysRange(day, day, zone);
        const hours = (Date.parse(range.to) - Date.parse(range.from)) / HOUR;
        expect([day, [23, 24, 25].includes(hours)]).toEqual([day, true]);
        // The next day's range begins exactly where this one ends.
        expect(zonedDaysRange(addDays(day, 1), addDays(day, 1), zone).from).toBe(range.to);
      }
      const year = zonedDaysRange('2026-01-01', '2026-12-31', zone);
      expect(Date.parse(year.to) - Date.parse(year.from)).toBe(365 * 24 * HOUR);
    },
  );

  it('starts a day whose midnight is skipped at the first instant that exists (Santiago)', () => {
    // 2026-09-06: clocks jump from 00:00 (-04) to 01:00 (-03).
    const start = zonedDayStart('2026-09-06', 'America/Santiago');
    expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(zonedParts(start, 'America/Santiago')).toMatchObject({ day: 6, hour: 1, minute: 0 });
  });

  it('cuts days at half- and quarter-hour offsets', () => {
    expect(zonedDayStart('2026-10-28', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-27T18:30:00.000Z',
    );
    expect(zonedDayKey('2026-10-27T18:29:59.999Z', 'Asia/Kolkata')).toBe('2026-10-27');
    expect(zonedDayKey('2026-10-27T18:30:00.000Z', 'Asia/Kolkata')).toBe('2026-10-28');
    expect(zonedDayStart('2026-06-01', 'Pacific/Chatham').toISOString()).toBe(
      '2026-05-31T11:15:00.000Z',
    );
  });

  it('formats the repeated Berlin hour twice with the same wall time, sortable form included', () => {
    const first = '2026-10-25T00:30:00Z';
    const second = '2026-10-25T01:30:00Z';
    expect(formatSortableInTimeZone(first, 'Europe/Berlin')).toBe('2026-10-25 02:30');
    expect(formatSortableInTimeZone(second, 'Europe/Berlin')).toBe('2026-10-25 02:30');
    expect(
      formatInTimeZone(second, { timeZone: 'Europe/Berlin', locale: 'en-GB', style: 'time' }),
    ).toBe('02:30');
  });
});
