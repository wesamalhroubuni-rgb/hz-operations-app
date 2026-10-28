import { ApiException } from '../../platform/http';
import { contextFor, orgWideContextFor } from '../access/testing';
import { assertExpectedVersion } from '../common/concurrency';
import { changedSince, decodeSyncCursor, encodeSyncCursor, scopeFingerprint } from './sync-cursor';

const NOW = new Date('2026-10-27T12:00:00Z');

describe('sync cursor', () => {
  const worker = contextFor('worker', ['worker'], { siteIds: ['a', 'b'] });

  it('round-trips the time for the same scope', () => {
    const fingerprint = scopeFingerprint(worker);
    const cursor = encodeSyncCursor(NOW, fingerprint);
    expect(cursor.length).toBeLessThanOrEqual(512);
    expect(decodeSyncCursor(cursor, fingerprint, NOW)).toEqual(NOW);
  });

  it('does not depend on the order of the scope ids', () => {
    expect(scopeFingerprint(contextFor('worker', ['worker'], { siteIds: ['b', 'a'] }))).toBe(
      scopeFingerprint(worker),
    );
  });

  it('changes with the scope, the roles and the user', () => {
    const base = scopeFingerprint(worker);
    expect(scopeFingerprint(contextFor('worker', ['worker'], { siteIds: ['a'] }))).not.toBe(base);
    expect(
      scopeFingerprint(contextFor('worker', ['worker', 'supervisor'], { siteIds: ['a', 'b'] })),
    ).not.toBe(base);
    expect(scopeFingerprint(contextFor('other', ['worker'], { siteIds: ['a', 'b'] }))).not.toBe(
      base,
    );
    expect(scopeFingerprint(orgWideContextFor('worker', 'manager'))).not.toBe(base);
  });

  it('gives null (a full pull) for anything unusable, never an error', () => {
    const fingerprint = scopeFingerprint(worker);
    const other = encodeSyncCursor(NOW, 'another-scope');
    const future = encodeSyncCursor(new Date(NOW.getTime() + 60_000), fingerprint);
    const v2 = Buffer.from(JSON.stringify({ v: 2, t: NOW.toISOString(), s: fingerprint })).toString(
      'base64url',
    );
    for (const cursor of [undefined, '', 'garbage!!', 'e30', other, future, v2, 'x'.repeat(600)]) {
      expect(decodeSyncCursor(cursor, fingerprint, NOW)).toBeNull();
    }
  });

  it('starts a delta one overlap before the cursor', () => {
    expect(changedSince(NOW).toISOString()).toBe('2026-10-27T11:59:00.000Z');
  });
});

describe('expected version', () => {
  it('passes when absent or equal, and answers version_conflict otherwise', () => {
    expect(() => assertExpectedVersion('Task', 't', 3, undefined)).not.toThrow();
    expect(() => assertExpectedVersion('Task', 't', 3, 3)).not.toThrow();
    try {
      assertExpectedVersion('Task', 't', 3, 2);
      throw new Error('expected a conflict');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException);
      expect(error).toMatchObject({ code: 'version_conflict', status: 409 });
    }
  });
});
