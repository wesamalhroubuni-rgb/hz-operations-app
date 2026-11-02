import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { AccessClock } from '../../access';
import type { SummariesService } from './summaries.service';
import { SUMMARY_RETRY_BACKOFF_MS, SummaryScheduler } from './summary-scheduler';

// 18:05 in Istanbul (UTC+3) on 2026-10-20: the summaries of that day are due.
const DUE = new Date('2026-10-20T15:05:00.000Z');
const MINUTE = 60_000;

function scheduler(generateForDay: jest.Mock) {
  const prisma = {
    organization: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'org-1',
          settings: {
            timeZone: 'Europe/Istanbul',
            ai: { dailySummaryEnabled: true, summaryTime: '18:00' },
          },
        },
      ]),
    },
  };
  const config = { get: () => undefined };
  const clock = { now: () => DUE };
  return new SummaryScheduler(
    config as unknown as ConfigService,
    prisma as unknown as PrismaService,
    { generateForDay } as unknown as SummariesService,
    clock as unknown as AccessClock,
  );
}

describe('SummaryScheduler back-off', () => {
  it('waits 15 minutes before retrying an (organization, day) whose pass failed', async () => {
    expect(SUMMARY_RETRY_BACKOFF_MS).toBe(15 * MINUTE);
    const generateForDay = jest.fn().mockRejectedValue(new Error('database down'));
    const subject = scheduler(generateForDay);

    expect(await subject.runOnce(DUE)).toEqual({ organizations: 1, generated: 0, failed: 1 });
    // The next wake-ups inside the back-off leave it alone.
    expect(await subject.runOnce(new Date(DUE.getTime() + MINUTE))).toEqual({
      organizations: 0,
      generated: 0,
      failed: 0,
    });
    expect(await subject.runOnce(new Date(DUE.getTime() + 14 * MINUTE))).toMatchObject({
      organizations: 0,
    });
    expect(generateForDay).toHaveBeenCalledTimes(1);

    // After 15 minutes it is tried again; a success clears the back-off.
    generateForDay.mockResolvedValue({ generated: 2, failed: 0, skipped: 0 });
    expect(await subject.runOnce(new Date(DUE.getTime() + 15 * MINUTE))).toMatchObject({
      organizations: 1,
      generated: 2,
    });
    expect(await subject.runOnce(new Date(DUE.getTime() + 16 * MINUTE))).toMatchObject({
      organizations: 1,
    });
    expect(generateForDay).toHaveBeenCalledTimes(3);
  });

  it('also backs off when some recipients could not be written', async () => {
    const generateForDay = jest.fn().mockResolvedValue({ generated: 1, failed: 1, skipped: 0 });
    const subject = scheduler(generateForDay);
    expect(await subject.runOnce(DUE)).toMatchObject({ organizations: 1, failed: 1 });
    expect(await subject.runOnce(new Date(DUE.getTime() + 5 * MINUTE))).toMatchObject({
      organizations: 0,
    });
    expect(generateForDay).toHaveBeenCalledTimes(1);
  });
});
