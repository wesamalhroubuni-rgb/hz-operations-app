import type { NotificationsRepository } from '../data/repositories';
import {
  createPushService,
  PUSH_REREGISTER_AFTER_MS,
  shouldReregisterPush,
  type PushDevice,
} from './pushService';
import { pushAvailability, resolveProjectId } from './pushSupport';

describe('pushAvailability', () => {
  const phone = { platform: 'android', isDevice: true, inExpoGo: false, projectId: 'abc' };

  it('is available on a real phone in a development or release build with a project id', () => {
    expect(pushAvailability(phone)).toEqual({ available: true, projectId: 'abc' });
    expect(pushAvailability({ ...phone, platform: 'ios' })).toEqual({
      available: true,
      projectId: 'abc',
    });
  });

  it('is not available in Expo Go on Android (removed in SDK 53), but is on iOS', () => {
    expect(pushAvailability({ ...phone, inExpoGo: true })).toEqual({
      available: false,
      reason: 'expoGo',
    });
    expect(pushAvailability({ ...phone, platform: 'ios', inExpoGo: true }).available).toBe(true);
  });

  it('needs a real device and a project id', () => {
    expect(pushAvailability({ ...phone, isDevice: false })).toEqual({
      available: false,
      reason: 'simulator',
    });
    expect(pushAvailability({ ...phone, projectId: ' ' })).toEqual({
      available: false,
      reason: 'noProjectId',
    });
    expect(pushAvailability({ ...phone, platform: 'web' })).toEqual({
      available: false,
      reason: 'simulator',
    });
  });

  it('takes the first project id that is set', () => {
    expect(resolveProjectId(null, '', ' id-2 ', 'id-3')).toBe('id-2');
    expect(resolveProjectId(undefined)).toBeNull();
  });
});

const TOKEN = 'ExponentPushToken[abc123]';

function device(overrides: Partial<PushDevice> = {}): PushDevice {
  return {
    platform: 'android',
    availability: () => ({ available: true, projectId: 'project' }),
    ensurePermission: async () => true,
    prepare: async () => undefined,
    getExpoPushToken: async () => TOKEN,
    ...overrides,
  };
}

function repository(overrides: Partial<NotificationsRepository> = {}) {
  return {
    markRead: jest.fn(),
    markAllRead: jest.fn(),
    registerPushToken: jest.fn(async () => ({ ok: true as const, data: undefined })),
    unregisterPushToken: jest.fn(async () => ({ ok: true as const, data: undefined })),
    ...overrides,
  } satisfies NotificationsRepository;
}

describe('push service', () => {
  it('registers the token with the platform after sign-in', async () => {
    const repo = repository();
    const service = createPushService(device(), repo);
    await expect(service.register()).resolves.toEqual({ status: 'on', token: TOKEN });
    expect(repo.registerPushToken).toHaveBeenCalledWith({ token: TOKEN, platform: 'android' });
  });

  it('registers once when asked twice at the same time', async () => {
    const repo = repository();
    const service = createPushService(device(), repo);
    await Promise.all([service.register(), service.register()]);
    expect(repo.registerPushToken).toHaveBeenCalledTimes(1);
  });

  it('stops without asking for a token when push is unavailable or refused', async () => {
    const getExpoPushToken = jest.fn(async () => TOKEN);
    const unavailable = createPushService(
      device({ availability: () => ({ available: false, reason: 'expoGo' }), getExpoPushToken }),
      repository(),
    );
    await expect(unavailable.register()).resolves.toEqual({
      status: 'unavailable',
      reason: 'expoGo',
    });
    const denied = createPushService(
      device({ ensurePermission: async () => false, getExpoPushToken }),
      repository(),
    );
    await expect(denied.register()).resolves.toEqual({ status: 'denied' });
    expect(getExpoPushToken).not.toHaveBeenCalled();
  });

  it('reports a failure without throwing', async () => {
    const service = createPushService(
      device({ getExpoPushToken: async () => Promise.reject(new Error('no network')) }),
      repository(),
    );
    await expect(service.register()).resolves.toEqual({ status: 'failed' });
    const refused = createPushService(
      device(),
      repository({
        registerPushToken: jest.fn(async () => ({
          ok: false as const,
          error: { kind: 'invalid' as const, message: '', details: [] },
        })),
      }),
    );
    await expect(refused.register()).resolves.toEqual({ status: 'failed' });
  });

  it('unregisters the token at sign-out, and only when one was registered', async () => {
    const repo = repository();
    const service = createPushService(device(), repo);
    await service.unregister();
    expect(repo.unregisterPushToken).not.toHaveBeenCalled();
    await service.register();
    await service.unregister();
    expect(repo.unregisterPushToken).toHaveBeenCalledWith(TOKEN);
    expect(service.getState()).toEqual({ status: 'idle' });
  });

  it('does not hold sign-out up when the server does not answer', async () => {
    const repo = repository({
      unregisterPushToken: jest.fn(() => new Promise<never>(() => undefined)),
    });
    const service = createPushService(device(), repo);
    await service.register();
    await expect(service.unregister(10)).resolves.toBeUndefined();
  });

  it('registers again on returning to the foreground only more than 24 h after the last attempt', async () => {
    const repo = repository();
    const clock = { now: 1_000_000 };
    const service = createPushService(device(), repo, () => clock.now);
    // Cold start with a live session: the provider registers.
    await service.register();
    expect(repo.registerPushToken).toHaveBeenCalledTimes(1);
    clock.now += PUSH_REREGISTER_AFTER_MS - 1;
    expect(service.refreshIfStale()).toBeNull();
    clock.now += 1;
    await expect(service.refreshIfStale()).resolves.toEqual({ status: 'on', token: TOKEN });
    expect(repo.registerPushToken).toHaveBeenCalledTimes(2);
    expect(service.refreshIfStale()).toBeNull();
  });
});

describe('shouldReregisterPush', () => {
  const on = { status: 'on', token: 'x' } as const;

  it('registers when never tried, or the last attempt is a day old; never while one is running', () => {
    expect(shouldReregisterPush({ state: { status: 'idle' }, lastAttemptAt: null, now: 0 })).toBe(
      true,
    );
    expect(
      shouldReregisterPush({ state: on, lastAttemptAt: 0, now: PUSH_REREGISTER_AFTER_MS - 1 }),
    ).toBe(false);
    expect(
      shouldReregisterPush({ state: on, lastAttemptAt: 0, now: PUSH_REREGISTER_AFTER_MS }),
    ).toBe(true);
    expect(
      shouldReregisterPush({
        state: { status: 'failed' },
        lastAttemptAt: 0,
        now: PUSH_REREGISTER_AFTER_MS,
      }),
    ).toBe(true);
    expect(
      shouldReregisterPush({ state: { status: 'pending' }, lastAttemptAt: null, now: 0 }),
    ).toBe(false);
    expect(PUSH_REREGISTER_AFTER_MS).toBe(24 * 60 * 60 * 1000);
  });
});
