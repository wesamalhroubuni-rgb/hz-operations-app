import { auditMetadataOf } from '../audit/audit.service';
import { offlineSyncOf } from '../request-context/request-context.middleware';
import {
  canonicalJson,
  classifyRepeat,
  idempotencyRequestHash,
  isFinalAnswer,
  isValidIdempotencyKey,
  requestPathOf,
  type IdempotencyClaimState,
} from './idempotency';

const NOW = new Date('2026-10-27T12:00:00Z');
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe('idempotency keys', () => {
  it('accepts UUIDs only', () => {
    expect(isValidIdempotencyKey('0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(isValidIdempotencyKey('not-a-uuid')).toBe(false);
    expect(isValidIdempotencyKey(['0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'])).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });
});

describe('request hash', () => {
  it('ignores key order and whitespace of the body', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}',
    );
    expect(
      idempotencyRequestHash('PATCH', '/tasks/1/status', { status: 'done', reason: 'x' }),
    ).toBe(idempotencyRequestHash('patch', '/tasks/1/status', { reason: 'x', status: 'done' }));
  });

  it('changes with the method, the path or any value', () => {
    const base = idempotencyRequestHash('PATCH', '/work-logs/1', { text: 'a' });
    expect(idempotencyRequestHash('POST', '/work-logs/1', { text: 'a' })).not.toBe(base);
    expect(idempotencyRequestHash('PATCH', '/work-logs/2', { text: 'a' })).not.toBe(base);
    expect(idempotencyRequestHash('PATCH', '/work-logs/1', { text: 'b' })).not.toBe(base);
  });

  it('drops undefined members and treats a missing body as null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(idempotencyRequestHash('POST', '/x', undefined)).toBe(
      idempotencyRequestHash('POST', '/x', null),
    );
  });

  it('hashes the path without the query string', () => {
    expect(requestPathOf('/work-logs/1?x=1#y')).toBe('/work-logs/1');
    expect(requestPathOf(undefined)).toBe('/');
  });
});

describe('a repeat of a key', () => {
  const state = (overrides: Partial<IdempotencyClaimState> = {}): IdempotencyClaimState => ({
    requestHash: 'h',
    statusCode: null,
    lockedUntil: later(60),
    expiresAt: later(14 * 86_400),
    ...overrides,
  });

  it('replays a finished request with the same hash', () => {
    expect(classifyRepeat(state({ statusCode: 200 }), 'h', NOW)).toBe('replay');
    expect(classifyRepeat(state({ statusCode: 409 }), 'h', NOW)).toBe('replay');
  });

  it('is a key reuse with another hash, finished or not', () => {
    expect(classifyRepeat(state({ statusCode: 200 }), 'other', NOW)).toBe('reused');
    expect(classifyRepeat(state(), 'other', NOW)).toBe('reused');
  });

  it('is in progress while the lock holds, and taken over after it', () => {
    expect(classifyRepeat(state(), 'h', NOW)).toBe('in_progress');
    expect(classifyRepeat(state({ lockedUntil: later(-1) }), 'h', NOW)).toBe('take_over');
  });

  it('is a new key once the stored one expired', () => {
    expect(classifyRepeat(state({ statusCode: 200, expiresAt: later(-1) }), 'other', NOW)).toBe(
      'expired',
    );
  });
});

describe('final answers', () => {
  it('stores 2xx, 400, 403, 404, 409, 422', () => {
    for (const status of [200, 201, 400, 403, 404, 409, 422]) {
      expect(isFinalAnswer(status)).toBe(true);
    }
  });

  it('does not store 401, 408, 429, 5xx or request_in_progress', () => {
    for (const status of [401, 408, 429, 500, 503]) {
      expect(isFinalAnswer(status)).toBe(false);
    }
    expect(isFinalAnswer(409, 'request_in_progress')).toBe(false);
    expect(isFinalAnswer(409, 'version_conflict')).toBe(true);
  });
});

describe('offline-sync request facts', () => {
  it('reads the flag, the device time and the skew', () => {
    const info = offlineSyncOf(
      { 'x-client-sync': 'offline', 'x-device-time': '2026-10-27T12:10:00.000Z' },
      NOW,
    );
    expect(info).toEqual({
      deviceTime: '2026-10-27T12:10:00.000Z',
      serverTime: NOW,
      clockSkewSeconds: 600,
    });
  });

  it('is null without the flag, and keeps a null time for a bad device time', () => {
    expect(offlineSyncOf({ 'x-device-time': '2026-10-27T12:10:00.000Z' }, NOW)).toBeNull();
    expect(offlineSyncOf({ 'x-client-sync': 'online' }, NOW)).toBeNull();
    expect(
      offlineSyncOf({ 'x-client-sync': 'offline', 'x-device-time': 'yesterday' }, NOW),
    ).toEqual({ deviceTime: null, serverTime: NOW, clockSkewSeconds: null });
  });

  it('builds the audit metadata only for offline requests or explicit facts', () => {
    expect(auditMetadataOf(null, undefined)).toBeNull();
    expect(auditMetadataOf(null, {})).toBeNull();
    expect(auditMetadataOf(null, { droppedReferences: ['taskId'] })).toEqual({
      droppedReferences: ['taskId'],
    });
    expect(
      auditMetadataOf(
        { deviceTime: null, serverTime: NOW, clockSkewSeconds: null },
        {
          droppedReferences: ['siteId'],
        },
      ),
    ).toEqual({
      via: 'offline_sync',
      deviceTime: null,
      serverTime: NOW.toISOString(),
      clockSkewSeconds: null,
      droppedReferences: ['siteId'],
    });
  });
});
