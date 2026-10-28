import { runBackgroundSync, setBackgroundSyncRunner } from './background';

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(async () => false),
}));
jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  getStatusAsync: jest.fn(async () => 2),
  registerTaskAsync: jest.fn(async () => undefined),
  unregisterTaskAsync: jest.fn(async () => undefined),
}));

describe('background sync task', () => {
  afterEach(() => setBackgroundSyncRunner(null));

  it('does nothing (successfully) when no engine is open', async () => {
    await expect(runBackgroundSync()).resolves.toBe(1);
  });

  it('runs one background sync of the open engine', async () => {
    const runner = jest.fn(async () => ({
      sent: 1,
      failedRetryable: 0,
      failedPermanent: 0,
      pulled: true,
      stoppedBecause: null,
    }));
    setBackgroundSyncRunner(runner);
    await expect(runBackgroundSync()).resolves.toBe(1);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('reports a failure without throwing', async () => {
    setBackgroundSyncRunner(async () => {
      throw new Error('boom');
    });
    await expect(runBackgroundSync()).resolves.toBe(2);
  });
});
