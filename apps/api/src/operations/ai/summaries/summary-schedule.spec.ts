import { dueSummaryDay } from './summary-schedule';

describe('dueSummaryDay', () => {
  it('is due once the local time reaches the summary time (Istanbul, UTC+3)', () => {
    expect(dueSummaryDay(new Date('2026-10-20T14:59:00.000Z'), 'Europe/Istanbul', '18:00')).toBe(
      null,
    );
    expect(dueSummaryDay(new Date('2026-10-20T15:00:00.000Z'), 'Europe/Istanbul', '18:00')).toBe(
      '2026-10-20',
    );
  });

  it('catches up later the same local day, but never for a past day', () => {
    // 23:30 local on the 20th: still the 20th's run.
    expect(dueSummaryDay(new Date('2026-10-20T20:30:00.000Z'), 'Europe/Istanbul', '18:00')).toBe(
      '2026-10-20',
    );
    // 00:30 local on the 21st: the 20th is past and the 21st is not due yet.
    expect(dueSummaryDay(new Date('2026-10-20T21:30:00.000Z'), 'Europe/Istanbul', '18:00')).toBe(
      null,
    );
  });

  it('uses the local day, which may differ from the UTC day', () => {
    // 19:00 UTC on the 20th is 08:00 on the 21st in Auckland (UTC+13 in October).
    expect(dueSummaryDay(new Date('2026-10-20T19:00:00.000Z'), 'Pacific/Auckland', '07:30')).toBe(
      '2026-10-21',
    );
    // 18:00 on the 20th in Los Angeles (UTC-7) is 01:00 UTC on the 21st.
    expect(
      dueSummaryDay(new Date('2026-10-21T01:00:00.000Z'), 'America/Los_Angeles', '18:00'),
    ).toBe('2026-10-20');
  });

  it('handles daylight saving: a skipped time is due after the gap', () => {
    // Berlin springs forward on 2026-03-29 at 02:00 to 03:00; 02:30 does not exist.
    expect(dueSummaryDay(new Date('2026-03-29T00:59:00.000Z'), 'Europe/Berlin', '02:30')).toBe(
      null,
    );
    expect(dueSummaryDay(new Date('2026-03-29T01:00:00.000Z'), 'Europe/Berlin', '02:30')).toBe(
      '2026-03-29',
    );
  });

  it('handles daylight saving: a repeated time is due the first time', () => {
    // Berlin falls back on 2026-10-25 at 03:00 to 02:00; 02:30 happens twice.
    expect(dueSummaryDay(new Date('2026-10-25T00:29:00.000Z'), 'Europe/Berlin', '02:30')).toBe(
      null,
    );
    expect(dueSummaryDay(new Date('2026-10-25T00:30:00.000Z'), 'Europe/Berlin', '02:30')).toBe(
      '2026-10-25',
    );
    expect(dueSummaryDay(new Date('2026-10-25T01:30:00.000Z'), 'Europe/Berlin', '02:30')).toBe(
      '2026-10-25',
    );
  });

  it('midnight and the last minute of the day', () => {
    expect(dueSummaryDay(new Date('2026-10-20T00:00:00.000Z'), 'UTC', '00:00')).toBe('2026-10-20');
    expect(dueSummaryDay(new Date('2026-10-20T23:58:00.000Z'), 'UTC', '23:59')).toBe(null);
    expect(dueSummaryDay(new Date('2026-10-20T23:59:00.000Z'), 'UTC', '23:59')).toBe('2026-10-20');
  });
});
