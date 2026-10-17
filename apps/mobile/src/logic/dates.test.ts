import {
  addLocalDays,
  fromIsoDate,
  isSameLocalDay,
  localDaysBetween,
  parseIso,
  startOfLocalDay,
  toIsoDate,
} from './dates';

describe('dates', () => {
  it('converts a custom date field value both ways in local time', () => {
    const date = fromIsoDate('2026-02-28');
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(1);
    expect(date?.getDate()).toBe(28);
    expect(toIsoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('refuses dates that do not exist', () => {
    expect(fromIsoDate('2026-02-30')).toBeNull();
    expect(fromIsoDate('2026-2-3')).toBeNull();
    expect(fromIsoDate('')).toBeNull();
  });

  it('works with local days', () => {
    const now = new Date(2026, 9, 16, 15, 30);
    expect(startOfLocalDay(now).getHours()).toBe(0);
    expect(isSameLocalDay(now, new Date(2026, 9, 16, 0, 1))).toBe(true);
    expect(isSameLocalDay(now, addLocalDays(now, 1))).toBe(false);
    expect(localDaysBetween(now, new Date(2026, 9, 18, 1, 0))).toBe(2);
  });

  it('parses API datetimes and tolerates null or garbage', () => {
    expect(parseIso('2026-10-16T10:00:00Z')?.toISOString()).toBe('2026-10-16T10:00:00.000Z');
    expect(parseIso(null)).toBeNull();
    expect(parseIso('soon')).toBeNull();
  });
});
