import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHealthMonitor,
  HEALTH_RETRY_DELAYS_MS,
  INITIAL_HEALTH_STATE,
  isRetryable,
  type HealthResult,
} from './health-monitor.js';

const UP: HealthResult = {
  ok: true,
  status: 200,
  data: { status: 'ok', database: 'up', timestamp: '2026-01-01T00:00:00.000Z' },
};
const DB_DOWN: HealthResult = {
  ok: true,
  status: 503,
  data: { status: 'error', database: 'down', timestamp: '2026-01-01T00:00:00.000Z' },
};
const NETWORK: HealthResult = { ok: false, failure: { kind: 'network', message: 'fetch failed' } };
const TIMEOUT: HealthResult = { ok: false, failure: { kind: 'timeout', message: 'too slow' } };
const INVALID: HealthResult = {
  ok: false,
  failure: { kind: 'invalid-response', status: 404, message: 'Unexpected HTTP 404' },
};

/** A check that answers with the given results in order, repeating the last one. */
function checkReturning(...results: HealthResult[]) {
  let call = 0;
  return vi.fn(async () => results[Math.min(call++, results.length - 1)] as HealthResult);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('isRetryable', () => {
  it('retries only when nothing answered', () => {
    expect(isRetryable(NETWORK)).toBe(true);
    expect(isRetryable(TIMEOUT)).toBe(true);
    expect(isRetryable(INVALID)).toBe(false);
    expect(isRetryable(UP)).toBe(false);
    expect(isRetryable(DB_DOWN)).toBe(false);
  });
});

describe('createHealthMonitor', () => {
  it('spreads four retries over about 30 seconds', () => {
    expect(HEALTH_RETRY_DELAYS_MS).toHaveLength(4);
    expect(HEALTH_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(30_000);
    expect(Math.min(...HEALTH_RETRY_DELAYS_MS)).toBeGreaterThanOrEqual(2000);
  });

  it('starts in the checking state and settles on a successful answer without retrying', async () => {
    const check = checkReturning(UP);
    const monitor = createHealthMonitor({ check });
    expect(monitor.getState()).toBe(INITIAL_HEALTH_STATE);

    monitor.check();
    await vi.runAllTimersAsync();

    expect(monitor.getState()).toEqual({
      checking: false,
      result: UP,
      retry: null,
      retriesExhausted: false,
    });
    expect(check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry when the API answers that its database is down', async () => {
    const check = checkReturning(DB_DOWN);
    const monitor = createHealthMonitor({ check });

    monitor.check();
    await vi.runAllTimersAsync();

    expect(monitor.getState().result).toBe(DB_DOWN);
    expect(monitor.getState().retry).toBeNull();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('does not retry an invalid response', async () => {
    const check = checkReturning(INVALID);
    const monitor = createHealthMonitor({ check });

    monitor.check();
    await vi.runAllTimersAsync();

    expect(monitor.getState()).toMatchObject({ result: INVALID, retry: null });
    expect(monitor.getState().retriesExhausted).toBe(false);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('recovers on its own when the API comes up after the first load failed', async () => {
    // The reported case: the page loads while the API is still starting.
    const check = checkReturning(NETWORK, NETWORK, UP);
    const monitor = createHealthMonitor({ check });

    monitor.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getState()).toEqual({
      checking: false,
      result: NETWORK,
      retry: { attempt: 1, of: 4 },
      retriesExhausted: false,
    });

    // Nothing happens before the first delay has passed: no tight polling.
    await vi.advanceTimersByTimeAsync(1999);
    expect(check).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(2);
    expect(monitor.getState().retry).toEqual({ attempt: 2, of: 4 });

    await vi.advanceTimersByTimeAsync(4000);
    expect(check).toHaveBeenCalledTimes(3);
    expect(monitor.getState()).toEqual({
      checking: false,
      result: UP,
      retry: null,
      retriesExhausted: false,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports that a retry is in flight while keeping the last failure visible', async () => {
    let release: (result: HealthResult) => void = () => {};
    const check = vi
      .fn<() => Promise<HealthResult>>()
      .mockResolvedValueOnce(TIMEOUT)
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const monitor = createHealthMonitor({ check });

    monitor.check();
    await vi.advanceTimersByTimeAsync(2000);

    expect(monitor.getState()).toEqual({
      checking: true,
      result: TIMEOUT,
      retry: { attempt: 1, of: 4 },
      retriesExhausted: false,
    });

    release(UP);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.getState().result).toBe(UP);
  });

  it('gives up after the last retry and says so', async () => {
    const check = checkReturning(NETWORK);
    const monitor = createHealthMonitor({ check });

    monitor.check();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(check).toHaveBeenCalledTimes(5);
    expect(monitor.getState()).toEqual({
      checking: false,
      result: NETWORK,
      retry: null,
      retriesExhausted: true,
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(check).toHaveBeenCalledTimes(5);
  });

  it('a manual check recovers once the API is up, and restarts the retry count', async () => {
    const check = checkReturning(NETWORK, NETWORK, NETWORK, NETWORK, NETWORK, UP);
    const monitor = createHealthMonitor({ check });
    monitor.check();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(monitor.getState().retriesExhausted).toBe(true);

    monitor.check();
    expect(monitor.getState()).toBe(INITIAL_HEALTH_STATE);
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getState()).toMatchObject({ result: UP, retry: null, retriesExhausted: false });
  });

  it('a manual check while a retry is waiting cancels that retry', async () => {
    const check = checkReturning(NETWORK, UP);
    const monitor = createHealthMonitor({ check });
    monitor.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    monitor.check();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(check).toHaveBeenCalledTimes(2);
    expect(monitor.getState().result).toBe(UP);
  });

  it('stops retrying and ignores a late answer after stop()', async () => {
    let release: (result: HealthResult) => void = () => {};
    const check = vi
      .fn<() => Promise<HealthResult>>()
      .mockResolvedValueOnce(NETWORK)
      .mockImplementation(() => new Promise((resolve) => (release = resolve)));
    const monitor = createHealthMonitor({ check });
    const listener = vi.fn();
    monitor.subscribe(listener);

    monitor.check();
    await vi.advanceTimersByTimeAsync(0);
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(check).toHaveBeenCalledTimes(1);

    // An answer that arrives after stop() must not reach the (unmounted) component.
    monitor.check();
    monitor.stop();
    listener.mockClear();
    release(UP);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(listener).not.toHaveBeenCalled();
    expect(monitor.getState().result).toBeNull();
  });

  it('can be started again after stop(), as React strict mode does', async () => {
    const check = checkReturning(UP);
    const monitor = createHealthMonitor({ check });

    monitor.check();
    monitor.stop();
    monitor.check();
    await vi.advanceTimersByTimeAsync(0);

    expect(monitor.getState().result).toBe(UP);
  });

  it('notifies subscribers of every change until they unsubscribe', async () => {
    const monitor = createHealthMonitor({ check: checkReturning(UP) });
    const listener = vi.fn();
    const unsubscribe = monitor.subscribe(listener);

    monitor.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    monitor.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('never retries when given no delays', async () => {
    const check = checkReturning(NETWORK);
    const monitor = createHealthMonitor({ check, retryDelaysMs: [] });

    monitor.check();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(check).toHaveBeenCalledTimes(1);
    expect(monitor.getState()).toMatchObject({ retry: null, retriesExhausted: false });
  });
});
