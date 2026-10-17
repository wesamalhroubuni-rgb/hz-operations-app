import type { PushPlatform } from '@ops/shared';

import type { NotificationsRepository } from '../data/repositories';
import type { PushAvailability, PushUnavailableReason } from './pushSupport';

// Registers this phone for push notifications after sign-in and unregisters it at sign-out.
// The device side (permission, token) is injected, so the flow is unit-tested without Expo.

export type PushState =
  | { status: 'idle' }
  | { status: 'pending' }
  | { status: 'on'; token: string }
  | { status: 'denied' }
  | { status: 'unavailable'; reason: PushUnavailableReason }
  | { status: 'failed' };

export interface PushDevice {
  availability(): PushAvailability;
  /** 'granted' | 'denied' | 'undetermined', asking the person once when undetermined. */
  ensurePermission(): Promise<boolean>;
  /** Creates the Android channel; no-op elsewhere. */
  prepare(): Promise<void>;
  getExpoPushToken(projectId: string): Promise<string>;
  platform: PushPlatform;
}

/**
 * The server may move a push token to whoever registered it last (a phone that changed hands),
 * so the app registers its token again: on every cold start with a live session (the provider
 * mounts), and when it comes back to the foreground more than this long after the last attempt.
 */
export const PUSH_REREGISTER_AFTER_MS = 24 * 60 * 60 * 1000;

/** Whether the app should register its push token again now (pure; see the constant above). */
export function shouldReregisterPush(input: {
  state: PushState;
  lastAttemptAt: number | null;
  now: number;
}): boolean {
  if (input.state.status === 'pending') return false;
  if (input.lastAttemptAt === null) return true;
  return input.now - input.lastAttemptAt >= PUSH_REREGISTER_AFTER_MS;
}

export interface PushService {
  getState(): PushState;
  subscribe(listener: () => void): () => void;
  register(): Promise<PushState>;
  /** Registers again when the last attempt is older than {@link PUSH_REREGISTER_AFTER_MS}. */
  refreshIfStale(): Promise<PushState> | null;
  /** Removes this phone's token from the server; gives up quietly after `timeoutMs`. */
  unregister(timeoutMs?: number): Promise<void>;
}

const UNREGISTER_TIMEOUT_MS = 3000;

export function createPushService(
  device: PushDevice,
  repository: NotificationsRepository,
  now: () => number = Date.now,
): PushService {
  let state: PushState = { status: 'idle' };
  let registering: Promise<PushState> | null = null;
  let lastAttemptAt: number | null = null;
  const listeners = new Set<() => void>();

  function set(next: PushState): PushState {
    state = next;
    listeners.forEach((listener) => listener());
    return next;
  }

  async function run(): Promise<PushState> {
    lastAttemptAt = now();
    const availability = device.availability();
    if (!availability.available) {
      return set({ status: 'unavailable', reason: availability.reason });
    }
    set({ status: 'pending' });
    try {
      if (!(await device.ensurePermission())) return set({ status: 'denied' });
      await device.prepare();
      const token = await device.getExpoPushToken(availability.projectId);
      const registered = await repository.registerPushToken({ token, platform: device.platform });
      return set(registered.ok ? { status: 'on', token } : { status: 'failed' });
    } catch {
      // Never log the token or the error detail: it may contain the token.
      return set({ status: 'failed' });
    }
  }

  function register(): Promise<PushState> {
    registering ??= run().finally(() => {
      registering = null;
    });
    return registering;
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register,
    refreshIfStale() {
      if (registering || !shouldReregisterPush({ state, lastAttemptAt, now: now() })) {
        return null;
      }
      return register();
    },
    async unregister(timeoutMs = UNREGISTER_TIMEOUT_MS) {
      const current = state;
      lastAttemptAt = null;
      set({ status: 'idle' });
      if (current.status !== 'on') return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        repository.unregisterPushToken(current.token).catch(() => undefined),
        new Promise((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
      clearTimeout(timer);
    },
  };
}
