import type { UploadFailure } from '@ops/shared';

import { classifyApiFailure, classifyLocalError, classifyUploadFailure } from './engineErrors';
import { httpFailure, NETWORK_DOWN, TIMED_OUT } from './engineTestKit';
import { createRetryPolicy } from './engineRetry';
import { createNetworkMonitor, isOnlineState } from './network';

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => undefined) },
}));

describe('classifyApiFailure', () => {
  it('retries a missing answer and stops the run there', () => {
    expect(classifyApiFailure(NETWORK_DOWN)).toMatchObject({
      disposition: 'retryable',
      connection: true,
      error: { code: 'network', status: null },
    });
    expect(classifyApiFailure(TIMED_OUT)).toMatchObject({
      disposition: 'retryable',
      connection: true,
      error: { code: 'timeout' },
    });
  });

  it('retries an unreadable answer (a proxy or captive portal page)', () => {
    expect(
      classifyApiFailure({ kind: 'invalid-response', status: 200, message: 'not JSON' }),
    ).toMatchObject({ disposition: 'retryable', error: { code: 'invalid_response', status: 200 } });
  });

  it.each([
    'rate_limited',
    'service_unavailable',
    'internal_error',
    'request_in_progress',
  ] as const)('retries %s', (code) => {
    expect(classifyApiFailure(httpFailure(code)).disposition).toBe('retryable');
  });

  it.each([
    'validation_failed',
    'forbidden',
    'not_found',
    'conflict',
    'unprocessable',
    'version_conflict',
    'edit_window_closed',
    'already_reviewed',
    'record_archived',
    'task_not_assigned',
    'task_cancelled',
    'occurred_at_out_of_range',
    'attachment_not_declared',
    'idempotency_key_reused',
  ] as const)('keeps %s as final', (code) => {
    expect(classifyApiFailure(httpFailure(code))).toMatchObject({
      disposition: 'permanent',
      error: { code },
    });
  });

  it('asks for a sign-in on a 401 the transport could not fix', () => {
    expect(classifyApiFailure(httpFailure('unauthenticated')).disposition).toBe('needsSignIn');
  });
});

describe('classifyUploadFailure', () => {
  const base: UploadFailure = {
    step: 'put',
    retryable: true,
    api: null,
    putStatus: 0,
    message: 'failed',
  };

  it('treats a PUT without an answer as a lost connection', () => {
    expect(classifyUploadFailure(base)).toMatchObject({
      disposition: 'retryable',
      connection: true,
      error: { code: 'network' },
    });
  });

  it('retries a storage 5xx and keeps a refused PUT', () => {
    expect(classifyUploadFailure({ ...base, putStatus: 503 }).disposition).toBe('retryable');
    expect(classifyUploadFailure({ ...base, putStatus: 413, retryable: false })).toMatchObject({
      disposition: 'permanent',
      error: { code: 'unprocessable', status: 413 },
    });
  });

  it('follows the helper when complete found no bytes (409 conflict, retryable)', () => {
    expect(
      classifyUploadFailure({ ...base, step: 'complete', api: httpFailure('conflict') })
        .disposition,
    ).toBe('retryable');
    expect(
      classifyUploadFailure({
        ...base,
        step: 'start',
        retryable: false,
        api: httpFailure('attachment_not_declared'),
      }).disposition,
    ).toBe('permanent');
  });

  it('keeps a local error retryable', () => {
    expect(classifyLocalError(new Error('disk I/O error'))).toMatchObject({
      disposition: 'retryable',
      error: { code: 'internal_error', message: 'disk I/O error' },
    });
  });
});

describe('createRetryPolicy', () => {
  const policy = createRetryPolicy();

  it('doubles from 2 s with full jitter', () => {
    expect(policy.delayMs(1, () => 1)).toBe(2000);
    expect(policy.delayMs(2, () => 1)).toBe(4000);
    expect(policy.delayMs(3, () => 0.5)).toBe(4000);
    expect(policy.delayMs(1, () => 0)).toBe(0);
  });

  it('caps at 15 minutes, also for very large attempt numbers', () => {
    expect(policy.delayMs(20, () => 1)).toBe(15 * 60 * 1000);
    expect(policy.delayMs(10_000, () => 1)).toBe(15 * 60 * 1000);
  });
});

describe('network monitor', () => {
  it('counts "unknown" as online', () => {
    expect(isOnlineState({ isConnected: null, isInternetReachable: null })).toBe(true);
    expect(isOnlineState({ isConnected: true, isInternetReachable: false })).toBe(false);
    expect(isOnlineState({ isConnected: false, isInternetReachable: null })).toBe(false);
  });

  it('reports changes only', () => {
    let emit: (state: never) => void = () => undefined;
    const monitor = createNetworkMonitor({
      addEventListener: (listener) => {
        emit = listener as (state: never) => void;
        return () => undefined;
      },
    });
    const seen: boolean[] = [];
    monitor.subscribe((online) => seen.push(online));

    emit({ isConnected: true, isInternetReachable: true } as never);
    emit({ isConnected: false, isInternetReachable: false } as never);
    emit({ isConnected: false, isInternetReachable: null } as never);
    emit({ isConnected: true, isInternetReachable: null } as never);

    expect(seen).toEqual([false, true]);
    expect(monitor.isOnline()).toBe(true);
  });
});
